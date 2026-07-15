import "server-only";
import {
  createJobWorkerId,
  type ClaimedMediaJob,
  type JobLeaseQueue
} from "@/lib/jobs/job-lease-queue";
import type {
  FinalPublicationCoordinator,
  MediaArtifactRepository
} from "@/lib/storage/media-artifact-repository";
import { API_ERROR_CODES } from "@/lib/types";
import { classifyWorkerError } from "@/lib/worker/errors";
import {
  createOwnedJobLeaseSession,
  WorkerDatabaseTransportError,
  type OwnedJobLeaseSession
} from "@/lib/worker/lease-session";
import type { WorkerLogger } from "@/lib/worker/logger";
import type { MediaWorkerProcessor } from "@/lib/worker/processor";
import { createWorkerProgressReporter } from "@/lib/worker/progress";
import type { OperationalSignals } from "@/lib/observability/signals";
import { jobErrorCategory, safeSignalMetric } from "@/lib/observability/signals";

const MAX_IDLE_BACKOFF_MS = 5_000;

export type MediaWorkerRuntimeStatus = Readonly<{
  running: boolean;
  stopping: boolean;
  activeJobs: number;
  configuredConcurrency: number;
  lastLoopActivityAt: string | null;
  lastSuccessfulRenewalAt: string | null;
  databaseHealthy: boolean;
}>;

export type MediaWorkerRuntime = Readonly<{
  run(): Promise<void>;
  shutdown(options?: Readonly<{ force?: boolean }>): Promise<void>;
  status(): MediaWorkerRuntimeStatus;
}>;

