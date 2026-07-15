import { randomUUID } from "node:crypto";
import pg, { type Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseJobRepositoryConfig } from "@/lib/config/env";
import { API_ERROR_MESSAGES } from "@/lib/errors";
import {
  type JobLeaseQueue,
  type JobLeaseRef,
  type OwnedJobCompletion
} from "@/lib/jobs/job-lease-queue";
import {
  createExplicitJobRepositoryRuntime,
  type ExplicitJobRepositoryRuntime
} from "@/lib/jobs/postgres/factory";
import {
  createPostgresJobLeaseQueue,
  PostgresJobLeaseQueueError
} from "@/lib/jobs/postgres/job-queue";
import {
  createPostgresMediaJobLifecycleMaintenance,
  createPostgresMediaLifecycleElection
} from "@/lib/jobs/postgres/lifecycle-maintenance";
import { getSharedPostgresPool } from "@/lib/jobs/postgres/pool";
import { MIGRATION_ADVISORY_LOCK_KEY } from "@/lib/jobs/postgres/cutover-readiness";
import {
  createPostgresJobRepository,
  PostgresJobRepositoryError
} from "@/lib/jobs/postgres/repository";
import type { JobRepository } from "@/lib/jobs/repository";
import type { MediaJobResult } from "@/lib/jobs/types";
import { API_ERROR_CODES } from "@/lib/types";
import { runJobRepositoryContract } from "@/tests/jobs/job-repository.contract";
import { createTestJobLeaseWorkerHarness } from "@/tests/postgres/support/job-lease-worker-harness";
import {
  applyMigrations,
  migrationStatus
} from "../../scripts/postgres-migrations.mjs";

const { Client } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required; PostgreSQL integration tests were not executed."
  );
}

const schema = `videosave_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const quotedSchema = `"${schema}"`;
const connectionSource = Object.freeze({
  JOB_REPOSITORY_BACKEND: "postgres",
  DATABASE_URL: testDatabaseUrl,
  POSTGRES_SSL_MODE: "disable",
  POSTGRES_POOL_MAX: "5",
  POSTGRES_CONNECTION_TIMEOUT_MS: "5000",
  POSTGRES_STATEMENT_TIMEOUT_MS: "2000",
  POSTGRES_QUERY_TIMEOUT_MS: "3000",
  POSTGRES_IDLE_TIMEOUT_MS: "2000",
  JOB_WORKER_CONCURRENCY: "2",
  JOB_LEASE_DURATION_MS: "15000",
  JOB_LEASE_RENEW_INTERVAL_MS: "5000",
  JOB_RECOVERY_INTERVAL_MS: "5000",
  JOB_MAX_RETRIES: "2",
  NODE_ENV: "test"
});

let bootstrapClient: InstanceType<typeof Client>;
let explicitRuntime: ExplicitJobRepositoryRuntime;
let repository: JobRepository;
let leaseQueue: JobLeaseQueue;
let pool: Pool;
let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
let integrationSchemaCreated = false;

function mediaResult(suffix: string): MediaJobResult {
  const fileId = `file_${suffix}`;
  return {
    fileId,
    downloadUrl: `/api/file/${fileId}`,
    filename: `${suffix}.mp4`,
    sizeBytes: 2048,
    mimeType: "video/mp4",
    expiresAt: "2026-01-01T01:00:00.000Z",
    processingPreset: "original",
    media: {
      durationSeconds: 5,
      formatName: "mp4",
      hasVideo: true,
      hasAudio: true,
      width: 1280,
      height: 720,
      videoCodec: "h264",
      audioCodec: "aac"
    }
  };
}

function durableInput(jobId: string, processingPreset: "original" | "compatible-mp4" = "original") {
  return {
    jobId,
    sourceUrl: `https://example.com/media/${jobId}?quality=best`,
    formatId: "video-1080p",
    processingPreset
  } as const;
}

async function enqueueAndClaim(
  jobId: string,
  workerId = `worker_${"a".repeat(32)}`,
  target: JobLeaseQueue = leaseQueue
) {
  const created = await target.enqueue(durableInput(jobId));
  if (created.outcome !== "created") throw new Error("Expected durable job creation.");
  const claimed = await target.claimNext(workerId);
  if (claimed.outcome !== "claimed") throw new Error("Expected durable job claim.");
  return claimed.job;
}

async function expireLease(jobId: string): Promise<void> {
  await pool.query(
    `UPDATE media_jobs
     SET lease_expires_at = statement_timestamp() - interval '1 second'
     WHERE job_id = $1 AND status = 'running'`,
    [jobId]
  );
}

async function makeRetryAvailable(jobId: string): Promise<void> {
  await pool.query(
    `UPDATE media_jobs SET available_at = statement_timestamp()
     WHERE job_id = $1 AND status = 'queued'`,
    [jobId]
  );
}

async function createRunning(jobId: string, target: JobRepository = repository) {
  const created = await target.create({ jobId, processingPreset: "original" });
  if (created.outcome !== "created") throw new Error("Expected job creation.");
  const started = await target.update(jobId, created.record.version, { type: "start" });
  if (started.outcome !== "updated") throw new Error("Expected job start.");
  return started.record;
}

