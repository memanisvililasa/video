import "server-only";
import {
  parseProductionWebConfig,
  type ProductionWebConfig
} from "@/lib/config/env";
import type { JobLeaseQueue } from "@/lib/jobs/job-lease-queue";
import { createPostgresJobLeaseQueue } from "@/lib/jobs/postgres/job-queue";
import { createPostgresPool } from "@/lib/jobs/postgres/pool";
import { createPostgresJobRepository } from "@/lib/jobs/postgres/repository";
import { assertProductionWebSchemaCompatible } from "@/lib/jobs/postgres/schema-readiness";
import {
  createPersistentDownloadJobService,
  type PersistentDownloadJobService
} from "@/lib/jobs/postgres/web-service";
import type { JobRepository } from "@/lib/jobs/repository";
import {
  createReadonlyDurableVolumeStorage,
  type ReadonlyMediaObjectStorage
} from "@/lib/storage/durable-volume-readonly";
import { createDurableMediaFileDelivery, type MediaFileDelivery } from "@/lib/storage/file-delivery";
import type { MediaArtifactRepository } from "@/lib/storage/media-artifact-repository";
import { createPostgresMediaArtifactRuntime } from "@/lib/storage/postgres/artifact-repository";
import { observeJobLeaseQueue } from "@/lib/observability/job-queue-observer";
import { createPostgresMetricsCollector } from "@/lib/observability/postgres-collector";
import type { ProcessObservability } from "@/lib/observability/runtime";
import { createStorageMetricsCollector } from "@/lib/observability/storage-collector";

export type ProductionWebRuntime = Readonly<{
  role: "web";
  authority: "postgres";
  config: ProductionWebConfig;
  repository: JobRepository;
  queue: JobLeaseQueue;
  artifacts: MediaArtifactRepository;
  storage: ReadonlyMediaObjectStorage;
  jobs: PersistentDownloadJobService;
  files: MediaFileDelivery;
  readiness(): Promise<void>;
  close(): Promise<void>;
}>;

export type CreateProductionWebRuntimeOptions = Readonly<{
  /** Internally generated integration-test schema; never pass request data. */
  postgresSchema?: string;
  createJobId?: () => string;
  observability?: ProcessObservability;
}>;

/**
 * Explicit persistent web composition. Construction parses configuration and
 * allocates a lazy pool object, but performs no DB or filesystem I/O.
 */
export function createProductionWebRuntime(
  source: Readonly<Record<string, string | undefined>>,
  options: CreateProductionWebRuntimeOptions = {}
): ProductionWebRuntime {
  const config = parseProductionWebConfig(source);
  const postgres = createPostgresPool(config.repository.postgres, {
    schema: options.postgresSchema,
    applicationName: "videosave-web"
  });
  const repository = createPostgresJobRepository({ database: postgres.pool });
  const baseQueue = createPostgresJobLeaseQueue({
    database: postgres.pool,
    // Web only calls enqueue/cancellation. Claim/recovery remain worker-only;
    // required constructor values are inert defaults in this process role.
    leaseDurationMs: 60_000,
    maxRetries: 3,
    terminalTtlMs: config.storage.finalTtlSeconds * 1_000,
    activeTtlSeconds: config.queue.activeTtlSeconds
  });
  const queue = options.observability
    ? observeJobLeaseQueue(baseQueue, options.observability.signals)
    : baseQueue;
  const artifactRuntime = createPostgresMediaArtifactRuntime({ pool: postgres.pool });
  const storage = createReadonlyDurableVolumeStorage(
    config.storage.root,
    config.storage.authorityId
  );
  const jobs = createPersistentDownloadJobService({
    repository,
    queue,
    createJobId: options.createJobId
  });
  const files = createDurableMediaFileDelivery({
    artifacts: artifactRuntime.artifacts,
    storage
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
    if (closed) throw new Error("Production web runtime is closed.");
    await postgres.readiness();
    await assertProductionWebSchemaCompatible(postgres.pool);
    await storage.initialize();
    await storage.readiness();
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const remove of removeCollectors) remove();
    await postgres.close();
  }

  return Object.freeze({
    role: "web" as const,
    authority: "postgres" as const,
    config,
    repository,
    queue,
    artifacts: artifactRuntime.artifacts,
    storage,
    jobs,
    files,
    readiness,
    close
  });
}
