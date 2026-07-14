import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DURABLE_VOLUME_MARKER_FILENAME } from "@/lib/storage/durable-volume-marker";
import { runProductionWebReadiness } from "@/lib/web/readiness";
import {
  provisionDurableVolumeTestRoot,
  TEST_DURABLE_VOLUME_AUTHORITY_ID
} from "@/tests/helpers/durable-volume";
import { applyMigrations } from "../../scripts/postgres-migrations.mjs";

const { Client } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required; production web readiness was not tested.");
}

const schema = `videosave_web_ready_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const quotedSchema = `"${schema}"`;
let bootstrap: InstanceType<typeof Client>;
const roots: string[] = [];

function source(root: string, overrides: Record<string, string | undefined> = {}) {
  return {
    APP_PROCESS_ROLE: "web",
    JOB_REPOSITORY_BACKEND: "postgres",
    DATABASE_URL: testDatabaseUrl,
    POSTGRES_SSL_MODE: "disable",
    POSTGRES_POOL_MAX: "2",
    POSTGRES_CONNECTION_TIMEOUT_MS: "5000",
    POSTGRES_STATEMENT_TIMEOUT_MS: "3000",
    POSTGRES_QUERY_TIMEOUT_MS: "3000",
    POSTGRES_IDLE_TIMEOUT_MS: "1000",
    MEDIA_STORAGE_BACKEND: "durable-volume",
    MEDIA_STORAGE_ROOT: root,
    MEDIA_STORAGE_AUTHORITY_ID: TEST_DURABLE_VOLUME_AUTHORITY_ID,
    MEDIA_STORAGE_MAX_JOB_BYTES: "2097152",
    MEDIA_STORAGE_MAX_OUTPUT_BYTES: "1048576",
    MEDIA_FINAL_TTL_SECONDS: "60",
    MEDIA_STORAGE_LOW_DISK_BYTES: "1048576",
    MEDIA_CLEANUP_BATCH_SIZE: "10",
    NODE_ENV: "test",
    ...overrides
  };
}

async function root(provision = true): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "videosave-web-readiness-"));
  roots.push(value);
  if (provision) await provisionDurableVolumeTestRoot(value, { createPublished: true });
  return value;
}

beforeAll(async () => {
  bootstrap = new Client({
    connectionString: testDatabaseUrl,
    ssl: false,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: "videosave-web-readiness-bootstrap"
  });
  await bootstrap.connect();
  await bootstrap.query(`CREATE SCHEMA ${quotedSchema}`);
  await applyMigrations({
    connectionString: testDatabaseUrl,
    sslMode: "disable",
    nodeEnv: "test",
    schema
  });
  await bootstrap.query("SELECT set_config('search_path', $1, false)", [schema]);
});

afterAll(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
  await bootstrap.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => undefined);
  await bootstrap.end().catch(() => undefined);
});

describe("production web readiness", () => {
  it("checks role, PostgreSQL, exact migrations, registry, queue, and read-only volume without writes", async () => {
    const storageRoot = await root();
    const before = await bootstrap.query("SELECT count(*)::int AS jobs FROM media_jobs");
    await expect(runProductionWebReadiness(source(storageRoot), { postgresSchema: schema }))
      .resolves.toBeUndefined();
    const after = await bootstrap.query("SELECT count(*)::int AS jobs FROM media_jobs");
    expect(before.rows[0]).toEqual({ jobs: 0 });
    expect(after.rows[0]).toEqual({ jobs: 0 });
  });

  it("rejects checksum mismatch and closes its pool", async () => {
    const storageRoot = await root();
    const original = await bootstrap.query<{ checksum: string }>(
      "SELECT checksum FROM _videosave_migrations WHERE version = '004'"
    );
    await bootstrap.query(
      "UPDATE _videosave_migrations SET checksum = $1 WHERE version = '004'",
      ["0".repeat(64)]
    );
    try {
      await expect(runProductionWebReadiness(source(storageRoot), { postgresSchema: schema }))
        .rejects.toThrow("not compatible");
    } finally {
      await bootstrap.query(
        "UPDATE _videosave_migrations SET checksum = $1 WHERE version = '004'",
        [original.rows[0]?.checksum]
      );
    }
  });

  it("rejects missing and malformed markers without creating them", async () => {
    const missing = await root(false);
    await expect(runProductionWebReadiness(source(missing), { postgresSchema: schema }))
      .rejects.toThrow("storage");
    const malformed = await root(false);
    await writeFile(path.join(malformed, DURABLE_VOLUME_MARKER_FILENAME), "invalid\n", { mode: 0o600 });
    await expect(runProductionWebReadiness(source(malformed), { postgresSchema: schema }))
      .rejects.toThrow("storage");
  });

  it("fails closed for a non-web role before infrastructure access", async () => {
    const storageRoot = await root();
    await expect(runProductionWebReadiness(source(storageRoot, {
      APP_PROCESS_ROLE: "worker",
      DATABASE_URL: undefined,
      MEDIA_STORAGE_ROOT: undefined
    }), { postgresSchema: schema })).rejects.toThrow("web");
  });

  it("does not use TEST_DATABASE_URL when DATABASE_URL is absent", async () => {
    const storageRoot = await root();
    await expect(runProductionWebReadiness(source(storageRoot, {
      DATABASE_URL: undefined,
      TEST_DATABASE_URL: testDatabaseUrl
    }), { postgresSchema: schema })).rejects.toThrow("DATABASE_URL");
  });

  it("fails closed when PostgreSQL is unavailable without touching the valid test database", async () => {
    const storageRoot = await root();
    await expect(runProductionWebReadiness(source(storageRoot, {
      DATABASE_URL: "postgresql://unavailable:secret@127.0.0.1:1/unavailable",
      POSTGRES_CONNECTION_TIMEOUT_MS: "100"
    }), { postgresSchema: schema })).rejects.toThrow("unavailable");
    expect((await bootstrap.query("SELECT count(*)::int AS jobs FROM media_jobs")).rows[0])
      .toEqual({ jobs: 0 });
  });
});
