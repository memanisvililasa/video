import "server-only";
import type { JobLeaseRef } from "@/lib/jobs/job-lease-queue";
import type { MediaJobOutputMetadata } from "@/lib/jobs/types";
import type {
  FinalPublicationCoordinator,
  MediaArtifactRecord,
  MediaArtifactRepository,
  PublishReadyResult,
  ReserveMediaArtifactResult
} from "@/lib/storage/media-artifact-repository";
import {
  createMediaArtifactId,
  type MediaAttemptWorkspace,
  type MediaObjectStorage
} from "@/lib/storage/media-storage";

export type DurableJobArtifactLifecycle = Readonly<{
  workspace: MediaAttemptWorkspace;
  currentLease: () => JobLeaseRef;
  registerSource: (metadata: Readonly<{ filename: string; contentType: string }>) => Promise<ReserveMediaArtifactResult>;
  registerPartial: (metadata: Readonly<{ filename: string; contentType: string }>) => Promise<ReserveMediaArtifactResult>;
  stageFinal: (metadata: Readonly<{ filename: string; contentType: string }>) => Promise<ReserveMediaArtifactResult>;
  publishReady: (media: MediaJobOutputMetadata) => Promise<PublishReadyResult>;
  cleanupAttempt: () => Promise<void>;
}>;

export type CreateDurableJobArtifactLifecycleOptions = Readonly<{
  lease: JobLeaseRef;
  sourceExtension: string;
  outputExtension: string;
  maxJobBytes: number;
  maxOutputBytes: number;
  finalTtlSeconds: number;
  storage: MediaObjectStorage;
  artifacts: MediaArtifactRepository;
  publication: FinalPublicationCoordinator;
}>;

export async function createDurableJobArtifactLifecycle(
  options: CreateDurableJobArtifactLifecycleOptions
): Promise<DurableJobArtifactLifecycle> {
  await options.storage.initialize();
  const workspace = await options.storage.createAttemptWorkspace({
    jobId: options.lease.jobId,
    attemptId: options.lease.attemptId,
    sourceExtension: options.sourceExtension,
    outputExtension: options.outputExtension
  });
  let lease = options.lease;
  let source: MediaArtifactRecord | null = null;
  let partial: MediaArtifactRecord | null = null;
  let final: MediaArtifactRecord | null = null;
  const artifactIds = Object.freeze({
    source: createMediaArtifactId("source"),
    partial: createMediaArtifactId("partial"),
    final: createMediaArtifactId("final")
  });

  async function reserve(
    kind: "source" | "partial" | "final",
    metadata: Readonly<{ filename: string; contentType: string }>
  ): Promise<ReserveMediaArtifactResult> {
    const target = kind === "source" ? workspace.source : kind === "partial" ? workspace.partial : workspace.stagedFinal;
    const object = await options.storage.inspect(
      target.key,
      kind === "source" ? options.maxJobBytes : options.maxOutputBytes
    );
    const artifactId = artifactIds[kind];
    const result = await options.artifacts.reserveOwned(lease, {
      artifactId,
      kind,
      object,
      filename: metadata.filename,
      contentType: metadata.contentType,
      ttlSeconds: options.finalTtlSeconds
    });
    if (result.outcome === "reserved" || result.outcome === "already-reserved") {
      lease = result.lease;
      if (kind === "source") source = result.artifact;
      else if (kind === "partial") partial = result.artifact;
      else final = result.artifact;
    }
    return result;
  }

  async function publishReady(media: MediaJobOutputMetadata): Promise<PublishReadyResult> {
    if (!final) return Object.freeze({ outcome: "invalid-state", record: null });
    if (!(await options.artifacts.isOwnedLeaseActive(lease))) {
      return Object.freeze({ outcome: "ownership-lost" });
    }
    const extension = options.outputExtension;
    const publishedObject = await options.storage.publishImmutable({
      stagedKey: workspace.stagedFinal.key,
      fileId: final.artifactId,
      extension,
      maximumBytes: options.maxOutputBytes
    });
    return options.publication.completeReadyOwned({
      lease,
      artifactId: final.artifactId,
      publishedObject,
      media
    });
  }

  async function cleanupAttempt(): Promise<void> {
    const records = await options.artifacts.listForJob(lease.jobId);
    for (const artifact of records) {
      if (
        artifact.attemptId !== lease.attemptId ||
        artifact.publicationState === "published" ||
        artifact.publishedAt !== null
      ) continue;
      try {
        await options.storage.remove(artifact.storageKey);
      } catch {
        continue;
      }
      await options.artifacts.delete(artifact.artifactId, artifact.version);
    }
    await options.storage.removeAttemptWorkspace(lease.jobId, lease.attemptId).catch(() => false);
  }

  return Object.freeze({
    workspace,
    currentLease: () => lease,
    registerSource: (metadata) => reserve("source", metadata),
    registerPartial: (metadata) => reserve("partial", metadata),
    stageFinal: (metadata) => reserve("final", metadata),
    publishReady,
    cleanupAttempt
  });
}