beforeAll(async () => {
  bootstrapClient = new Client({
    connectionString: testDatabaseUrl,
    ssl: false,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: "videosave-integration-bootstrap"
  });
  await bootstrapClient.connect();
  await bootstrapClient.query(`CREATE SCHEMA ${quotedSchema}`);
  integrationSchemaCreated = true;
  await applyMigrations({
    connectionString: testDatabaseUrl,
    sslMode: "disable",
    nodeEnv: "test",
    schema
  });

  explicitRuntime = createExplicitJobRepositoryRuntime(connectionSource, {
    postgresSchema: schema,
    terminalTtlMs: 60_000,
    now: () => nowMs
  });
  const parsed = parseJobRepositoryConfig(connectionSource);
  if (parsed.backend !== "postgres") throw new Error("Expected PostgreSQL configuration.");
  pool = getSharedPostgresPool(parsed.postgres, { schema }).pool;
  repository = explicitRuntime.repository;
  leaseQueue = createPostgresJobLeaseQueue({
    database: pool,
    leaseDurationMs: 15_000,
    maxRetries: 2,
    terminalTtlMs: 60_000
  });
  await explicitRuntime.readiness();
});

beforeEach(async () => {
  nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  await pool.query("TRUNCATE TABLE media_artifacts, media_jobs");
});

afterAll(async () => {
  await explicitRuntime?.close().catch(() => undefined);
  if (bootstrapClient) {
    if (integrationSchemaCreated) {
      await bootstrapClient.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    }
    await bootstrapClient.end().catch(() => undefined);
  }
});

runJobRepositoryContract("postgres", () => ({
  repository,
  now: () => nowMs,
  advanceBy(milliseconds: number) {
    nowMs += milliseconds;
  }
}));

