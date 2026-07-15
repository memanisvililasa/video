import "server-only";
import {
  ERROR_CATEGORIES,
  JOB_STATUSES,
  MAINTENANCE_OPERATIONS,
  MEDIA_STAGES,
  OUTCOMES,
  PROCESSING_PRESETS,
  type ObservedJobStatus,
  type ObservedMaintenanceOperation,
  type ObservedMediaStage,
  type ObservedProcessingPreset,
  type ObservedProcessRole,
  type OperationalErrorCategory,
  type OperationalOutcome
} from "@/lib/observability/contract";
import type { CoreMetrics } from "@/lib/observability/core-metrics";

const JOB_DURATION_BUCKETS = Object.freeze([1, 5, 15, 30, 60, 120, 300, 600, 1_200, 3_600]);
const STAGE_DURATION_BUCKETS = Object.freeze([0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900]);
const allow = (values: readonly string[]) => (value: string): boolean => values.includes(value);

export type QueueSnapshot = Readonly<{
  queued: number;
  oldestQueuedAgeSeconds: number;
  running: number;
  staleLeases: number;
}>;

export type PoolSnapshot = Readonly<{
  up: boolean;
  active: number;
  idle: number;
  waiting: number;
  migrationCompatible: boolean;
}>;

export type StorageSnapshot = Readonly<{
  up: boolean;
  readOnly: boolean;
  markerValid: boolean;
  freeBytes?: number;
  freeInodes?: number;
}>;

export type MaintenanceSnapshot = Readonly<{
  recovery?: number;
  reconciliation?: number;
  cleanup?: number;
  expiration?: number;
}>;

