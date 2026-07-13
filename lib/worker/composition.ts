import "server-only";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import {
  parseMediaWorkerConfig,
  type MediaWorkerConfig
} from "@/lib/config/env";
import { requireExtractor } from "@/lib/extractors/registry";
import type { Extractor } from "@/lib/extractors/types";
import { createConfiguredMediaProcessRunner } from "@/lib/ffmpeg/process-runner";
import type { MediaProcessRunner } from "@/lib/ffmpeg/types";
import { createPostgresJobLeaseQueue } from "@/lib/jobs/postgres/job-queue";
import {
  createPostgresMediaJobLifecycleMaintenance,
  createPostgresMediaLifecycleElection
} from "@/lib/jobs/postgres/lifecycle-maintenance";
import { getSharedPostgresPool } from "@/lib/jobs/postgres/pool";
import { createPostgresJobRepository } from "@/lib/jobs/postgres/repository";
import type { JobRepository } from "@/lib/jobs/repository";
import { createDurableVolumeStorage } from "@/lib/storage/durable-volume";
import type { FinalPublicationCoordinator, MediaArtifactRepository } from "@/lib/storage/media-artifact-repository";
import { createPostgresMediaArtifactRuntime } from "@/lib/storage/postgres/artifact-repository";
import { createMediaStorageReconciler, type MediaStorageReconciler } from "@/lib/storage/reconciliation";
import type { MediaObjectStorage, MediaStorageInventory } from "@/lib/storage/media-storage";
import { createStructuredWorkerLogger, type WorkerLogger } from "@/lib/worker/logger";
import { createMediaWorkerProcessor, type MediaWorkerProcessor } from "@/lib/worker/processor";
import { createMediaWorkerRuntime, type MediaWorkerRuntime } from "@/lib/worker/runtime";
import {
  createMediaLifecycleCoordinator,
  type MediaLifecycleCoordinator
} from "@/lib/worker/lifecycle-coordinator";
import type { JobLeaseQueue } from "@/lib/jobs/job-lease-queue";

const REQUIRED_MIGRATIONS = Object.freeze(["001", "002", "003", "004"]);

export type ProductionMediaWorkerRuntime = Readonly<{
  config: MediaWorkerConfig;
  repository: JobRepository;
  queue: JobLeaseQueue;
  storage: MediaObjectStorage;
  inventory: MediaStorageInventory;
  artifacts: MediaArtifactRepository;
  publication: FinalPublicationCoordinator;
  reconciler: MediaStorageReconciler;
  lifecycle: MediaLifecycleCoordinator;
  worker: MediaWorkerRuntime;
  readiness(): Promise<void>;
  startup(): Promise<void>;
  run(): Promise<void>;
  shutdown(options?: Readonly<{ force?: boolean }>): Promise<void>;
  close(): Promise<void>;
}>;

export type CreateProductionMediaWorkerOptions = Readonly<{
  postgresSchema?: string;
  logger?: WorkerLogger;
  processor?: MediaWorkerProcessor;
  runProcess?: MediaProcessRunner;
  getExtractor?: (url: URL) => Extractor;
  allowRootForTests?: boolean;
}>;

