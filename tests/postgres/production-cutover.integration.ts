import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseJobRepositoryConfig } from "@/lib/config/env";
import {
  assertPostgresCutoverReady,
  MIGRATION_ADVISORY_LOCK_KEY,
  type PostgresCutoverRoleNames
} from "@/lib/jobs/postgres/cutover-readiness";
import { createPostgresJobLeaseQueue } from "@/lib/jobs/postgres/job-queue";
import { createPostgresPool } from "@/lib/jobs/postgres/pool";
import { assertPostgresSchemaCompatible } from "@/lib/jobs/postgres/schema-readiness";
import { createPostgresMediaArtifactRuntime } from "@/lib/storage/postgres/artifact-repository";
import { parseMediaStorageKey } from "@/lib/storage/media-storage";
import { API_ERROR_CODES } from "@/lib/types";
import { createProductionWebRuntime, type ProductionWebRuntime } from "@/lib/web/production-runtime";
import {
  provisionDurableVolumeTestRoot,
  TEST_DURABLE_VOLUME_AUTHORITY_ID
} from "@/tests/helpers/durable-volume";
import { applyMigrations, migrationStatus } from "../../scripts/postgres-migrations.mjs";

const { Client } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for the real-role acceptance suite.");

const suffix = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`.toLowerCase();
const databaseName = `vs_c1_${suffix}`;
const roles: PostgresCutoverRoleNames = Object.freeze({
  migration: `vs_mig_${suffix}`,
  web: `vs_web_${suffix}`,
  worker: `vs_worker_${suffix}`
});
const passwords = Object.freeze({
  migration: randomBytes(24).toString("hex"),
  web: randomBytes(24).toString("hex"),
  worker: randomBytes(24).toString("hex")
});
const roots: string[] = [];

let admin: InstanceType<typeof Client>;
let appAdmin: InstanceType<typeof Client> | null = null;
let cutoverPool: Pool | null = null;
let webRuntime: ProductionWebRuntime | null = null;
let workerPool: ReturnType<typeof createPostgresPool> | null = null;
let databaseCreated = false;
let rolesCreated = false;

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("Unsafe test identifier.");
  return `"${value}"`;
}

function quotePassword(value: string): string {
  if (!/^[a-f0-9]{48}$/.test(value)) throw new Error("Unsafe test password.");
  return `'${value}'`;
}

function roleUrl(role: keyof typeof passwords): string {
  const url = new URL(testDatabaseUrl as string);
  url.username = roles[role];
  url.password = passwords[role];
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function adminDatabaseUrl(): string {
  const url = new URL(testDatabaseUrl as string);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function template(relative: string, values: Readonly<Record<string, string>>): Promise<string[]> {
  const content = await readFile(path.join(process.cwd(), relative), "utf8");
  const rendered = content
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("\\"))
    .join("\n")
    .replace(/:\"([a-z_]+)\"/g, (_match, name: string) => {
      const value = values[name];
      if (!value) throw new Error("PostgreSQL template variable is missing.");
      return quoteIdentifier(value);
    });
  if (/:["']/.test(rendered)) throw new Error("PostgreSQL template contains unresolved variables.");
  return rendered.split(";").map((statement) => statement.trim()).filter(Boolean);
}

async function executeTemplate(
  client: InstanceType<typeof Client>,
  relative: string,
  values: Readonly<Record<string, string>>
): Promise<void> {
  for (const statement of await template(relative, values)) await client.query(statement);
}

function repositoryConfig(databaseUrl: string) {
  const parsed = parseJobRepositoryConfig({
    JOB_REPOSITORY_BACKEND: "postgres",
    DATABASE_URL: databaseUrl,
    POSTGRES_SSL_MODE: "disable",
    POSTGRES_POOL_MAX: "3",
    POSTGRES_CONNECTION_TIMEOUT_MS: "5000",
    POSTGRES_STATEMENT_TIMEOUT_MS: "5000",
    POSTGRES_QUERY_TIMEOUT_MS: "5000",
    POSTGRES_IDLE_TIMEOUT_MS: "1000",
    NODE_ENV: "test"
  });
  if (parsed.backend !== "postgres") throw new Error("Expected PostgreSQL config.");
  return parsed.postgres;
}

function webSource(root: string) {
  return {
    APP_PROCESS_ROLE: "web",
    JOB_REPOSITORY_BACKEND: "postgres",
    DATABASE_URL: roleUrl("web"),
    POSTGRES_SSL_MODE: "disable",
    POSTGRES_POOL_MAX: "3",
    POSTGRES_CONNECTION_TIMEOUT_MS: "5000",
    POSTGRES_STATEMENT_TIMEOUT_MS: "5000",
    POSTGRES_QUERY_TIMEOUT_MS: "5000",
    POSTGRES_IDLE_TIMEOUT_MS: "1000",
    MEDIA_STORAGE_BACKEND: "durable-volume",
    MEDIA_STORAGE_ROOT: root,
    MEDIA_STORAGE_AUTHORITY_ID: TEST_DURABLE_VOLUME_AUTHORITY_ID,
    MEDIA_STORAGE_MAX_JOB_BYTES: "2097152",
    MEDIA_STORAGE_MAX_OUTPUT_BYTES: "1048576",
    MEDIA_FINAL_TTL_SECONDS: "60",
    MEDIA_STORAGE_LOW_DISK_BYTES: "1048576",
    NODE_ENV: "test"
  };
}

beforeAll(async () => {
  admin = new Client({
    connectionString: testDatabaseUrl,
    ssl: false,
    connectionTimeoutMillis: 5_000,
    application_name: "videosave-c1-role-bootstrap"
  });
  await admin.connect();
  rolesCreated = true;
  await executeTemplate(admin, "deployment/postgres/roles.sql.example", {
    migration_role: roles.migration,
    web_role: roles.web,
    worker_role: roles.worker
  });
  for (const role of ["migration", "web", "worker"] as const) {
    await admin.query(
      `ALTER ROLE ${quoteIdentifier(roles[role])} PASSWORD ${quotePassword(passwords[role])}`
    );
  }
  await executeTemplate(admin, "deployment/postgres/database.sql.example", {
    database_name: databaseName,
    migration_role: roles.migration
  });
  databaseCreated = true;
  await applyMigrations({
    connectionString: roleUrl("migration"),
    sslMode: "disable",
    nodeEnv: "test",
    schema: "public"
  });
  appAdmin = new Client({
    connectionString: adminDatabaseUrl(),
    ssl: false,
    connectionTimeoutMillis: 5_000,
    application_name: "videosave-c1-grants"
  });
  await appAdmin.connect();
  await executeTemplate(appAdmin, "deployment/postgres/runtime-grants.sql.example", {
    database_name: databaseName,
    migration_role: roles.migration,
    web_role: roles.web,
    worker_role: roles.worker
  });
  cutoverPool = new pg.Pool({
    connectionString: adminDatabaseUrl(),
    ssl: false,
    max: 2,
    options: "-c search_path=public",
    application_name: "videosave-c1-cutover-audit"
  });
});

afterAll(async () => {
  await webRuntime?.close().catch(() => undefined);
  await workerPool?.close().catch(() => undefined);
  await cutoverPool?.end().catch(() => undefined);
  await appAdmin?.end().catch(() => undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (admin) {
    if (databaseCreated) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName]
      ).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`).catch(() => undefined);
    }
    if (rolesCreated) {
      for (const role of [roles.web, roles.worker, roles.migration]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`).catch(() => undefined);
      }
    }
    await admin.end().catch(() => undefined);
  }
});

describe("PostgreSQL Phase A real-role acceptance", () => {
  it("runs web and worker SQL surfaces under separate least-privilege roles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "videosave-c1-role-volume-"));
    roots.push(root);
    await provisionDurableVolumeTestRoot(root, { createPublished: true });
    webRuntime = createProductionWebRuntime(webSource(root), {
      createJobId: (() => {
        let index = 0;
        return () => `job_role_acceptance_${++index}`;
      })()
    });
    await webRuntime.readiness();
    const cancelledJob = await webRuntime.jobs.enqueueDownloadJob({
      url: "https://example.com/cancel.mp4",
      formatId: "direct-source",
      processingPreset: "original",
      rightsConfirmed: true
    });
    expect((await webRuntime.jobs.getDownloadJob(cancelledJob.jobId)).status).toBe("queued");
    expect((await webRuntime.jobs.cancelDownloadJob(cancelledJob.jobId)).status).toBe("cancelled");
    const claimedJob = await webRuntime.jobs.enqueueDownloadJob({
      url: "https://example.com/claim.mp4",
      formatId: "direct-source",
      processingPreset: "original",
      rightsConfirmed: true
    });
    await webRuntime.close();
    webRuntime = null;

    workerPool = createPostgresPool(repositoryConfig(roleUrl("worker")), {
      applicationName: "videosave-c1-worker-role"
    });
    await workerPool.readiness();
    await assertPostgresSchemaCompatible(workerPool.pool);
    const queue = createPostgresJobLeaseQueue({
      database: workerPool.pool,
      leaseDurationMs: 15_000,
      maxRetries: 1,
      terminalTtlMs: 60_000
    });
    const claim = await queue.claimNext(`worker_${"a".repeat(32)}`);
    expect(claim.outcome).toBe("claimed");
    if (claim.outcome !== "claimed") throw new Error("Expected claim.");
    expect(claim.job.record.jobId).toBe(claimedJob.jobId);
    const progressed = await queue.updateProgressOwned(claim.job.lease, 25);
    expect(progressed.outcome).toBe("updated");
    if (progressed.outcome !== "updated") throw new Error("Expected progress update.");
    const artifactRuntime = createPostgresMediaArtifactRuntime({ pool: workerPool.pool });
    const artifactId = `source_${"b".repeat(32)}`;
    const reserved = await artifactRuntime.artifacts.reserveOwned(progressed.lease, {
      artifactId,
      kind: "source",
      object: {
        key: parseMediaStorageKey(
          `jobs/${claimedJob.jobId}/attempts/${progressed.lease.attemptId}/source/input.mp4`
        ),
        sizeBytes: 1,
        checksumSha256: "c".repeat(64),
        modifiedAt: new Date().toISOString()
      },
      filename: "input.mp4",
      contentType: "video/mp4",
      ttlSeconds: 60
    });
    expect(reserved.outcome).toBe("reserved");
    if (reserved.outcome !== "reserved") throw new Error("Expected artifact reservation.");
    await expect(artifactRuntime.artifacts.delete(artifactId, reserved.artifact.version))
      .resolves.toMatchObject({ outcome: "updated" });
    await expect(queue.completeOwned(reserved.lease, {
      type: "failed",
      errorCode: API_ERROR_CODES.PROCESSING_FAILED
    })).resolves.toMatchObject({ outcome: "completed" });
    await expect(workerPool.pool.query(
      "UPDATE media_lifecycle_state SET updated_at = statement_timestamp(), version = version + 1 WHERE singleton_key = 1"
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("allows exact read-only status and cutover audit under the granted boundary", async () => {
    await expect(migrationStatus({
      connectionString: roleUrl("web"), sslMode: "disable", nodeEnv: "test", schema: "public"
    })).resolves.toHaveLength(4);
    await expect(migrationStatus({
      connectionString: roleUrl("worker"), sslMode: "disable", nodeEnv: "test", schema: "public"
    })).resolves.toHaveLength(4);
    await expect(assertPostgresCutoverReady(cutoverPool as Pool, { roles })).resolves.toBeUndefined();
  });

  it("blocks an active migration runner and an unclaimable legacy queue row", async () => {
    await appAdmin?.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY.toString()]);
    try {
      await expect(assertPostgresCutoverReady(cutoverPool as Pool, { roles }))
        .rejects.toThrow("cutover readiness failed");
    } finally {
      await appAdmin?.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY.toString()]);
    }
    await appAdmin?.query(
      `INSERT INTO media_jobs (
         job_id, status, progress, processing_preset, created_at, retry_count, version, available_at
       ) VALUES ('job_unclaimable_cutover', 'queued', 0, 'original', statement_timestamp(), 0, 0,
         statement_timestamp())`
    );
    try {
      await expect(assertPostgresCutoverReady(cutoverPool as Pool, { roles }))
        .rejects.toThrow("cutover readiness failed");
    } finally {
      await appAdmin?.query(
        "DELETE FROM media_jobs WHERE status = 'queued' AND source_url IS NULL AND format_id IS NULL"
      );
    }
  });

  it("rejects runtime DDL, ownership, and schema mutation", async () => {
    const web = createPostgresPool(repositoryConfig(roleUrl("web")), {
      applicationName: "videosave-c1-web-forbidden"
    });
    const worker = createPostgresPool(repositoryConfig(roleUrl("worker")), {
      applicationName: "videosave-c1-worker-forbidden"
    });
    try {
      for (const pool of [web.pool, worker.pool]) {
        await expect(pool.query("CREATE TABLE forbidden_runtime_ddl (id integer)"))
          .rejects.toMatchObject({ code: "42501" });
        await expect(pool.query(`ALTER TABLE media_jobs OWNER TO ${quoteIdentifier(roles.web)}`))
          .rejects.toMatchObject({ code: "42501" });
        await expect(pool.query("DROP TABLE media_lifecycle_state"))
          .rejects.toMatchObject({ code: "42501" });
        await expect(pool.query(`SET ROLE ${quoteIdentifier(roles.migration)}`))
          .rejects.toMatchObject({ code: "42501" });
      }
      await expect(web.pool.query("DELETE FROM media_jobs WHERE false"))
        .rejects.toMatchObject({ code: "42501" });
      await expect(web.pool.query(
        "INSERT INTO media_artifacts (artifact_id) VALUES ('source_forbidden')"
      )).rejects.toMatchObject({ code: "42501" });
      await expect(worker.pool.query(
        "INSERT INTO media_jobs (job_id) VALUES ('job_forbidden')"
      )).rejects.toMatchObject({ code: "42501" });
    } finally {
      await web.close();
      await worker.close();
    }
  });
});
