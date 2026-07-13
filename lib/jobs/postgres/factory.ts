import "server-only";
import {
  parseJobRepositoryConfig,
  type JobRepositoryConfig
} from "@/lib/config/env";
import { createInMemoryJobRepository } from "@/lib/jobs/in-memory-job-repository";
import {
  getSharedPostgresPool,
  type SharedPostgresPool
} from "@/lib/jobs/postgres/pool";
import { createPostgresJobRepository } from "@/lib/jobs/postgres/repository";
import type { JobRepository } from "@/lib/jobs/repository";

export type ExplicitJobRepositoryRuntime = Readonly<{
  backend: JobRepositoryConfig["backend"];
  repository: JobRepository;
  readiness: () => Promise<void>;
  close: () => Promise<void>;
}>;

export type CreateExplicitJobRepositoryOptions = Readonly<{
  terminalTtlMs?: number;
  now?: () => number;
  /** Internally generated integration-test schema; never pass request data. */
  postgresSchema?: string;
}>;

/**
 * Explicit future-cutover factory. The existing API composition root does not
 * import or call it, so its shared runtime remains in-memory.
 */
export function createExplicitJobRepositoryRuntime(
  source: Readonly<Record<string, string | undefined>>,
  options: CreateExplicitJobRepositoryOptions = {}
): ExplicitJobRepositoryRuntime {
  const config = parseJobRepositoryConfig(source);
  if (config.backend === "memory") {
    return Object.freeze({
      backend: config.backend,
      repository: createInMemoryJobRepository(options),
      async readiness(): Promise<void> {},
      async close(): Promise<void> {}
    });
  }

  const postgres: SharedPostgresPool = getSharedPostgresPool(config.postgres, {
    schema: options.postgresSchema
  });
  return Object.freeze({
    backend: config.backend,
    repository: createPostgresJobRepository({
      database: postgres.pool,
      terminalTtlMs: options.terminalTtlMs,
      now: options.now
    }),
    readiness: postgres.readiness,
    close: postgres.close
  });
}