async function assertSchemaCompatible(pool: Pool): Promise<void> {
  const history = await pool.query<{ version: string }>(
    "SELECT version FROM _videosave_migrations WHERE version = ANY($1::text[]) ORDER BY version",
    [REQUIRED_MIGRATIONS]
  );
  if (history.rows.map((row) => row.version).join(",") !== REQUIRED_MIGRATIONS.join(",")) {
    throw new Error("PostgreSQL migrations are not compatible with the media worker.");
  }
  const capabilities = await pool.query<{
    jobs: string | null;
    artifacts: string | null;
    lifecycle: string | null;
    attempt_column: boolean;
    available_column: boolean;
    deadline_column: boolean;
  }>(
    `SELECT
       to_regclass('media_jobs')::text AS jobs,
       to_regclass('media_artifacts')::text AS artifacts,
       to_regclass('media_lifecycle_state')::text AS lifecycle,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'media_jobs'
           AND column_name = 'lease_attempt_id'
       ) AS attempt_column,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'media_jobs'
           AND column_name = 'available_at'
       ) AS available_column,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'media_jobs'
           AND column_name = 'deadline_at'
       ) AS deadline_column`
  );
  const row = capabilities.rows[0];
  if (
    !row?.jobs ||
    !row.artifacts ||
    !row.lifecycle ||
    row.attempt_column !== true ||
    row.available_column !== true ||
    row.deadline_column !== true
  ) {
    throw new Error("PostgreSQL schema is not compatible with the media worker.");
  }
}

async function assertConfiguredBinary(binary: string, production: boolean): Promise<void> {
  if (!path.isAbsolute(binary)) {
    if (production) throw new Error("Media executable configuration is invalid.");
    return;
  }
  const resolved = await realpath(binary);
  const info = await lstat(resolved);
  if (!info.isFile()) throw new Error("Media executable is unavailable.");
  await access(resolved, constants.X_OK);
}