describe("PostgreSQL migrations and schema", () => {
  it("does not create a missing schema while reporting migration status", async () => {
    const missingSchema = `${schema}_status_missing`;
    await expect(migrationStatus({
      connectionString: testDatabaseUrl,
      sslMode: "disable",
      nodeEnv: "test",
      schema: missingSchema
    })).resolves.toEqual([
      { version: "001", status: "pending" },
      { version: "002", status: "pending" },
      { version: "003", status: "pending" },
      { version: "004", status: "pending" }
    ]);
    await expect(bootstrapClient.query(
      "SELECT count(*)::int AS count FROM pg_catalog.pg_namespace WHERE nspname = $1",
      [missingSchema]
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("keeps status strictly read-only on a pristine schema", async () => {
    const statusSchema = `${schema}_readonly_status`;
    const quotedStatusSchema = `"${statusSchema}"`;
    await bootstrapClient.query(`CREATE SCHEMA ${quotedStatusSchema}`);
    try {
      const before = await bootstrapClient.query(
        "SELECT count(*)::int AS count FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = $1",
        [statusSchema]
      );
      const searchPathBefore = await bootstrapClient.query("SHOW search_path");
      const locksBefore = await bootstrapClient.query(
        `SELECT count(*)::int AS count
         FROM pg_catalog.pg_locks
         WHERE locktype = 'advisory' AND granted AND objsubid = 1
           AND ((classid::bigint << 32) | objid::bigint) = $1::bigint`,
        [MIGRATION_ADVISORY_LOCK_KEY.toString()]
      );
      await expect(migrationStatus({
        connectionString: testDatabaseUrl,
        sslMode: "disable",
        nodeEnv: "test",
        schema: statusSchema
      })).resolves.toEqual([
        { version: "001", status: "pending" },
        { version: "002", status: "pending" },
        { version: "003", status: "pending" },
        { version: "004", status: "pending" }
      ]);
      const after = await bootstrapClient.query(
        "SELECT count(*)::int AS count FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = $1",
        [statusSchema]
      );
      expect(after.rows).toEqual(before.rows);
      const locksAfter = await bootstrapClient.query(
        `SELECT count(*)::int AS count
         FROM pg_catalog.pg_locks
         WHERE locktype = 'advisory' AND granted AND objsubid = 1
           AND ((classid::bigint << 32) | objid::bigint) = $1::bigint`,
        [MIGRATION_ADVISORY_LOCK_KEY.toString()]
      );
      expect(locksAfter.rows).toEqual(locksBefore.rows);
      expect((await bootstrapClient.query("SHOW search_path")).rows).toEqual(searchPathBefore.rows);
      expect((await bootstrapClient.query("SELECT to_regclass($1)::text AS history", [
        `${statusSchema}._videosave_migrations`
      ])).rows[0]).toEqual({ history: null });
    } finally {
      await bootstrapClient.query(`DROP SCHEMA ${quotedStatusSchema} CASCADE`);
    }
  });

  it("reports the migration as applied and a repeated apply as current", async () => {
    const options = {
      connectionString: testDatabaseUrl,
      sslMode: "disable",
      nodeEnv: "test",
      schema
    };
    await expect(applyMigrations(options)).resolves.toEqual({ total: 4, applied: [] });
    await expect(migrationStatus(options)).resolves.toEqual([
      { version: "001", status: "applied" },
      { version: "002", status: "applied" },
      { version: "003", status: "applied" },
      { version: "004", status: "applied" }
    ]);
  });

  it("serializes concurrent migration runners with the advisory lock", async () => {
    const migrationSchema = `${schema}_migration_lock`;
    const quotedMigrationSchema = `"${migrationSchema}"`;
    await bootstrapClient.query(`CREATE SCHEMA ${quotedMigrationSchema}`);
    try {
      const options = {
        connectionString: testDatabaseUrl,
        sslMode: "disable",
        nodeEnv: "test",
        schema: migrationSchema
      };
      const results = await Promise.all([applyMigrations(options), applyMigrations(options)]);
      expect(results.flatMap((result) => result.applied)).toEqual(["001", "002", "003", "004"]);
      await expect(migrationStatus(options)).resolves.toEqual([
        { version: "001", status: "applied" },
        { version: "002", status: "applied" },
        { version: "003", status: "applied" },
        { version: "004", status: "applied" }
      ]);
    } finally {
      await bootstrapClient.query(`DROP SCHEMA ${quotedMigrationSchema} CASCADE`);
    }
  });

  it("stores migration history and creates only the intended operational indexes", async () => {
    const history = await pool.query(
      "SELECT version, checksum FROM _videosave_migrations ORDER BY version"
    );
    expect(history.rows).toHaveLength(4);
    expect(history.rows).toEqual([
      { version: "001", checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: "002", checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: "003", checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: "004", checksum: expect.stringMatching(/^[a-f0-9]{64}$/) }
    ]);

    const indexes = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'media_jobs' ORDER BY indexname`,
      [schema]
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "media_jobs_active_deadline_idx",
      "media_jobs_claim_fifo_idx",
      "media_jobs_expired_lease_idx",
      "media_jobs_expires_at_idx",
      "media_jobs_pkey",
      "media_jobs_status_idx"
    ]);
    const artifactIndexes = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'media_artifacts' ORDER BY indexname`,
      [schema]
    );
    expect(artifactIndexes.rows.map((row) => row.indexname)).toEqual([
      "media_artifacts_expiry_cleanup_idx",
      "media_artifacts_job_attempt_kind_key",
      "media_artifacts_job_id_idx",
      "media_artifacts_one_published_final_per_job_idx",
      "media_artifacts_pkey",
      "media_artifacts_reconciliation_idx",
      "media_artifacts_storage_key_key"
    ]);
  });

  it("detects a changed checksum without exposing the connection URL", async () => {
    const original = await pool.query(
      "SELECT checksum FROM _videosave_migrations WHERE version = $1",
      ["001"]
    );
    await pool.query(
      "UPDATE _videosave_migrations SET checksum = $1 WHERE version = $2",
      ["0".repeat(64), "001"]
    );
    try {
      await expect(
        migrationStatus({
          connectionString: testDatabaseUrl,
          sslMode: "disable",
          nodeEnv: "test",
          schema
        })
      ).rejects.toThrow("checksum");
    } finally {
      await pool.query(
        "UPDATE _videosave_migrations SET checksum = $1 WHERE version = $2",
        [original.rows[0].checksum, "001"]
      );
    }
  });

  it("fails closed for missing and unknown migration history", async () => {
    const removed = await pool.query(
      "DELETE FROM _videosave_migrations WHERE version = '004' RETURNING version, checksum, applied_at"
    );
    try {
      await expect(migrationStatus({
        connectionString: testDatabaseUrl,
        sslMode: "disable",
        nodeEnv: "test",
        schema
      })).resolves.toContainEqual({ version: "004", status: "pending" });
    } finally {
      await pool.query(
        "INSERT INTO _videosave_migrations (version, checksum, applied_at) VALUES ($1, $2, $3)",
        [removed.rows[0].version, removed.rows[0].checksum, removed.rows[0].applied_at]
      );
    }
    await pool.query(
      "INSERT INTO _videosave_migrations (version, checksum) VALUES ('999', $1)",
      ["9".repeat(64)]
    );
    try {
      await expect(migrationStatus({
        connectionString: testDatabaseUrl,
        sslMode: "disable",
        nodeEnv: "test",
        schema
      })).rejects.toThrow("not present");
    } finally {
      await pool.query("DELETE FROM _videosave_migrations WHERE version = '999'");
    }
  });
});

describe("PostgreSQL repository integration", () => {
  it("uses a fixed search_path and applies statement timeout to pooled connections", async () => {
    const client = await pool.connect();
    try {
      const settings = await client.query(
        "SELECT current_schema() AS schema, current_setting('statement_timeout') AS statement_timeout"
      );
      expect(settings.rows[0]).toEqual({ schema, statement_timeout: "2s" });
    } finally {
      client.release();
    }
  });

  it("enforces enum, numeric and lease-pair constraints in PostgreSQL", async () => {
    const created = await repository.create({
      jobId: "job_database_constraints",
      processingPreset: "original"
    });
    if (created.outcome !== "created") throw new Error("Expected job creation.");
    const violations: readonly [string, unknown][] = [
      ["UPDATE media_jobs SET status = $1 WHERE job_id = $2", "claimed"],
      ["UPDATE media_jobs SET processing_preset = $1 WHERE job_id = $2", "fast"],
      ["UPDATE media_jobs SET progress = $1::double precision WHERE job_id = $2", "NaN"],
      ["UPDATE media_jobs SET retry_count = $1 WHERE job_id = $2", -1],
      ["UPDATE media_jobs SET version = $1 WHERE job_id = $2", -1],
      ["UPDATE media_jobs SET lease_owner = $1 WHERE job_id = $2", "worker_without_expiry"]
    ];
    for (const [sql, value] of violations) {
      await expect(
        pool.query(sql, [value, created.record.jobId])
      ).rejects.toMatchObject({ code: "23514" });
    }
    expect(await repository.get(created.record.jobId)).toEqual(created.record);
  });

  it("uses two real connections and permits exactly one same-version write", async () => {
    const running = await createRunning("job_two_connections");
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    try {
      const backendIds = await Promise.all([
        firstClient.query("SELECT pg_backend_pid() AS pid"),
        secondClient.query("SELECT pg_backend_pid() AS pid")
      ]);
      expect(backendIds[0].rows[0].pid).not.toBe(backendIds[1].rows[0].pid);

      const firstRepository = createPostgresJobRepository({
        database: firstClient,
        terminalTtlMs: 60_000,
        now: () => nowMs
      });
      const secondRepository = createPostgresJobRepository({
        database: secondClient,
        terminalTtlMs: 60_000,
        now: () => nowMs
      });
      const reads = await Promise.all([
        firstRepository.get(running.jobId),
        secondRepository.get(running.jobId)
      ]);
      expect(reads[0]?.version).toBe(running.version);
      expect(reads[1]?.version).toBe(running.version);

      const writes = await Promise.all([
        firstRepository.update(running.jobId, running.version, { type: "progress", progress: 40 }),
        secondRepository.update(running.jobId, running.version, { type: "progress", progress: 60 })
      ]);
      expect(writes.filter((write) => write.outcome === "updated")).toHaveLength(1);
      expect(writes.filter((write) => write.outcome === "version-conflict")).toHaveLength(1);
      expect((await repository.get(running.jobId))?.version).toBe(running.version + 1);
    } finally {
      firstClient.release();
      secondClient.release();
    }
  });

  it("fences a cancellation/completion race without a cancelled-to-ready transition", async () => {
    const running = await createRunning("job_cancel_complete_race");
    const firstClient: PoolClient = await pool.connect();
    const secondClient: PoolClient = await pool.connect();
    try {
      const cancelling = createPostgresJobRepository({ database: firstClient, now: () => nowMs });
      const completing = createPostgresJobRepository({ database: secondClient, now: () => nowMs });
      const outcomes = await Promise.all([
        cancelling.requestCancellation(running.jobId, running.version),
        completing.update(running.jobId, running.version, {
          type: "complete",
          result: mediaResult("race")
        })
      ]);
      expect(outcomes.filter((outcome) => outcome.outcome === "updated")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.outcome === "version-conflict")).toHaveLength(1);

      const final = await repository.get(running.jobId);
      expect(["ready", "cancelled"]).toContain(final?.status);
      if (final?.status === "cancelled") {
        await expect(
          repository.update(final.jobId, final.version, {
            type: "complete",
            result: mediaResult("forbidden")
          })
        ).resolves.toMatchObject({ outcome: "invalid-state", record: { status: "cancelled" } });
      }
    } finally {
      firstClient.release();
      secondClient.release();
    }
  });

  it("keeps SQL injection payloads in parameters and leaves the table intact", async () => {
    const running = await createRunning("job_sql_metadata");
    const filename = "source'); DROP TABLE media_jobs; --.mp4";
    const updated = await repository.update(running.jobId, running.version, {
      type: "set-source-metadata",
      sourceMetadata: {
        sourceId: "source_sql_metadata",
        filename,
        sizeBytes: 1234,
        contentType: "video/mp4"
      }
    });
    expect(updated).toMatchObject({
      outcome: "updated",
      record: { sourceMetadata: { filename } }
    });
    expect(await repository.get("job'; DROP TABLE media_jobs; --")).toBeNull();
    await expect(pool.query("SELECT count(*) FROM media_jobs")).resolves.toMatchObject({ rowCount: 1 });
  });

  it("fails closed on malformed stored JSON and sanitizes the thrown error", async () => {
    const running = await createRunning("job_malformed_row");
    await pool.query("UPDATE media_jobs SET source_metadata = $1::jsonb WHERE job_id = $2", [
      "{}",
      running.jobId
    ]);
    const failure = repository.get(running.jobId);
    await expect(failure).rejects.toBeInstanceOf(PostgresJobRepositoryError);
    await expect(failure).rejects.not.toThrow(testDatabaseUrl);
  });

  it("stores only canonical failure data", async () => {
    const running = await createRunning("job_canonical_error");
    const failed = await repository.update(running.jobId, running.version, {
      type: "fail",
      errorCode: API_ERROR_CODES.PROCESSING_FAILED
    });
    expect(failed).toMatchObject({
      outcome: "updated",
      record: {
        canonicalError: {
          code: API_ERROR_CODES.PROCESSING_FAILED,
          message: API_ERROR_MESSAGES.PROCESSING_FAILED
        }
      }
    });
  });
});

describe("PostgreSQL durable queue and lease integration", () => {
  const workerA = `worker_${"a".repeat(32)}`;
  const workerB = `worker_${"b".repeat(32)}`;
  const workerC = `worker_${"c".repeat(32)}`;

  it("atomically enqueues one authoritative row without overwriting a duplicate payload", async () => {
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    try {
      const firstQueue = createPostgresJobLeaseQueue({
        database: firstClient,
        leaseDurationMs: 15_000,
        maxRetries: 2
      });
      const secondQueue = createPostgresJobLeaseQueue({
        database: secondClient,
        leaseDurationMs: 15_000,
        maxRetries: 2
      });
      const results = await Promise.all([
        firstQueue.enqueue({
          ...durableInput("job_enqueue_once"),
          sourceUrl: "https://example.com/first"
        }),
        secondQueue.enqueue({
          ...durableInput("job_enqueue_once"),
          sourceUrl: "https://example.com/second"
        })
      ]);
      expect(results.filter((result) => result.outcome === "created")).toHaveLength(1);
      expect(results.filter((result) => result.outcome === "duplicate")).toHaveLength(1);
      const stored = await pool.query(
        "SELECT count(*)::integer AS count, min(source_url) AS source_url FROM media_jobs WHERE job_id = $1",
        ["job_enqueue_once"]
      );
      expect(stored.rows[0].count).toBe(1);
      expect([
        "https://example.com/first",
        "https://example.com/second"
      ]).toContain(stored.rows[0].source_url);
    } finally {
      firstClient.release();
      secondClient.release();
    }
  });

  it("claims eligible jobs FIFO by created_at and job_id", async () => {
    await leaseQueue.enqueue(durableInput("job_fifo_b"));
    await leaseQueue.enqueue(durableInput("job_fifo_a"));
    await pool.query(
      "UPDATE media_jobs SET created_at = $1::timestamptz WHERE job_id = ANY($2::text[])",
      ["2026-01-01T00:00:00.000Z", ["job_fifo_a", "job_fifo_b"]]
    );

    const first = await leaseQueue.claimNext(workerA);
    const second = await leaseQueue.claimNext(workerB);
    expect(first).toMatchObject({ outcome: "claimed", job: { record: { jobId: "job_fifo_a" } } });
    expect(second).toMatchObject({ outcome: "claimed", job: { record: { jobId: "job_fifo_b" } } });
  });

  it("lets two real connections claim different jobs", async () => {
    await leaseQueue.enqueue(durableInput("job_claim_multi_a"));
    await leaseQueue.enqueue(durableInput("job_claim_multi_b"));
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    try {
      const firstQueue = createPostgresJobLeaseQueue({
        database: firstClient,
        leaseDurationMs: 15_000,
        maxRetries: 2
      });
      const secondQueue = createPostgresJobLeaseQueue({
        database: secondClient,
        leaseDurationMs: 15_000,
        maxRetries: 2
      });
      const [first, second] = await Promise.all([
        firstQueue.claimNext(workerA),
        secondQueue.claimNext(workerB)
      ]);
      expect(first.outcome).toBe("claimed");
      expect(second.outcome).toBe("claimed");
      if (first.outcome !== "claimed" || second.outcome !== "claimed") return;
      expect(first.job.record.jobId).not.toBe(second.job.record.jobId);
    } finally {
      firstClient.release();
      secondClient.release();
    }
  });

  it("never gives one job to two concurrent claimers", async () => {
    await leaseQueue.enqueue(durableInput("job_claim_once"));
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    try {
      const queues = [firstClient, secondClient].map((database) =>
        createPostgresJobLeaseQueue({ database, leaseDurationMs: 15_000, maxRetries: 2 })
      );
      const claims = await Promise.all([
        queues[0].claimNext(workerA),
        queues[1].claimNext(workerB)
      ]);
      expect(claims.filter((claim) => claim.outcome === "claimed")).toHaveLength(1);
      expect(claims.filter((claim) => claim.outcome === "empty")).toHaveLength(1);
    } finally {
      firstClient.release();
      secondClient.release();
    }
  });

  it("does not let an active lease be claimed again", async () => {
    const claimed = await enqueueAndClaim("job_active_lease", workerA);
    await expect(leaseQueue.claimNext(workerB)).resolves.toEqual({ outcome: "empty" });
    await expect(leaseQueue.recoverExpiredLeases()).resolves.toEqual({
      requeued: [],
      failed: []
    });
    expect((await repository.get(claimed.record.jobId))?.leaseOwner).toBe(workerA);
  });

  it("renews only the current owner and fences stale versions", async () => {
    const claimed = await enqueueAndClaim("job_lease_fence", workerA);
    const foreignLease: JobLeaseRef = { ...claimed.lease, workerId: workerB };
    const foreignAttempt: JobLeaseRef = { ...claimed.lease, attemptId: `attempt_${"f".repeat(32)}` };
    await expect(leaseQueue.renewLease(foreignLease)).resolves.toEqual({
      outcome: "ownership-lost"
    });
    await expect(leaseQueue.renewLease(foreignAttempt)).resolves.toEqual({
      outcome: "ownership-lost"
    });

    const renewed = await leaseQueue.renewLease(claimed.lease);
    expect(renewed).toMatchObject({
      outcome: "updated",
      record: { version: claimed.record.version + 1, leaseOwner: workerA }
    });
    if (renewed.outcome !== "updated") return;
    expect(Date.parse(renewed.lease.leaseExpiresAt)).toBeGreaterThanOrEqual(
      Date.parse(claimed.lease.leaseExpiresAt)
    );
    await expect(leaseQueue.updateProgressOwned(claimed.lease, 10)).resolves.toEqual({
      outcome: "ownership-lost"
    });
    await expect(
      leaseQueue.updateProgressOwned({ ...renewed.lease, workerId: workerB }, 10)
    ).resolves.toEqual({ outcome: "ownership-lost" });
    await expect(
      leaseQueue.completeOwned(claimed.lease, { type: "ready", result: mediaResult("stale") })
    ).resolves.toEqual({ outcome: "ownership-lost" });
    await expect(
      leaseQueue.completeOwned(
        { ...renewed.lease, workerId: workerB },
        { type: "ready", result: mediaResult("foreign") }
      )
    ).resolves.toEqual({ outcome: "ownership-lost" });
  });

  it("applies valid owned metadata, monotonic progress and ready completion", async () => {
    const claimed = await enqueueAndClaim("job_owned_success", workerA);
    const metadata = await leaseQueue.setSourceMetadataOwned(claimed.lease, {
      sourceId: "source_owned_success",
      filename: "source.mp4",
      sizeBytes: 4096,
      contentType: "video/mp4"
    });
    expect(metadata).toMatchObject({ outcome: "updated", record: { sourceMetadata: { sourceId: "source_owned_success" } } });
    if (metadata.outcome !== "updated") return;
    const progressed = await leaseQueue.updateProgressOwned(metadata.lease, 55);
    expect(progressed).toMatchObject({ outcome: "updated", record: { progress: 55 } });
    if (progressed.outcome !== "updated") return;
    await expect(
      leaseQueue.updateProgressOwned(progressed.lease, Number.NaN)
    ).resolves.toMatchObject({ outcome: "invalid-state", record: { progress: 55 } });
    await expect(leaseQueue.updateProgressOwned(progressed.lease, 54)).resolves.toMatchObject({
      outcome: "invalid-state",
      record: { progress: 55 }
    });
    const ready = await leaseQueue.completeOwned(progressed.lease, {
      type: "ready",
      result: mediaResult("owned_success")
    });
    expect(ready).toMatchObject({
      outcome: "completed",
      record: { status: "ready", progress: 100, leaseOwner: null, leaseExpiresAt: null }
    });
  });

  it("supports fenced failed and cancelled worker completions", async () => {
    const failedClaim = await enqueueAndClaim("job_owned_failed", workerA);
    await expect(
      leaseQueue.completeOwned(failedClaim.lease, {
        type: "failed",
        errorCode: API_ERROR_CODES.PROCESSING_FAILED
      })
    ).resolves.toMatchObject({ outcome: "completed", record: { status: "failed" } });

    const cancelledClaim = await enqueueAndClaim("job_owned_cancelled", workerB);
    await expect(
      leaseQueue.completeOwned(cancelledClaim.lease, { type: "cancelled" })
    ).resolves.toMatchObject({ outcome: "completed", record: { status: "cancelled" } });
  });

  it("makes an exact duplicate completion idempotent", async () => {
    const claimed = await enqueueAndClaim("job_duplicate_completion", workerA);
    const completion: OwnedJobCompletion = {
      type: "ready",
      result: mediaResult("duplicate_completion")
    };
    await expect(leaseQueue.completeOwned(claimed.lease, completion)).resolves.toMatchObject({
      outcome: "completed"
    });
    await expect(leaseQueue.completeOwned(claimed.lease, completion)).resolves.toMatchObject({
      outcome: "already-completed",
      record: { status: "ready" }
    });
  });

  it("cancels a queued job before claim and is idempotent", async () => {
    const created = await leaseQueue.enqueue(durableInput("job_cancel_queued"));
    if (created.outcome !== "created") throw new Error("Expected durable job creation.");
    const first = await leaseQueue.requestCancellation(created.record.jobId);
    expect(first).toMatchObject({
      outcome: "cancelled",
      record: { status: "cancelled", cancellationRequestedAt: expect.any(String) }
    });
    await expect(leaseQueue.requestCancellation(created.record.jobId)).resolves.toMatchObject({
      outcome: "unchanged",
      record: { status: "cancelled" }
    });
    await expect(leaseQueue.claimNext(workerA)).resolves.toEqual({ outcome: "empty" });
  });

  it("clears a running lease on cancellation and rejects the late worker", async () => {
    const claimed = await enqueueAndClaim("job_cancel_running", workerA);
    await expect(leaseQueue.requestCancellation(claimed.record.jobId)).resolves.toMatchObject({
      outcome: "cancelled",
      record: { status: "cancelled", leaseOwner: null, leaseExpiresAt: null }
    });
    await expect(leaseQueue.renewLease(claimed.lease)).resolves.toMatchObject({
      outcome: "cancelled",
      record: { status: "cancelled" }
    });
    await expect(
      leaseQueue.completeOwned(claimed.lease, {
        type: "ready",
        result: mediaResult("cancelled_late")
      })
    ).resolves.toMatchObject({ outcome: "invalid-state", record: { status: "cancelled" } });
  });

  it("keeps optimistic repository cancellation compatible with a durable queue row", async () => {
    const claimed = await enqueueAndClaim("job_repository_cancel_durable", workerA);
    const cancellingRepository = createPostgresJobRepository({
      database: pool,
      terminalTtlMs: 60_000,
      now: Date.now
    });
    await expect(
      cancellingRepository.requestCancellation(claimed.record.jobId, claimed.record.version)
    ).resolves.toMatchObject({
      outcome: "updated",
      record: { status: "cancelled", leaseOwner: null, leaseExpiresAt: null }
    });
    const stored = await pool.query(
      "SELECT source_url, format_id FROM media_jobs WHERE job_id = $1",
      [claimed.record.jobId]
    );
    expect(stored.rows[0]).toEqual({ source_url: null, format_id: null });
  });

  it("fences a real cancellation/completion race", async () => {
    const claimed = await enqueueAndClaim("job_owned_cancel_race", workerA);
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    try {
      const cancelling = createPostgresJobLeaseQueue({
        database: firstClient,
        leaseDurationMs: 15_000,
        maxRetries: 2
      });
      const completing = createPostgresJobLeaseQueue({
        database: secondClient,
        leaseDurationMs: 15_000,
        maxRetries: 2
      });
      await Promise.all([
        cancelling.requestCancellation(claimed.record.jobId),
        completing.completeOwned(claimed.lease, {
          type: "ready",
          result: mediaResult("owned_cancel_race")
        })
      ]);
      const final = await repository.get(claimed.record.jobId);
      expect(["ready", "cancelled"]).toContain(final?.status);
      expect(final?.leaseOwner).toBeNull();
      expect(final?.version).toBe(claimed.record.version + 1);
    } finally {
      firstClient.release();
      secondClient.release();
    }
  });

  it("recovers an expired lease, increments retryCount and rejects the old owner", async () => {
    const claimed = await enqueueAndClaim("job_recover_once", workerA);
    await expireLease(claimed.record.jobId);
    await expect(leaseQueue.renewLease(claimed.lease)).resolves.toEqual({
      outcome: "ownership-lost"
    });
    const recovered = await leaseQueue.recoverExpiredLeases();
    expect(recovered).toMatchObject({
      requeued: [{ status: "queued", retryCount: 1, leaseOwner: null, startedAt: null }],
      failed: []
    });
    await expect(leaseQueue.recoverExpiredLeases()).resolves.toEqual({
      requeued: [],
      failed: []
    });
    await expect(
      leaseQueue.completeOwned(claimed.lease, {
        type: "ready",
        result: mediaResult("recovered_stale")
      })
    ).resolves.toEqual({ outcome: "ownership-lost" });
    await makeRetryAvailable(claimed.record.jobId);
    await expect(leaseQueue.claimNext(workerB)).resolves.toMatchObject({
      outcome: "claimed",
      job: { record: { retryCount: 1, progress: claimed.record.progress } }
    });
  });

  it("fails canonically after the configured retry budget is exhausted", async () => {
    let claimed = await enqueueAndClaim("job_retry_exhaustion", workerA);
    await expireLease(claimed.record.jobId);
    await expect(leaseQueue.recoverExpiredLeases()).resolves.toMatchObject({
      requeued: [{ retryCount: 1 }],
      failed: []
    });
    await makeRetryAvailable(claimed.record.jobId);
    const second = await leaseQueue.claimNext(workerB);
    if (second.outcome !== "claimed") throw new Error("Expected second attempt.");
    claimed = second.job;
    await expireLease(claimed.record.jobId);
    await expect(leaseQueue.recoverExpiredLeases()).resolves.toMatchObject({
      requeued: [{ retryCount: 2 }],
      failed: []
    });
    await makeRetryAvailable(claimed.record.jobId);
    const third = await leaseQueue.claimNext(workerC);
    if (third.outcome !== "claimed") throw new Error("Expected third attempt.");
    await expireLease(third.job.record.jobId);
    await expect(leaseQueue.recoverExpiredLeases()).resolves.toMatchObject({
      requeued: [],
      failed: [
        {
          status: "failed",
          retryCount: 2,
          canonicalError: {
            code: API_ERROR_CODES.PROCESSING_FAILED,
            message: API_ERROR_MESSAGES.PROCESSING_FAILED
          },
          leaseOwner: null
        }
      ]
    });
  });

  it("serializes lease expiry/recovery against late completion on real connections", async () => {
    const claimed = await enqueueAndClaim("job_expiry_completion_race", workerA);
    await expireLease(claimed.record.jobId);
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    try {
      const recovering = createPostgresJobLeaseQueue({
        database: firstClient,
        leaseDurationMs: 15_000,
        maxRetries: 2
      });
      const completing = createPostgresJobLeaseQueue({
        database: secondClient,
        leaseDurationMs: 15_000,
        maxRetries: 2
      });
      const [recovery, completion] = await Promise.all([
        recovering.recoverExpiredLeases(),
        completing.completeOwned(claimed.lease, {
          type: "ready",
          result: mediaResult("expiry_race")
        })
      ]);
      expect(recovery.requeued).toHaveLength(1);
      expect(completion).toEqual({ outcome: "ownership-lost" });
      expect((await repository.get(claimed.record.jobId))?.status).toBe("queued");
    } finally {
      firstClient.release();
      secondClient.release();
    }
  });

  it("never claims terminal jobs or legacy rows without a payload", async () => {
    const legacy = await repository.create({
      jobId: "job_legacy_without_payload",
      processingPreset: "original"
    });
    expect(legacy.outcome).toBe("created");
    const terminal = await enqueueAndClaim("job_terminal_not_claimed", workerA);
    await leaseQueue.completeOwned(terminal.lease, {
      type: "failed",
      errorCode: API_ERROR_CODES.PROCESSING_FAILED
    });
    await expect(leaseQueue.claimNext(workerB)).resolves.toEqual({ outcome: "empty" });
  });

  it("keeps the durable payload private from repository records and serializers", async () => {
    const created = await leaseQueue.enqueue(
      durableInput("job_private_payload", "compatible-mp4")
    );
    if (created.outcome !== "created") throw new Error("Expected durable job creation.");
    const publicRecord = await repository.get(created.record.jobId);
    expect(publicRecord).not.toHaveProperty("sourceUrl");
    expect(publicRecord).not.toHaveProperty("formatId");
    expect(JSON.stringify(publicRecord)).not.toContain("example.com/media");
    const stored = await pool.query(
      "SELECT source_url, format_id FROM media_jobs WHERE job_id = $1",
      [created.record.jobId]
    );
    expect(stored.rows[0]).toEqual({
      source_url: expect.stringContaining("example.com/media"),
      format_id: "video-1080p"
    });
  });

  it("fails closed when a stored payload violates worker URL policy", async () => {
    await leaseQueue.enqueue(durableInput("job_malformed_payload"));
    await pool.query("UPDATE media_jobs SET source_url = $1 WHERE job_id = $2", [
      "http://127.0.0.1/private",
      "job_malformed_payload"
    ]);
    const claim = leaseQueue.claimNext(workerA);
    await expect(claim).rejects.toBeInstanceOf(PostgresJobLeaseQueueError);
    await expect(claim).rejects.not.toThrow("127.0.0.1");
  });

  it("keeps SQL-injection-shaped payload values inside parameters", async () => {
    const created = await leaseQueue.enqueue({
      jobId: "job_queue_sql_parameters",
      sourceUrl: "https://example.com/video?q=');%20DROP%20TABLE%20media_jobs;%20--",
      formatId: "safe-format",
      processingPreset: "original"
    });
    expect(created.outcome).toBe("created");
    await expect(pool.query("SELECT count(*) FROM media_jobs")).resolves.toMatchObject({
      rowCount: 1
    });
  });

  it("runs fake processors with bounded concurrency and closes harness timers", async () => {
    for (let index = 0; index < 5; index += 1) {
      await leaseQueue.enqueue(durableInput(`job_harness_${index}`));
    }
    let active = 0;
    let maximumActive = 0;
    const harness = createTestJobLeaseWorkerHarness({
      queue: leaseQueue,
      concurrency: 2,
      renewalIntervalMs: 20,
      recoveryIntervalMs: 20,
      async processor({ job, signal, updateProgress }) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 35);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              },
              { once: true }
            );
          });
          await updateProgress(50);
          return { type: "ready", result: mediaResult(job.record.jobId) };
        } finally {
          active -= 1;
        }
      }
    });
    await harness.runUntilIdle();
    await harness.stop();
    expect(maximumActive).toBe(2);
    expect(active).toBe(0);
    expect((await repository.list()).filter((record) => record.status === "ready")).toHaveLength(5);
  });

  it("aborts a fake running processor after persistent cancellation", async () => {
    await leaseQueue.enqueue(durableInput("job_harness_cancel"));
    let started!: () => void;
    const processorStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let observedAbort = false;
    const harness = createTestJobLeaseWorkerHarness({
      queue: leaseQueue,
      concurrency: 1,
      renewalIntervalMs: 10,
      recoveryIntervalMs: 20,
      async processor({ signal }) {
        started();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            },
            { once: true }
          );
        });
        return { type: "failed", errorCode: API_ERROR_CODES.PROCESSING_FAILED };
      }
    });
    const running = harness.runUntilIdle();
    await processorStarted;
    await leaseQueue.requestCancellation("job_harness_cancel");
    await running;
    await harness.stop();
    expect(observedAbort).toBe(true);
    expect((await repository.get("job_harness_cancel"))?.status).toBe("cancelled");
  });
});

