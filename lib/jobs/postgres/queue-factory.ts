import "server-only";
import {
  parseJobQueueConfig,
  parseJobRepositoryConfig,
  type JobQueueConfig
} from "@/lib/config/env";
import type { JobLeaseQueue } from "@/lib/jobs/job-lease-queue";
import { createPostgresJobLeaseQueue } from "@/lib/jobs/postgres/job-queue";
import {
  getSharedPostgresPool,
  type SharedPostgresPool
} from "@/lib/jobs/postgres/pool";

export type ExplicitPostgresJobQueueRuntime = Readonly<{
  queue: JobLeaseQueue;
  config: JobQueueConfig;
  readiness: () => Promise<void>;
  close: () => Promise<void>;
}>;

export type CreateExplicitPostgresJobQueueOptions = Readonly<{
  terminalTtlMs?: number;
  /** Internally generated integration-test schema; never pass request data. */
  postgresSchema?: string;
}>;

/**
 * Explicit queue construction for integration tests and a future worker.
 * The current API/runtime composition root intentionally does not import it.
 */
export function createExplicitPostgresJobQueueRuntime(
  source: Readonly<Record<string, string | undefined>>,
  options: CreateExplicitPostgresJobQueueOptions = {}
): ExplicitPostgresJobQueueRuntime {
  const repositoryConfig = parseJobRepositoryConfig(source);
  if (repositoryConfig.backend !== "postgres") {
    throw new TypeError("PostgreSQL queue construction requires the postgres backend.");
  }
  const config = parseJobQueueConfig(source);
  const postgres: SharedPostgresPool = getSharedPostgresPool(repositoryConfig.postgres, {
    schema: options.postgresSchema
  });
  return Object.freeze({
    queue: createPostgresJobLeaseQueue({
      database: postgres.pool,
      leaseDurationMs: config.leaseDurationMs,
      maxRetries: config.maxRetries,
      terminalTtlMs: options.terminalTtlMs
    }),
    config,
    readiness: postgres.readiness,
    close: postgres.close
  });
}
