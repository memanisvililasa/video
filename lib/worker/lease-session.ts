import "server-only";
import type {
  ClaimedMediaJob,
  JobLeaseQueue,
  JobLeaseRef,
  OwnedJobUpdateResult
} from "@/lib/jobs/job-lease-queue";
import type { MediaJobSourceMetadataInput } from "@/lib/jobs/job-record";
import type { MediaJobOutputMetadata } from "@/lib/jobs/types";
import type {
  FinalPublicationCoordinator,
  MediaArtifactRepository,
  PublishReadyResult,
  ReserveMediaArtifactInput,
  ReserveMediaArtifactResult
} from "@/lib/storage/media-artifact-repository";
import type { PublishedMediaObject } from "@/lib/storage/media-storage";
import type { ApiErrorCode } from "@/lib/types";

export type WorkerAttemptAbortReason =
  | "cancellation"
  | "ownership-lost"
  | "db-transport"
  | "infrastructure-unavailable"
  | "shutdown"
  | "attempt-timeout"
  | "terminal-state";

export class WorkerAttemptControlError extends Error {
  constructor(public readonly reason: WorkerAttemptAbortReason) {
    super("Worker attempt stopped.");
    this.name = "WorkerAttemptControlError";
  }
}

export class WorkerDatabaseTransportError extends Error {
  constructor() {
    super("Worker persistence is temporarily unavailable.");
    this.name = "WorkerDatabaseTransportError";
  }
}

export type OwnedJobLeaseSession = Readonly<{
  job: ClaimedMediaJob;
  signal: AbortSignal;
  currentLease(): JobLeaseRef;
  abortReason(): WorkerAttemptAbortReason | null;
  abort(reason: WorkerAttemptAbortReason): void;
  assertActive(): void;
  renew(): Promise<void>;
  observe(): Promise<void>;
  confirmDatabaseUnavailable(): void;
  updateProgress(progress: number): Promise<void>;
  setSourceMetadata(metadata: MediaJobSourceMetadataInput): Promise<void>;
  reserveArtifact(input: ReserveMediaArtifactInput): Promise<ReserveMediaArtifactResult>;
  verifyOwnership(): Promise<void>;
  completeReady(input: Readonly<{
    artifactId: string;
    publishedObject: PublishedMediaObject;
    media: MediaJobOutputMetadata;
  }>): Promise<PublishReadyResult>;
  completeFailed(errorCode: ApiErrorCode): Promise<boolean>;
  waitForMutations(): Promise<void>;
  terminal(): boolean;
}>;

export type CreateOwnedJobLeaseSessionOptions = Readonly<{
  job: ClaimedMediaJob;
  queue: JobLeaseQueue;
  artifacts: MediaArtifactRepository;
  publication: FinalPublicationCoordinator;
}>;

