import "server-only";
import { Pool, type PoolConfig } from "pg";
import type { PostgresConnectionConfig } from "@/lib/config/env";

const SAFE_SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;

export class PostgresConnectionError extends Error {
  constructor(message = "PostgreSQL is unavailable.") {
    super(message);
    this.name = "PostgresConnectionError";
  }
}

export type SharedPostgresPool = Readonly<{
  pool: Pool;
  schema: string;
  readiness: () => Promise<void>;
  close: () => Promise<void>;
}>;

type SharedPoolState = Readonly<{
  fingerprint: string;
  handle: SharedPostgresPool;
}>;

type PostgresPoolGlobal = typeof globalThis & {
  __videoSavePostgresPoolV1?: SharedPoolState;
};

function validateSchema(schema: string): string {
  if (!SAFE_SCHEMA.test(schema)) {
    throw new TypeError("PostgreSQL schema name is invalid.");
  }
  return schema;
}

function poolConfiguration(
  config: PostgresConnectionConfig,
  schema: string
): PoolConfig {
  return {
    connectionString: config.databaseUrl,
    ssl: config.sslMode === "require" ? { rejectUnauthorized: true } : false,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    query_timeout: config.queryTimeoutMs,
    application_name: "videosave-job-repository",
    options: `-c search_path=${schema}`
  };
}

function fingerprint(config: PostgresConnectionConfig, schema: string): string {
  return JSON.stringify([
    config.databaseUrl,
    config.sslMode,
    config.poolMax,
    config.connectionTimeoutMs,
    config.statementTimeoutMs,
    config.queryTimeoutMs,
    config.idleTimeoutMs,
    schema
  ]);
}

/**
 * Creates at most one lazy pg Pool per process. Constructing this handle does
 * not open a connection; pg connects only when readiness or a repository query
 * is explicitly invoked.
 */
export function getSharedPostgresPool(
  config: PostgresConnectionConfig,
  options: Readonly<{ schema?: string }> = {}
): SharedPostgresPool {
  const schema = validateSchema(options.schema ?? "public");
  const key = fingerprint(config, schema);
  const poolGlobal = globalThis as PostgresPoolGlobal;
  const existing = poolGlobal.__videoSavePostgresPoolV1;
  if (existing) {
    if (existing.fingerprint !== key) {
      throw new PostgresConnectionError(
        "A PostgreSQL pool with different process configuration already exists."
      );
    }
    return existing.handle;
  }

  const pool = new Pool(poolConfiguration(config, schema));
  // Prevent an idle-client error from becoming an unhandled EventEmitter error.
  // Details are deliberately not logged because they may include connection data.
  pool.on("error", () => undefined);

  let closed = false;
  const handle: SharedPostgresPool = Object.freeze({
    pool,
    schema,
    async readiness(): Promise<void> {
      if (closed) throw new PostgresConnectionError("PostgreSQL pool is closed.");
      try {
        await pool.query("SELECT 1 AS ready");
      } catch {
        throw new PostgresConnectionError();
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      delete poolGlobal.__videoSavePostgresPoolV1;
      try {
        await pool.end();
      } catch {
        throw new PostgresConnectionError("PostgreSQL pool shutdown failed.");
      }
    }
  });
  poolGlobal.__videoSavePostgresPoolV1 = Object.freeze({ fingerprint: key, handle });
  return handle;
}