describe("PostgreSQL lifecycle coordination", () => {
  const workerA = `worker_${"1".repeat(32)}`;
  const workerB = `worker_${"2".repeat(32)}`;

  it("keeps a recovered job unavailable until its persistent availableAt", async () => {
    const claimed = await enqueueAndClaim("job_persistent_backoff", workerA);
    await expireLease(claimed.record.jobId);
    await expect(leaseQueue.recoverExpiredLeases()).resolves.toMatchObject({
      requeued: [{ jobId: claimed.record.jobId, retryCount: 1 }],
      failed: []
    });
    await expect(leaseQueue.claimNext(workerB)).resolves.toEqual({ outcome: "empty" });
    const timing = await pool.query<{ delayed: boolean }>(
      `SELECT available_at > statement_timestamp() AS delayed
       FROM media_jobs WHERE job_id = $1`,
      [claimed.record.jobId]
    );
    expect(timing.rows[0]?.delayed).toBe(true);
    await makeRetryAvailable(claimed.record.jobId);
    await expect(leaseQueue.claimNext(workerB)).resolves.toMatchObject({ outcome: "claimed" });
  });

  it("preserves the monotonic progress high-water mark across retry recovery", async () => {
    const claimed = await enqueueAndClaim("job_retry_progress", workerA);
    const progressed = await leaseQueue.updateProgressOwned(claimed.lease, 63);
    if (progressed.outcome !== "updated") throw new Error("Expected owned progress update.");
    await expireLease(claimed.record.jobId);
    const recovered = await leaseQueue.recoverExpiredLeases();
    expect(recovered.requeued[0]).toMatchObject({
      jobId: claimed.record.jobId,
      progress: 63,
      retryCount: 1
    });
    expect((await repository.get(claimed.record.jobId))?.progress).toBe(63);
  });

  it("expires an overdue active job in a bounded idempotent sweep", async () => {
    const created = await leaseQueue.enqueue(durableInput("job_lifecycle_deadline"));
    expect(created.outcome).toBe("created");
    await pool.query(
      `UPDATE media_jobs
       SET created_at = statement_timestamp() - interval '2 seconds',
           available_at = statement_timestamp() - interval '2 seconds',
           deadline_at = statement_timestamp() - interval '1 second'
       WHERE job_id = $1`,
      ["job_lifecycle_deadline"]
    );
    const maintenance = createPostgresMediaJobLifecycleMaintenance(pool);
    await expect(maintenance.expireOverdueActiveJobs(1)).resolves.toMatchObject([
      {
        jobId: "job_lifecycle_deadline",
        status: "expired",
        canonicalError: { code: API_ERROR_CODES.PROCESSING_TIMEOUT }
      }
    ]);
    await expect(maintenance.expireOverdueActiveJobs(1)).resolves.toEqual([]);
    await expect(leaseQueue.claimNext(workerA)).resolves.toEqual({ outcome: "empty" });
  });

  it("elects exactly one session-scoped coordinator and allows reelection", async () => {
    const firstElection = createPostgresMediaLifecycleElection(pool);
    const secondElection = createPostgresMediaLifecycleElection(pool);
    const [first, second] = await Promise.all([
      firstElection.tryAcquire(),
      secondElection.tryAcquire()
    ]);
    const leaders = [first, second].filter((candidate) => candidate !== null);
    expect(leaders).toHaveLength(1);
    expect(await leaders[0]?.verify()).toBe(true);
    await leaders[0]?.release();
    const replacement = await secondElection.tryAcquire();
    expect(replacement).not.toBeNull();
    expect(await replacement?.verify()).toBe(true);
    await replacement?.release();
  });

  it("stores monotonic lifecycle checkpoints without process-local authority", async () => {
    const maintenance = createPostgresMediaJobLifecycleMaintenance(pool);
    const before = await maintenance.getCheckpoint();
    const after = await maintenance.recordCheckpoint({ recovery: true, fullSweep: true });
    expect(after.version).toBe(before.version + 1);
    expect(after.lastRecoveryAt).not.toBeNull();
    expect(after.lastFullSweepAt).not.toBeNull();
  });
});