export function createProductionMediaWorkerRuntime(
  source: Readonly<Record<string, string | undefined>>,
  options: CreateProductionMediaWorkerOptions = {}
): ProductionMediaWorkerRuntime {
  const config = parseMediaWorkerConfig(source);
  const postgres = getSharedPostgresPool(config.repository.postgres, {
    schema: options.postgresSchema
  });
  const repository = createPostgresJobRepository({ database: postgres.pool });
  const queue = createPostgresJobLeaseQueue({
    database: postgres.pool,
    leaseDurationMs: config.queue.leaseDurationMs,
    maxRetries: config.queue.maxRetries,
    terminalTtlMs: config.storage.finalTtlSeconds * 1_000,
    recoveryBatchSize: config.queue.recoveryBatchSize,
    retryBackoffBaseMs: config.queue.retryBackoffBaseMs,
    retryBackoffMaxMs: config.queue.retryBackoffMaxMs,
    activeTtlSeconds: config.queue.activeTtlSeconds
  });
  const volume = createDurableVolumeStorage({
    root: config.storage.root,
    maxJobBytes: config.storage.maxJobBytes,
    maxOutputBytes: config.storage.maxOutputBytes,
    lowDiskBytes: config.storage.lowDiskBytes
  });
  const artifactRuntime = createPostgresMediaArtifactRuntime({ pool: postgres.pool });
  const maintenance = createPostgresMediaJobLifecycleMaintenance(postgres.pool);
  const reconciler = createMediaStorageReconciler({
    artifacts: artifactRuntime.artifacts,
    storage: volume.storage,
    inventory: volume.inventory,
    batchSize: config.storage.cleanupBatchSize,
    orphanGraceMs: config.orphanGraceMs,
    lifecycle: maintenance
  });
  const logger = options.logger ?? createStructuredWorkerLogger();
  const lifecycle = createMediaLifecycleCoordinator({
    enabled: config.recoveryEnabled,
    election: createPostgresMediaLifecycleElection(postgres.pool),
    maintenance,
    queue,
    reconciler,
    storageHealth: volume.health,
    logger,
    recoveryIntervalMs: config.queue.recoveryIntervalMs,
    reconciliationIntervalMs: config.reconciliationIntervalMs,
    storageHealthIntervalMs: config.storageHealthIntervalMs,
    electionRetryIntervalMs: config.electionRetryIntervalMs,
    expirationBatchSize: config.expirationBatchSize,
    expiredRetentionSeconds: config.expiredRetentionSeconds
  });
  const runProcess = options.runProcess ?? createConfiguredMediaProcessRunner({
    binaryPaths: { ffmpeg: config.ffmpegPath, ffprobe: config.ffprobePath },
    nodeEnv: source.NODE_ENV?.trim() || "development",
    pathValue: process.env.PATH,
    killGraceMs: config.ffmpegKillGraceSeconds * 1_000
  });
  const processor = options.processor ?? createMediaWorkerProcessor({
    storage: volume.storage,
    artifacts: artifactRuntime.artifacts,
    runProcess,
    getExtractor: options.getExtractor ?? requireExtractor
  }, {
    maxFileSizeBytes: config.maxFileSizeBytes,
    maxOutputBytes: config.storage.maxOutputBytes,
    maxDurationSeconds: config.maxDurationSeconds,
    metadataTimeoutSeconds: config.metadataTimeoutSeconds,
    downloadTimeoutSeconds: config.downloadTimeoutSeconds,
    ffprobeTimeoutMs: config.ffprobeTimeoutSeconds * 1_000,
    ffmpegTimeoutMs: config.ffmpegTimeoutSeconds * 1_000,
    ffmpegThreads: config.ffmpegThreads,
    finalTtlSeconds: config.storage.finalTtlSeconds
  });
  const worker = createMediaWorkerRuntime({
    queue,
    artifacts: artifactRuntime.artifacts,
    publication: artifactRuntime.publication,
    processor,
    logger,
    concurrency: config.workerConcurrency,
    workerIdPrefix: config.workerIdPrefix,
    pollIntervalMs: config.pollIntervalMs,
    progressIntervalMs: config.progressIntervalMs,
    renewalIntervalMs: config.queue.leaseRenewIntervalMs,
    leaseDurationMs: config.queue.leaseDurationMs,
    cancellationPollIntervalMs: config.cancellationPollIntervalMs,
    dbLossGraceMs: config.dbLossGraceMs,
    attemptTimeoutMs: config.attemptTimeoutMs,
    shutdownGraceMs: config.shutdownGraceMs,
    canClaim: lifecycle.canClaim,
    reportDatabaseHealth: lifecycle.reportDatabaseHealth,
    onUnsafeInfrastructure: lifecycle.onUnsafeInfrastructure
  });
  let closed = false;

  async function readiness(): Promise<void> {
    if (source.NODE_ENV?.trim() === "production" && typeof process.getuid === "function" && process.getuid() === 0 && !options.allowRootForTests) {
      throw new Error("The production media worker must not run as root.");
    }
    await postgres.readiness();
    await assertSchemaCompatible(postgres.pool);
    await volume.storage.initialize();
    await volume.health.check();
    const production = source.NODE_ENV?.trim() === "production";
    await Promise.all([
      assertConfiguredBinary(config.ffmpegPath, production),
      assertConfiguredBinary(config.ffprobePath, production)
    ]);
    await Promise.all([
      runProcess({ tool: "ffmpeg", args: ["-version"], cwd: process.cwd(), timeoutMs: 5_000 }),
      runProcess({ tool: "ffprobe", args: ["-version"], cwd: process.cwd(), timeoutMs: 5_000 })
    ]);
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await worker.shutdown({ force: true });
    await lifecycle.stop();
    await postgres.close();
  }

  async function run(): Promise<void> {
    await startup();
    lifecycle.start();
    try {
      await worker.run();
    } finally {
      await lifecycle.stop();
    }
  }

  async function startup(): Promise<void> {
    await lifecycle.startup();
  }

  async function shutdown(shutdownOptions: Readonly<{ force?: boolean }> = {}): Promise<void> {
    await worker.shutdown(shutdownOptions);
    await lifecycle.stop();
  }

  return Object.freeze({
    config,
    repository,
    queue,
    storage: volume.storage,
    inventory: volume.inventory,
    artifacts: artifactRuntime.artifacts,
    publication: artifactRuntime.publication,
    reconciler,
    lifecycle,
    worker,
    readiness,
    startup,
    run,
    shutdown,
    close
  });
}