export function createOwnedJobLeaseSession(
  options: CreateOwnedJobLeaseSessionOptions
): OwnedJobLeaseSession {
  const controller = new AbortController();
  let lease = options.job.lease;
  let reason: WorkerAttemptAbortReason | null = null;
  let isTerminal = false;
  let mutationTail: Promise<void> = Promise.resolve();

  function abort(nextReason: WorkerAttemptAbortReason): void {
    if (reason === null) reason = nextReason;
    if (!controller.signal.aborted) controller.abort();
  }

  function assertActive(): void {
    if (isTerminal || controller.signal.aborted) {
      throw new WorkerAttemptControlError(reason ?? "terminal-state");
    }
  }

  function controlFailure(result: Exclude<OwnedJobUpdateResult, { outcome: "updated" }>): never {
    if (result.outcome === "cancelled") abort("cancellation");
    else if (result.outcome === "ownership-lost") abort("ownership-lost");
    else abort("terminal-state");
    throw new WorkerAttemptControlError(reason ?? "terminal-state");
  }

  function serialize<T>(operation: () => Promise<T>, allowAborted = false): Promise<T> {
    const run = mutationTail.then(async () => {
      if (isTerminal) throw new WorkerAttemptControlError("terminal-state");
      if (!allowAborted) assertActive();
      try {
        return await operation();
      } catch (error) {
        if (error instanceof WorkerAttemptControlError || error instanceof WorkerDatabaseTransportError) {
          throw error;
        }
        throw new WorkerDatabaseTransportError();
      }
    });
    mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function applyUpdate(
    operation: (current: JobLeaseRef) => Promise<OwnedJobUpdateResult>
  ): Promise<void> {
    await serialize(async () => {
      const result = await operation(lease);
      if (result.outcome !== "updated") controlFailure(result);
      lease = result.lease;
    });
  }

  async function observe(): Promise<void> {
    await serialize(async () => {
      const result = await options.queue.observeOwnedState(lease);
      if (result.outcome === "active") return;
      if (result.outcome === "cancelled") abort("cancellation");
      else if (result.outcome === "ownership-lost" || result.outcome === "not-found") abort("ownership-lost");
      else abort("terminal-state");
      throw new WorkerAttemptControlError(reason ?? "terminal-state");
    });
  }

  async function reserveArtifact(
    input: ReserveMediaArtifactInput
  ): Promise<ReserveMediaArtifactResult> {
    return serialize(async () => {
      const result = await options.artifacts.reserveOwned(lease, input);
      if (result.outcome === "reserved" || result.outcome === "already-reserved") {
        lease = result.lease;
        return result;
      }
      if (result.outcome === "ownership-lost") abort("ownership-lost");
      else abort(
        result.outcome === "invalid-state" && result.record?.status === "cancelled"
          ? "cancellation"
          : "terminal-state"
      );
      throw new WorkerAttemptControlError(reason ?? "terminal-state");
    });
  }

  async function verifyOwnership(): Promise<void> {
    await serialize(async () => {
      if (!(await options.artifacts.isOwnedLeaseActive(lease))) {
        abort("ownership-lost");
        throw new WorkerAttemptControlError("ownership-lost");
      }
    });
  }

  async function completeReady(input: Readonly<{
    artifactId: string;
    publishedObject: PublishedMediaObject;
    media: MediaJobOutputMetadata;
  }>): Promise<PublishReadyResult> {
    return serialize(async () => {
      const result = await options.publication.completeReadyOwned({ lease, ...input });
      if (result.outcome === "completed" || result.outcome === "already-completed") {
        isTerminal = true;
        return result;
      }
      if (result.outcome === "ownership-lost") abort("ownership-lost");
      else abort(
        result.outcome === "invalid-state" && result.record?.status === "cancelled"
          ? "cancellation"
          : "terminal-state"
      );
      throw new WorkerAttemptControlError(reason ?? "terminal-state");
    });
  }

  async function completeFailed(errorCode: ApiErrorCode): Promise<boolean> {
    if (isTerminal || (reason !== null && reason !== "attempt-timeout")) return false;
    return serialize(async () => {
      const result = await options.queue.completeOwned(lease, { type: "failed", errorCode });
      if (result.outcome === "completed" || result.outcome === "already-completed") {
        isTerminal = true;
        return true;
      }
      if (result.outcome === "ownership-lost") abort("ownership-lost");
      else if (result.outcome === "invalid-state" && result.record?.status === "cancelled") abort("cancellation");
      else abort("terminal-state");
      return false;
    }, reason === "attempt-timeout");
  }

  return Object.freeze({
    job: options.job,
    signal: controller.signal,
    currentLease: () => lease,
    abortReason: () => reason,
    abort,
    assertActive,
    renew: () => applyUpdate((current) => options.queue.renewLease(current)),
    observe,
    confirmDatabaseUnavailable: () => abort("db-transport"),
    updateProgress: (progress) => applyUpdate((current) => options.queue.updateProgressOwned(current, progress)),
    setSourceMetadata: (metadata) => applyUpdate((current) => options.queue.setSourceMetadataOwned(current, metadata)),
    reserveArtifact,
    verifyOwnership,
    completeReady,
    completeFailed,
    waitForMutations: () => mutationTail,
    terminal: () => isTerminal
  });
}
