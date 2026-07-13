import "server-only";
import type { MediaJobLifecycleMaintenance } from "@/lib/jobs/lifecycle-maintenance";
import type { MediaArtifactRepository } from "@/lib/storage/media-artifact-repository";
import type { MediaObjectStorage, MediaStorageInventory } from "@/lib/storage/media-storage";

export type MediaReconciliationReport = Readonly<{
  inspectedArtifacts: number;
  missingArtifacts: number;
  removedArtifacts: number;
  removedOrphanObjects: number;
  removedAttemptWorkspaces: number;
  protectedActiveAttempts: number;
}>;

export interface MediaStorageReconciler {
  reconcile(): Promise<MediaReconciliationReport>;
  cleanupJobArtifacts(jobId: string): Promise<number>;
}

export function createMediaStorageReconciler(options: Readonly<{
  artifacts: MediaArtifactRepository;
  storage: MediaObjectStorage;
  inventory: MediaStorageInventory;
  batchSize: number;
  orphanGraceMs?: number;
  lifecycle?: Pick<
    MediaJobLifecycleMaintenance,
    "expireReadyJobForMissingArtifact" | "failJobForDanglingPublishedArtifact"
  >;
  now?: () => number;
}>): MediaStorageReconciler {
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1_000) {
    throw new TypeError("Media reconciliation batch size is invalid.");
  }
  const graceMs = options.orphanGraceMs ?? 60_000;
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 86_400_000) {
    throw new TypeError("Media reconciliation grace period is invalid.");
  }
  const now = options.now ?? Date.now;

  async function cleanupJobArtifacts(jobId: string): Promise<number> {
    const records = await options.artifacts.listForJob(jobId);
    let removed = 0;
    const attempts = new Set<string>();
    for (const artifact of records) {
      attempts.add(artifact.attemptId);
      if (artifact.publicationState === "published" || artifact.publishedAt !== null) continue;
      if (await options.artifacts.isAttemptActive(artifact.jobId, artifact.attemptId)) continue;
      try {
        await options.storage.remove(artifact.storageKey);
      } catch {
        continue;
      }
      const result = await options.artifacts.delete(artifact.artifactId, artifact.version);
      if (result.outcome === "updated" || result.outcome === "not-found") removed += 1;
    }
    for (const attemptId of attempts) {
      if (!(await options.artifacts.isAttemptActive(jobId, attemptId))) {
        await options.storage.removeAttemptWorkspace(jobId, attemptId).catch(() => false);
      }
    }
    return removed;
  }

  async function reconcile(): Promise<MediaReconciliationReport> {
    const cutoff = now() - graceMs;
    if (!Number.isFinite(cutoff)) throw new TypeError("Media reconciliation clock is invalid.");
    let inspectedArtifacts = 0;
    let missingArtifacts = 0;
    let removedArtifacts = 0;
    let removedOrphanObjects = 0;
    let removedAttemptWorkspaces = 0;
    let protectedActiveAttempts = 0;

    for (const artifact of await options.artifacts.listExpiredPublished(options.batchSize)) {
      inspectedArtifacts += 1;
      try {
        await options.storage.remove(artifact.storageKey);
      } catch {
        continue;
      }
      const removed = await options.artifacts.delete(artifact.artifactId, artifact.version);
      if (removed.outcome === "updated" || removed.outcome === "not-found") removedArtifacts += 1;
    }

    for (const artifact of await options.artifacts.listReconciliationCandidates(options.batchSize)) {
      inspectedArtifacts += 1;
      if (artifact.publicationState === "published" && Date.parse(artifact.expiresAt) <= now()) continue;
      const active = await options.artifacts.isAttemptActive(artifact.jobId, artifact.attemptId);
      // An unavailable volume is not evidence that an object disappeared.
      // Propagate the outage so global destructive reconciliation stops.
      const physical = await options.storage.stat(artifact.storageKey);
      if (!physical && artifact.publicationState !== "missing") {
        if (active) {
          protectedActiveAttempts += 1;
          continue;
        }
        const coordinated = artifact.publicationState === "published"
          ? await options.lifecycle?.expireReadyJobForMissingArtifact(artifact.artifactId, artifact.version)
          : false;
        if (coordinated) {
          missingArtifacts += 1;
        } else {
          const marked = await options.artifacts.markMissing(artifact.artifactId, artifact.version);
          if (marked.outcome === "updated" || marked.outcome === "unchanged") missingArtifacts += 1;
        }
        continue;
      }
      if (
        artifact.publicationState !== "published" &&
        artifact.publishedAt === null &&
        !active &&
        (graceMs === 0 || Date.parse(artifact.updatedAt) <= cutoff)
      ) {
        if (physical) {
          try {
            await options.storage.remove(artifact.storageKey);
          } catch {
            continue;
          }
        }
        const removed = await options.artifacts.delete(artifact.artifactId, artifact.version);
        if (removed.outcome === "updated" || removed.outcome === "not-found") removedArtifacts += 1;
      } else if (active && artifact.publicationState !== "published") {
        protectedActiveAttempts += 1;
      } else if (physical && artifact.publicationState === "published" && !active) {
        await options.lifecycle?.failJobForDanglingPublishedArtifact(
          artifact.artifactId,
          artifact.version
        );
      }
    }

    const physicalPublished = await options.inventory.listPublished(options.batchSize);
    const registered = await options.artifacts.findByStorageKeys(physicalPublished.map((object) => object.key));
    const registeredKeys = new Set(registered.map((artifact) => artifact.storageKey));
    for (const object of physicalPublished) {
      if (registeredKeys.has(object.key) || (graceMs > 0 && Date.parse(object.modifiedAt) > cutoff)) continue;
      if (await options.storage.remove(object.key).catch(() => false)) removedOrphanObjects += 1;
    }

    for (const attempt of await options.inventory.listAttempts(options.batchSize)) {
      if (await options.artifacts.isAttemptActive(attempt.jobId, attempt.attemptId)) {
        protectedActiveAttempts += 1;
        continue;
      }
      if (graceMs > 0 && Date.parse(attempt.modifiedAt) > cutoff) continue;
      await cleanupJobArtifacts(attempt.jobId);
      if (await options.storage.removeAttemptWorkspace(attempt.jobId, attempt.attemptId).catch(() => false)) {
        removedAttemptWorkspaces += 1;
      }
    }

    return Object.freeze({
      inspectedArtifacts,
      missingArtifacts,
      removedArtifacts,
      removedOrphanObjects,
      removedAttemptWorkspaces,
      protectedActiveAttempts
    });
  }

  return Object.freeze({ reconcile, cleanupJobArtifacts });
}