export type CreateMediaWorkerRuntimeOptions = Readonly<{
  queue: JobLeaseQueue;
  artifacts: MediaArtifactRepository;
  publication: FinalPublicationCoordinator;
  processor: MediaWorkerProcessor;
  logger: WorkerLogger;
  concurrency: number;
  workerIdPrefix: string;
  pollIntervalMs: number;
  progressIntervalMs: number;
  renewalIntervalMs: number;
  leaseDurationMs: number;
  cancellationPollIntervalMs: number;
  dbLossGraceMs: number;
  attemptTimeoutMs: number;
  shutdownGraceMs: number;
  canClaim?: () => boolean;
  reportDatabaseHealth?: (healthy: boolean) => void;
  onUnsafeInfrastructure?: (listener: () => void) => () => void;
  random?: () => number;
  now?: () => number;
  signals?: OperationalSignals;
}>;

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function createMediaWorkerRuntime(
  options: CreateMediaWorkerRuntimeOptions
): MediaWorkerRuntime {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) {
    throw new TypeError("Worker concurrency is invalid.");
  }
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const wakeController = new AbortController();
  const activeSessions = new Set<OwnedJobLeaseSession>();
  let running = false;
  let stopping = false;
  let forced = false;
  let runPromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let lastLoopActivityAt: string | null = null;
  let lastSuccessfulRenewalAt: string | null = null;
  let databaseHealthy = true;
  const removeUnsafeListener = options.onUnsafeInfrastructure?.(() => {
    for (const session of activeSessions) session.abort("infrastructure-unavailable");
  });
  safeSignalMetric(() => options.signals?.metrics.setWorkerCapacity(options.concurrency, 0));

  function timestamp(): string {
    return new Date(now()).toISOString();
  }

  function failureStage(category: ReturnType<typeof jobErrorCategory>): "download" | "probe" | "transcode" | "publication" | "completion" {
    if (category === "download" || category === "probe" || category === "transcode" || category === "publication") return category;
    return "completion";
  }

  function startHeartbeat(session: OwnedJobLeaseSession): () => Promise<void> {
    let stopped = false;
    let renewalTimer: ReturnType<typeof setTimeout> | null = null;
    let observationTimer: ReturnType<typeof setTimeout> | null = null;
    let dbLossTimer: ReturnType<typeof setTimeout> | null = null;
    const pending = new Set<Promise<void>>();
    let dbFailureStartedAt: number | null = null;
    let lastOwnershipConfirmationAt = performance.now();

    const success = (renewed: boolean): void => {
      dbFailureStartedAt = null;
      if (dbLossTimer) clearTimeout(dbLossTimer);
      dbLossTimer = null;
      lastOwnershipConfirmationAt = performance.now();
      databaseHealthy = true;
      options.reportDatabaseHealth?.(true);
      if (renewed) lastSuccessfulRenewalAt = timestamp();
    };
    const failure = (error: unknown): void => {
      if (!(error instanceof WorkerDatabaseTransportError)) return;
      databaseHealthy = false;
      options.reportDatabaseHealth?.(false);
      const current = performance.now();
      dbFailureStartedAt ??= current;
      if (!dbLossTimer) {
        dbLossTimer = setTimeout(() => session.confirmDatabaseUnavailable(), options.dbLossGraceMs);
      }
      const transportBudgetExceeded = current - dbFailureStartedAt >= options.dbLossGraceMs;
      const leaseSafetyMargin = Math.min(1_000, Math.max(1, Math.floor(options.leaseDurationMs / 10)));
      const leaseBudgetExceeded = current - lastOwnershipConfirmationAt >= Math.max(1, options.leaseDurationMs - leaseSafetyMargin);
      if (transportBudgetExceeded || leaseBudgetExceeded) session.confirmDatabaseUnavailable();
    };
    const run = (operation: () => Promise<void>, renewed: boolean, done: () => void): void => {
      const task = operation().then(() => success(renewed)).catch(failure).finally(() => {
        pending.delete(task);
        done();
      });
      pending.add(task);
    };
    const scheduleRenewal = (): void => {
      if (stopped || session.terminal() || session.signal.aborted) return;
      renewalTimer = setTimeout(() => {
        renewalTimer = null;
        run(() => session.renew(), true, scheduleRenewal);
      }, options.renewalIntervalMs);
    };
    const scheduleObservation = (): void => {
      if (stopped || session.terminal() || session.signal.aborted) return;
      observationTimer = setTimeout(() => {
        observationTimer = null;
        run(() => session.observe(), false, scheduleObservation);
      }, options.cancellationPollIntervalMs);
    };
    scheduleRenewal();
    scheduleObservation();
    return async () => {
      stopped = true;
      if (renewalTimer) clearTimeout(renewalTimer);
      if (observationTimer) clearTimeout(observationTimer);
      if (dbLossTimer) clearTimeout(dbLossTimer);
      renewalTimer = null;
      observationTimer = null;
      dbLossTimer = null;
      await Promise.allSettled([...pending]);
    };
  }

  async function processClaim(claimed: ClaimedMediaJob): Promise<void> {
    const attemptStartedAt = performance.now();
    const session = createOwnedJobLeaseSession({
      job: claimed,
      queue: options.queue,
      artifacts: options.artifacts,
      publication: options.publication
    });
    activeSessions.add(session);
    safeSignalMetric(() => options.signals?.metrics.setWorkerCapacity(options.concurrency, activeSessions.size));
    const stopHeartbeat = startHeartbeat(session);
    const progress = createWorkerProgressReporter({
      session,
      initialProgress: claimed.record.progress,
      intervalMs: options.progressIntervalMs
    });
    const attemptTimer = setTimeout(() => session.abort("attempt-timeout"), options.attemptTimeoutMs);
    try {
      await options.processor.process({ claimed, session, progress });
      const completedReady = session.terminal();
      if (!completedReady) {
        await session.completeFailed(API_ERROR_CODES.INTERNAL_ERROR);
      }
      if (completedReady) {
        const preset = options.signals?.preset(claimed.record.processingPreset) ?? "unknown";
        const duration = options.signals?.jobDurationSeconds(claimed.record, now()) ?? 0;
        options.signals?.emit("info", "job.completed", {
          outcome: "success",
          reasonCode: "none",
          publicJobId: claimed.record.jobId,
          attempt: claimed.record.retryCount + 1,
          preset,
          stage: "completion",
          durationMs: duration * 1_000
        });
        safeSignalMetric(() => options.signals?.metrics.jobCompleted(preset, duration));
      }
      options.logger.info("worker.job.completed", { jobId: claimed.record.jobId });
    } catch (error) {
      const disposition = classifyWorkerError(error, session.abortReason());
      if (disposition.type === "terminal") {
        const category = jobErrorCategory(disposition.code);
        safeSignalMetric(() => options.signals?.metrics.workerFailure(failureStage(category), category));
        const completed = await session.completeFailed(disposition.code).catch(() => false);
        options.logger.warn("worker.job.terminal", {
          jobId: claimed.record.jobId,
          code: disposition.code,
          completed
        });
      } else if (disposition.type === "retryable") {
        const category = jobErrorCategory(disposition.code);
        safeSignalMetric(() => options.signals?.metrics.workerFailure(failureStage(category), category));
        options.signals?.emit("warn", "job.failed", {
          outcome: "failure",
          reasonCode: "internal_error",
          errorCategory: category,
          publicJobId: claimed.record.jobId,
          attempt: claimed.record.retryCount + 1,
          preset: options.signals.preset(claimed.record.processingPreset),
          stage: "completion",
          durationMs: Math.max(0, performance.now() - attemptStartedAt)
        });
        options.logger.warn("worker.job.retryable", {
          jobId: claimed.record.jobId,
          code: disposition.code
        });
      } else {
        options.logger.info("worker.job.stopped", {
          jobId: claimed.record.jobId,
          reason: disposition.type
        });
      }
    } finally {
      clearTimeout(attemptTimer);
      await progress.stop();
      await stopHeartbeat();
      await session.waitForMutations();
      activeSessions.delete(session);
      safeSignalMetric(() => options.signals?.metrics.setWorkerCapacity(options.concurrency, activeSessions.size));
    }
  }

  async function slotLoop(workerId: string): Promise<void> {
    let emptyCount = 0;
    let claimFailures = 0;
    while (!stopping) {
      lastLoopActivityAt = timestamp();
      if (options.canClaim && !options.canClaim()) {
        await abortableDelay(options.pollIntervalMs, wakeController.signal);
        continue;
      }
      let claimed;
      try {
        claimed = await options.queue.claimNext(workerId);
        claimFailures = 0;
        databaseHealthy = true;
        options.reportDatabaseHealth?.(true);
      } catch {
        claimFailures += 1;
        databaseHealthy = false;
        options.reportDatabaseHealth?.(false);
        options.logger.warn("worker.claim.failed", { failures: claimFailures });
        await abortableDelay(Math.min(MAX_IDLE_BACKOFF_MS, options.pollIntervalMs * 2 ** Math.min(claimFailures, 5)), wakeController.signal);
        continue;
      }
      if (claimed.outcome === "empty") {
        emptyCount = Math.min(emptyCount + 1, 4);
        const base = Math.min(MAX_IDLE_BACKOFF_MS, options.pollIntervalMs * 2 ** (emptyCount - 1));
        const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
        await abortableDelay(Math.max(1, Math.round(base * jitter)), wakeController.signal);
        continue;
      }
      emptyCount = 0;
      await processClaim(claimed.job);
    }
  }

  async function run(): Promise<void> {
    if (runPromise) return runPromise;
    if (stopping) throw new TypeError("Worker runtime is stopping.");
    running = true;
    runPromise = (async () => {
      try {
        const workerIds = Array.from(
          { length: options.concurrency },
          () => createJobWorkerId(options.workerIdPrefix)
        );
        await Promise.all(workerIds.map(slotLoop));
      } finally {
        running = false;
      }
    })();
    return runPromise;
  }

  async function shutdown(shutdownOptions: Readonly<{ force?: boolean }> = {}): Promise<void> {
    if (shutdownOptions.force) {
      forced = true;
      for (const session of activeSessions) session.abort("shutdown");
    }
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    wakeController.abort();
    shutdownPromise = (async () => {
      if (!forced && activeSessions.size > 0) {
        let graceTimer: ReturnType<typeof setTimeout> | null = null;
        await Promise.race([
          runPromise?.catch(() => undefined) ?? Promise.resolve(),
          new Promise<void>((resolve) => {
            graceTimer = setTimeout(resolve, options.shutdownGraceMs);
          })
        ]);
        if (graceTimer) clearTimeout(graceTimer);
      }
      if (activeSessions.size > 0) {
        for (const session of activeSessions) session.abort("shutdown");
      }
      await runPromise?.catch(() => undefined);
      removeUnsafeListener?.();
    })();
    return shutdownPromise;
  }

  return Object.freeze({
    run,
    shutdown,
    status: (): MediaWorkerRuntimeStatus => Object.freeze({
      running,
      stopping,
      activeJobs: activeSessions.size,
      configuredConcurrency: options.concurrency,
      lastLoopActivityAt,
      lastSuccessfulRenewalAt,
      databaseHealthy
    })
  });
}
