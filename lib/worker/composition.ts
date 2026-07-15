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
import { assertProductionWorkerSchemaCompatible } from "@/lib/jobs/postgres/schema-readiness";
import type { JobRepository } from "@/lib/jobs/repository";
import { createDurableVolumeStorage } from "@/lib/storage/durable-volume";
import { assertDurableVolumeMarker } from "@/lib/storage/durable-volume-marker";
import type { FinalPublicationCoordinator, MediaArtifactRepository } from "@/lib/storage/media-artifact-repository";
import { createPostgresMediaArtifactRuntime } from "@/lib/storage/postgres/artifact-repository";
import { createMediaStorageReconciler, type MediaStorageReconciler } from "@/lib/storage/reconciliation";
import type { MediaObjectStorage, MediaStorageInventory } from "@/lib/storage/media-storage";
import { createStructuredWorkerLogger, NOOP_WORKER_LOGGER, type WorkerLogger } from "@/lib/worker/logger";
import { createMediaWorkerProcessor, type MediaWorkerProcessor } from "@/lib/worker/processor";
import { createMediaWorkerRuntime, type MediaWorkerRuntime } from "@/lib/worker/runtime";
import {
  createMediaLifecycleCoordinator,
  type MediaLifecycleCoordinator
} from "@/lib/worker/lifecycle-coordinator";
import type { JobLeaseQueue } from "@/lib/jobs/job-lease-queue";
import { observeJobLeaseQueue } from "@/lib/observability/job-queue-observer";
import { observeMediaProcessRunner } from "@/lib/observability/media-process-observer";
import { createPostgresMetricsCollector } from "@/lib/observability/postgres-collector";
import type { ProcessObservability } from "@/lib/observability/runtime";
import { createStorageMetricsCollector } from "@/lib/observability/storage-collector";

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
  observability?: ProcessObservability;
}>;

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
  const baseQueue = createPostgresJobLeaseQueue({
    database: postgres.pool,
    leaseDurationMs: config.queue.leaseDurationMs,
    maxRetries: config.queue.maxRetries,
    terminalTtlMs: config.storage.finalTtlSeconds * 1_000,
    recoveryBatchSize: config.queue.recoveryBatchSize,
    retryBackoffBaseMs: config.queue.retryBackoffBaseMs,
    retryBackoffMaxMs: config.queue.retryBackoffMaxMs,
    activeTtlSeconds: config.queue.activeTtlSeconds
  });
  const queue = options.observability
    ? observeJobLeaseQueue(baseQueue, options.observability.signals)
    : baseQueue;
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
  const logger = options.logger ?? (options.observability ? NOOP_WORKER_LOGGER : createStructuredWorkerLogger());
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
    expiredRetentionSeconds: config.expiredRetentionSeconds,
    signals: options.observability?.signals
  });
  const baseRunProcess = options.runProcess ?? createConfiguredMediaProcessRunner({
    binaryPaths: { ffmpeg: config.ffmpegPath, ffprobe: config.ffprobePath },
    nodeEnv: source.NODE_ENV?.trim() || "development",
    pathValue: process.env.PATH,
    killGraceMs: config.ffmpegKillGraceSeconds * 1_000
  });
  const runProcess = options.observability
    ? observeMediaProcessRunner(baseRunProcess, options.observability.signals)
    : baseRunProcess;
  const processor = options.processor ?? createMediaWorkerProcessor({
    storage: volume.storage,
    artifacts: artifactRuntime.artifacts,
    runProcess,
    getExtractor: options.getExtractor ?? requireExtractor,
    signals: options.observability?.signals
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
    onUnsafeInfrastructure: lifecycle.onUnsafeInfrastructure,
    signals: options.observability?.signals
  });
  let closed = false;
  const removeCollectors = options.observability ? [
    options.observability.addCollector(createPostgresMetricsCollector({
      pool: postgres.pool,
      signals: options.observability.signals
    })),
    options.observability.addCollector(createStorageMetricsCollector({
      root: config.storage.root,
      authorityId: config.storage.authorityId,
      signals: options.observability.signals
    }))
  ] : [];

  async function readiness(): Promise<void> {
    if (source.NODE_ENV?.trim() === "production" && typeof process.getuid === "function" && process.getuid() === 0 && !options.allowRootForTests) {
      throw new Error("The production media worker must not run as root.");
    }
    await postgres.readiness();
    await assertProductionWorkerSchemaCompatible(postgres.pool);
    await assertDurableVolumeMarker(config.storage.root, config.storage.authorityId);
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
    for (const remove of removeCollectors) remove();
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
