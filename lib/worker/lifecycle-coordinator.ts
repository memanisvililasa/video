import "server-only";
import type { JobLeaseQueue } from "@/lib/jobs/job-lease-queue";
import type {
  MediaJobLifecycleMaintenance,
  MediaLifecycleElection,
  MediaLifecycleLeadership
} from "@/lib/jobs/lifecycle-maintenance";
import type { MediaStorageHealth } from "@/lib/storage/media-storage";
import type { MediaStorageReconciler } from "@/lib/storage/reconciliation";
import type { WorkerLogger } from "@/lib/worker/logger";
import type { OperationalSignals } from "@/lib/observability/signals";
import { safeSignalMetric } from "@/lib/observability/signals";

export type MediaLifecycleCoordinatorStatus = Readonly<{
  running: boolean;
  leader: boolean;
  readyForClaims: boolean;
  databaseHealthy: boolean;
  storageHealthy: boolean;
  lastSuccessfulRecoveryAt: string | null;
  lastSuccessfulReconciliationAt: string | null;
  lastSuccessfulExpirationAt: string | null;
  lastFailureAt: string | null;
}>;

export interface MediaLifecycleCoordinator {
  startup(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  canClaim(): boolean;
  reportDatabaseHealth(healthy: boolean): void;
  onUnsafeInfrastructure(listener: () => void): () => void;
  status(): MediaLifecycleCoordinatorStatus;
}

export type CreateMediaLifecycleCoordinatorOptions = Readonly<{
  enabled: boolean;
  election: MediaLifecycleElection;
  maintenance: MediaJobLifecycleMaintenance;
  queue: JobLeaseQueue;
  reconciler: MediaStorageReconciler;
  storageHealth: MediaStorageHealth;
  logger: WorkerLogger;
  recoveryIntervalMs: number;
  reconciliationIntervalMs: number;
  storageHealthIntervalMs: number;
  electionRetryIntervalMs: number;
  expirationBatchSize: number;
  expiredRetentionSeconds: number;
  random?: () => number;
  now?: () => number;
  signals?: OperationalSignals;
}>;

function bounded(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

export function createMediaLifecycleCoordinator(
  options: CreateMediaLifecycleCoordinatorOptions
): MediaLifecycleCoordinator {
  const recoveryIntervalMs = bounded("Lifecycle recovery interval", options.recoveryIntervalMs, 1_000, 3_600_000);
  const reconciliationIntervalMs = bounded("Lifecycle reconciliation interval", options.reconciliationIntervalMs, 1_000, 3_600_000);
  const storageHealthIntervalMs = bounded("Storage health interval", options.storageHealthIntervalMs, 1_000, 60_000);
  const electionRetryIntervalMs = bounded("Lifecycle election interval", options.electionRetryIntervalMs, 1_000, 60_000);
  const expirationBatchSize = bounded("Lifecycle expiration batch size", options.expirationBatchSize, 1, 1_000);
  const expiredRetentionSeconds = bounded("Expired job retention", options.expiredRetentionSeconds, 60, 604_800);
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  let leadership: MediaLifecycleLeadership | null = null;
  let running = false;
  let started = false;
  let startupPromise: Promise<void> | null = null;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Promise<void> | null = null;
  let databaseHealthy = true;
  let storageHealthy = false;
  let lastRecoveryMs = 0;
  let lastReconciliationMs = 0;
  let lastStorageHealthMs = 0;
  let lastSuccessfulRecoveryAt: string | null = null;
  let lastSuccessfulReconciliationAt: string | null = null;
  let lastSuccessfulExpirationAt: string | null = null;
  let lastFailureAt: string | null = null;

  function iso(): string {
    return new Date(now()).toISOString();
  }

  function notifyUnsafe(): void {
    for (const listener of listeners) {
      try { listener(); } catch { /* isolated infrastructure observer */ }
    }
  }

  function markDatabase(healthy: boolean): void {
    databaseHealthy = healthy;
    if (!healthy) lastFailureAt = iso();
    // New claims stop immediately, but each running attempt owns its bounded
    // DB-loss grace/lease budget. Do not bypass that budget with a global abort.
  }

  function markStorage(healthy: boolean): void {
    const wasHealthy = storageHealthy;
    storageHealthy = healthy;
    if (!healthy) lastFailureAt = iso();
    if (wasHealthy && !storageHealthy) notifyUnsafe();
  }

  async function releaseLeadership(reason: string, warning: boolean): Promise<void> {
    const owned = leadership;
    if (!owned) return;
    leadership = null;
    safeSignalMetric(() => options.signals?.metrics.setMaintenanceLeader(false));
    await owned.release().catch(() => undefined);
    options.signals?.emit(warning ? "warn" : "info", "lifecycle.leader_lost", {
      outcome: warning ? "failure" : "success",
      reasonCode: warning ? "maintenance_failed" : "none",
      errorCategory: warning ? "database" : undefined
    });
    const event = "worker.lifecycle.leadership-lost";
    if (warning) options.logger.warn(event, { reason });
    else options.logger.info(event, { reason });
  }

  async function verifyLeadership(): Promise<boolean> {
    if (!leadership) return false;
    if (await leadership.verify().catch(() => false)) return true;
    await releaseLeadership("verification", true);
    return false;
  }

  async function elect(): Promise<boolean> {
    if (await verifyLeadership()) return true;
    try {
      leadership = await options.election.tryAcquire();
      markDatabase(true);
      if (leadership) {
        safeSignalMetric(() => options.signals?.metrics.setMaintenanceLeader(true));
        options.signals?.emit("info", "lifecycle.leader_acquired", {
          outcome: "success",
          reasonCode: "none"
        });
        options.logger.info("worker.lifecycle.leadership-acquired");
      }
      return leadership !== null;
    } catch {
      markDatabase(false);
      options.logger.warn("worker.lifecycle.election-failed");
      return false;
    }
  }

  async function checkStorage(): Promise<boolean> {
    try {
      await options.storageHealth.check();
      markStorage(true);
      lastStorageHealthMs = now();
      return true;
    } catch {
      markStorage(false);
      options.logger.warn("worker.storage.unavailable");
      return false;
    }
  }

  async function runRecovery(fullSweep: boolean): Promise<boolean> {
    if (!(await verifyLeadership())) return false;
    let phase = "expiration";
    let recoveryStartedAt: number | null = options.signals?.maintenanceStarted("recovery") ?? null;
    let reconciliationStartedAt: number | null = null;
    let cleanupStartedAt: number | null = null;
    try {
      const overdue = await options.maintenance.expireOverdueActiveJobs(expirationBatchSize);
      phase = "lease-recovery";
      const recovered = await options.queue.recoverExpiredLeases();
      for (const record of overdue) {
        options.signals?.emit("info", "job.expired", {
          outcome: "success",
          reasonCode: "none",
          publicJobId: record.jobId,
          preset: options.signals.preset(record.processingPreset)
        });
      }
      safeSignalMetric(() => options.signals?.metrics.jobsExpired(overdue.length));
      safeSignalMetric(() => options.signals?.metrics.recoveryActions("recovery", "success", recovered.requeued.length));
      safeSignalMetric(() => options.signals?.metrics.recoveryActions("recovery", "failure", recovered.failed.length));
      if (recoveryStartedAt !== null) {
        options.signals?.maintenanceCompleted("recovery", recoveryStartedAt, {
          scanned: overdue.length + recovered.requeued.length + recovered.failed.length,
          recovered: recovered.requeued.length,
          expired: overdue.length,
          failures: recovered.failed.length
        });
        recoveryStartedAt = null;
      }
      lastRecoveryMs = now();
      lastSuccessfulRecoveryAt = iso();
      markDatabase(true);
      if (!(await verifyLeadership())) return false;
      phase = "storage-health";
      const healthy = await checkStorage();
      let expired = 0;
      let deleted = 0;
      if (healthy) {
        phase = "reconciliation";
        reconciliationStartedAt = options.signals?.maintenanceStarted("reconciliation") ?? null;
        const report = await options.reconciler.reconcile();
        if (reconciliationStartedAt !== null) {
          options.signals?.maintenanceCompleted("reconciliation", reconciliationStartedAt, {
            scanned: report.inspectedArtifacts,
            removed: report.removedArtifacts + report.removedOrphanObjects + report.removedAttemptWorkspaces,
            skippedActive: report.protectedActiveAttempts,
            orphanRecords: report.missingArtifacts,
            orphanFiles: report.removedOrphanObjects
          });
          reconciliationStartedAt = null;
        }
        safeSignalMetric(() => options.signals?.metrics.setOrphanArtifacts(
          report.missingArtifacts + report.removedOrphanObjects
        ));
        lastReconciliationMs = now();
        lastSuccessfulReconciliationAt = iso();
        if (!(await verifyLeadership())) return false;
        phase = "terminal-expiration";
        cleanupStartedAt = options.signals?.maintenanceStarted("cleanup") ?? null;
        const terminal = await options.maintenance.expireTerminalJobs(expirationBatchSize);
        expired = terminal.length;
        phase = "retention";
        deleted = await options.maintenance.deleteRetainedExpiredJobs(
          expirationBatchSize,
          expiredRetentionSeconds
        );
        for (const record of terminal) {
          options.signals?.emit("info", "job.expired", {
            outcome: "success",
            reasonCode: "none",
            publicJobId: record.jobId,
            preset: options.signals.preset(record.processingPreset)
          });
        }
        safeSignalMetric(() => options.signals?.metrics.jobsExpired(terminal.length));
        safeSignalMetric(() => options.signals?.metrics.recoveryActions("cleanup", "success", terminal.length + deleted));
        if (cleanupStartedAt !== null) {
          options.signals?.maintenanceCompleted("cleanup", cleanupStartedAt, {
            scanned: terminal.length,
            expired: terminal.length,
            removed: deleted
          });
          cleanupStartedAt = null;
        }
        lastSuccessfulExpirationAt = iso();
        options.logger.info("worker.lifecycle.reconciled", {
          inspected: report.inspectedArtifacts,
          removed: report.removedArtifacts + report.removedOrphanObjects + report.removedAttemptWorkspaces
        });
      }
      phase = "checkpoint";
      await options.maintenance.recordCheckpoint({
        recovery: true,
        reconciliation: healthy,
        expiration: healthy,
        fullSweep
      });
      options.logger.info("worker.lifecycle.sweep", {
        overdue: overdue.length,
        requeued: recovered.requeued.length,
        failed: recovered.failed.length,
        expired,
        deleted
      });
      return healthy && databaseHealthy;
    } catch {
      const operation = phase === "reconciliation"
        ? "reconciliation"
        : phase === "terminal-expiration" || phase === "retention"
          ? "cleanup"
          : "recovery";
      const startedAt = operation === "reconciliation"
        ? reconciliationStartedAt
        : operation === "cleanup"
          ? cleanupStartedAt
          : recoveryStartedAt;
      if (startedAt !== null) options.signals?.maintenanceFailed(operation, startedAt ?? now(), "internal");
      markDatabase(false);
      options.logger.warn("worker.lifecycle.sweep-failed", { phase });
      if (!(await leadership?.verify().catch(() => false))) {
        await releaseLeadership("sweep-failure", true);
      }
      return false;
    }
  }

  async function cycle(): Promise<void> {
    if (stopping) return;
    const elected = await elect();
    const current = now();
    if (current - lastStorageHealthMs >= storageHealthIntervalMs) await checkStorage();
    if (elected && current - lastRecoveryMs >= recoveryIntervalMs) {
      await runRecovery(false);
    } else if (
      elected &&
      storageHealthy &&
      current - lastReconciliationMs >= reconciliationIntervalMs
    ) {
      await runRecovery(false);
    }
  }

  function schedule(): void {
    if (!running || stopping || timer) return;
    const base = Math.min(electionRetryIntervalMs, recoveryIntervalMs, reconciliationIntervalMs, storageHealthIntervalMs);
    // Positive jitter avoids both synchronized workers and firing just before
    // a persisted maintenance interval becomes due.
    const jitter = 1 + Math.max(0, Math.min(1, random())) * 0.1;
    timer = setTimeout(() => {
      timer = null;
      pending = cycle().finally(() => {
        pending = null;
        schedule();
      });
    }, Math.max(250, Math.round(base * jitter)));
  }

  async function startup(): Promise<void> {
    if (started) return;
    if (startupPromise) return startupPromise;
    startupPromise = (async () => {
      if (!(await checkStorage())) {
        throw new Error("Worker storage is unavailable.");
      }
      if (options.enabled && await elect() && !(await runRecovery(true))) {
        throw new Error("Worker lifecycle startup recovery failed.");
      }
      // A follower may process jobs after schema and physical infrastructure
      // readiness; only the advisory-lock owner may mutate global lifecycle state.
      started = true;
    })().finally(() => { startupPromise = null; });
    return startupPromise;
  }

  function start(): void {
    if (running || stopping) return;
    if (!started) throw new TypeError("Lifecycle coordinator must complete startup first.");
    running = true;
    if (options.enabled) schedule();
  }

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
    await startupPromise?.catch(() => undefined);
    await pending?.catch(() => undefined);
    pending = null;
    await releaseLeadership("shutdown", false);
  }

  return Object.freeze({
    startup,
    start,
    stop,
    canClaim: () => started && !stopping && databaseHealthy && storageHealthy,
    reportDatabaseHealth: markDatabase,
    onUnsafeInfrastructure(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: (): MediaLifecycleCoordinatorStatus => Object.freeze({
      running,
      leader: leadership !== null,
      readyForClaims: started && !stopping && databaseHealthy && storageHealthy,
      databaseHealthy,
      storageHealthy,
      lastSuccessfulRecoveryAt,
      lastSuccessfulReconciliationAt,
      lastSuccessfulExpirationAt,
      lastFailureAt
    })
  });
}