export type OperationalMetrics = Readonly<{
  jobSubmitted(preset: ObservedProcessingPreset): void;
  jobCompleted(preset: ObservedProcessingPreset, durationSeconds: number): void;
  jobFailed(preset: ObservedProcessingPreset, reason: OperationalErrorCategory, durationSeconds?: number): void;
  jobCancelled(preset: ObservedProcessingPreset): void;
  jobsExpired(amount: number): void;
  jobRetried(reason: OperationalErrorCategory, amount?: number): void;
  retryExhausted(reason: OperationalErrorCategory, amount?: number): void;
  stageDuration(stage: ObservedMediaStage, preset: ObservedProcessingPreset, outcome: OperationalOutcome, seconds: number): void;
  setQueueSnapshot(snapshot: QueueSnapshot): void;
  setWorkerCapacity(configured: number, active: number): void;
  setWorkerHeartbeat(unixSeconds: number): void;
  workerFailure(stage: ObservedMediaStage, reason: OperationalErrorCategory): void;
  mediaProcessStarted(): void;
  mediaProcessFinished(): void;
  downloadBytes(preset: ObservedProcessingPreset, bytes: number): void;
  publicationFailure(reason: OperationalErrorCategory): void;
  setPoolSnapshot(snapshot: PoolSnapshot): void;
  databaseQueryFailure(reason: OperationalErrorCategory): void;
  setStorageSnapshot(snapshot: StorageSnapshot): void;
  setOrphanArtifacts(value: number): void;
  setMaintenanceLeader(leader: boolean): void;
  setMaintenanceSnapshot(snapshot: MaintenanceSnapshot): void;
  maintenanceSuccess(operation: ObservedMaintenanceOperation, unixSeconds: number): void;
  maintenanceFailure(operation: ObservedMaintenanceOperation, reason: OperationalErrorCategory): void;
  recoveryActions(operation: ObservedMaintenanceOperation, outcome: OperationalOutcome, amount: number): void;
}>;

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function registerOperationalMetrics(
  core: CoreMetrics,
  role: ObservedProcessRole = "worker"
): OperationalMetrics {
  const registry = core.registry;
  const preset = { preset: allow(PROCESSING_PRESETS) };
  const reason = { reasonCategory: allow(ERROR_CATEGORIES) };
  const submitted = registry.registerCounter("jobs_submitted_total", "Jobs accepted into the durable queue.", preset);
  const completed = registry.registerCounter("jobs_completed_total", "Jobs completed successfully.", preset);
  const failed = registry.registerCounter("jobs_failed_total", "Jobs reaching a failed terminal outcome.", { ...preset, ...reason });
  const cancelled = registry.registerCounter("jobs_cancelled_total", "Jobs reaching a cancelled terminal outcome.", preset);
  const expired = registry.registerCounter("jobs_expired_total", "Jobs transitioned to expired state.");
  const retried = registry.registerCounter("jobs_retried_total", "Lease recovery retries scheduled.", reason);
  const exhausted = registry.registerCounter("retry_exhausted_total", "Jobs that exhausted retry allowance.", reason);
  const terminalOutcomes = ["success", "failure", "cancelled"] as const;
  const duration = registry.registerHistogram("job_duration_seconds", "End-to-end observed job duration.", {
    ...preset,
    outcome: allow(terminalOutcomes)
  }, JOB_DURATION_BUCKETS);
  const stageDuration = registry.registerHistogram("job_stage_duration_seconds", "Observed worker stage duration.", {
    stage: allow(MEDIA_STAGES),
    outcome: allow(terminalOutcomes)
  }, STAGE_DURATION_BUCKETS);
  const active = registry.registerGauge("active_jobs", "Current queued and running jobs from the bounded database snapshot.");
  const queueDepth = registry.registerGauge("queue_depth", "Current durable queued job count.");
  const oldestQueued = registry.registerGauge("oldest_queued_job_age_seconds", "Age of the oldest queued job.");
  const running = registry.registerGauge("running_jobs", "Current durable running job count.");
  const stale = registry.registerGauge("stale_leases", "Current running jobs with an expired lease.");

  const availableSlots = registry.registerGauge("worker_available_slots", "Configured worker slots not currently active.");
  const workerActive = registry.registerGauge("worker_active_jobs", "Jobs actively processed by this worker process.");
  const heartbeat = registry.registerGauge("worker_last_heartbeat_timestamp", "Last successful worker database activity as Unix seconds.");
  const processingFailures = registry.registerCounter("worker_processing_failures_total", "Worker attempt processing failures.", {
    stage: allow(MEDIA_STAGES),
    ...reason
  });
  const ffmpegProcesses = registry.registerGauge("ffmpeg_processes", "FFmpeg child processes currently active.");
  const downloaded = registry.registerCounter("download_bytes_total", "Validated downloaded media bytes.", preset);
  const publicationFailures = registry.registerCounter("artifact_publication_failures_total", "Artifact publication failures.", reason);

  const dbUp = registry.registerGauge("db_up", "Whether the bounded PostgreSQL snapshot succeeded.");
  const poolActive = registry.registerGauge("db_pool_active", "PostgreSQL pool clients currently checked out.");
  const poolIdle = registry.registerGauge("db_pool_idle", "PostgreSQL pool clients currently idle.");
  const poolWaiting = registry.registerGauge("db_pool_waiting", "PostgreSQL pool acquisition waiters.");
  const queryFailures = registry.registerCounter("db_query_failures_total", "Observed PostgreSQL query boundary failures.", reason);
  const migrationCompatible = registry.registerGauge("migration_compatible", "Whether the exact migration catalog is compatible.");

  const storageUp = registry.registerGauge("storage_up", "Whether the bounded durable-volume snapshot succeeded.");
  const storageReadOnly = registry.registerGauge("storage_read_only", "Whether the durable root is available without write access.");
  const storageFreeBytes = registry.registerGauge("storage_free_bytes", "Available durable-volume bytes.");
  const storageFreeInodes = registry.registerGauge("storage_free_inodes", "Available durable-volume inodes.");
  const storageMarker = registry.registerGauge("storage_marker_valid", "Whether the durable-volume marker is valid.");
  const orphanArtifacts = registry.registerGauge("orphan_artifacts", "Orphans observed by the last bounded reconciliation report.");
  const reconciliationFailures = registry.registerCounter("reconciliation_failures_total", "Reconciliation operation failures.", reason);
  const cleanupFailures = registry.registerCounter("cleanup_failures_total", "Cleanup operation failures.", reason);
  const cleanupLastSuccess = registry.registerGauge("cleanup_last_success_timestamp", "Last complete cleanup success as Unix seconds.");

  const maintenanceLeader = registry.registerGauge("maintenance_leader", "Whether this process owns lifecycle maintenance leadership.");
  const maintenanceSuccess = registry.registerGauge("maintenance_last_success_timestamp", "Last complete maintenance success as Unix seconds.", {
    operation: allow(MAINTENANCE_OPERATIONS)
  });
  const recoveryActions = registry.registerCounter("recovery_actions_total", "Bounded maintenance actions observed by operation and outcome.", {
    operation: allow(MAINTENANCE_OPERATIONS),
    outcome: allow(OUTCOMES)
  });

  if (role === "worker") {
    availableSlots.set(undefined, 0);
    workerActive.set(undefined, 0);
    ffmpegProcesses.set(undefined, 0);
    maintenanceLeader.set(undefined, 0);
  }

  return Object.freeze({
    jobSubmitted(value) { submitted.inc({ preset: value }); },
    jobCompleted(value, seconds) {
      completed.inc({ preset: value });
      if (finiteNonNegative(seconds)) duration.observe({ preset: value, outcome: "success" }, seconds);
    },
    jobFailed(value, category, seconds) {
      failed.inc({ preset: value, reasonCategory: category });
      if (seconds !== undefined && finiteNonNegative(seconds)) duration.observe({ preset: value, outcome: "failure" }, seconds);
    },
    jobCancelled(value) { cancelled.inc({ preset: value }); },
    jobsExpired(amount) { expired.inc(undefined, amount); },
    jobRetried(category, amount = 1) { retried.inc({ reasonCategory: category }, amount); },
    retryExhausted(category, amount = 1) { exhausted.inc({ reasonCategory: category }, amount); },
    stageDuration(stage, value, outcome, seconds) {
      if (finiteNonNegative(seconds)) stageDuration.observe({ stage, outcome }, seconds);
    },
    setQueueSnapshot(snapshot) {
      queueDepth.set(undefined, snapshot.queued);
      oldestQueued.set(undefined, snapshot.oldestQueuedAgeSeconds);
      running.set(undefined, snapshot.running);
      stale.set(undefined, snapshot.staleLeases);
      active.set(undefined, snapshot.queued + snapshot.running);
    },
    setWorkerCapacity(configured, current) {
      workerActive.set(undefined, current);
      availableSlots.set(undefined, Math.max(0, configured - current));
    },
    setWorkerHeartbeat(value) { heartbeat.set(undefined, value); },
    workerFailure(stage, category) { processingFailures.inc({ stage, reasonCategory: category }); },
    mediaProcessStarted() { ffmpegProcesses.inc(); },
    mediaProcessFinished() { ffmpegProcesses.dec(); },
    downloadBytes(value, bytes) { downloaded.inc({ preset: value }, bytes); },
    publicationFailure(category) { publicationFailures.inc({ reasonCategory: category }); },
    setPoolSnapshot(snapshot) {
      dbUp.set(undefined, snapshot.up ? 1 : 0);
      poolActive.set(undefined, snapshot.active);
      poolIdle.set(undefined, snapshot.idle);
      poolWaiting.set(undefined, snapshot.waiting);
      migrationCompatible.set(undefined, snapshot.migrationCompatible ? 1 : 0);
    },
    databaseQueryFailure(category) { queryFailures.inc({ reasonCategory: category }); },
    setStorageSnapshot(snapshot) {
      storageUp.set(undefined, snapshot.up ? 1 : 0);
      storageReadOnly.set(undefined, snapshot.readOnly ? 1 : 0);
      storageMarker.set(undefined, snapshot.markerValid ? 1 : 0);
      if (snapshot.freeBytes !== undefined) storageFreeBytes.set(undefined, snapshot.freeBytes);
      if (snapshot.freeInodes !== undefined) storageFreeInodes.set(undefined, snapshot.freeInodes);
    },
    setOrphanArtifacts(value) { orphanArtifacts.set(undefined, value); },
    setMaintenanceLeader(value) { maintenanceLeader.set(undefined, value ? 1 : 0); },
    setMaintenanceSnapshot(snapshot) {
      for (const operation of MAINTENANCE_OPERATIONS) {
        const value = snapshot[operation];
        if (value !== undefined) maintenanceSuccess.set({ operation }, value);
      }
      if (snapshot.cleanup !== undefined) cleanupLastSuccess.set(undefined, snapshot.cleanup);
    },
    maintenanceSuccess(operation, unixSeconds) {
      maintenanceSuccess.set({ operation }, unixSeconds);
      if (operation === "cleanup") cleanupLastSuccess.set(undefined, unixSeconds);
    },
    maintenanceFailure(operation, category) {
      if (operation === "reconciliation") reconciliationFailures.inc({ reasonCategory: category });
      if (operation === "cleanup") cleanupFailures.inc({ reasonCategory: category });
    },
    recoveryActions(operation, outcome, amount) { recoveryActions.inc({ operation, outcome }, amount); }
  });
}

export function isObservedPreset(value: unknown): value is ObservedProcessingPreset {
  return typeof value === "string" && (PROCESSING_PRESETS as readonly string[]).includes(value);
}

export function isObservedJobStatus(value: unknown): value is ObservedJobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}
