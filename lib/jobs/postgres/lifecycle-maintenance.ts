import "server-only";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { createCanonicalMediaJobFailure } from "@/lib/jobs/job-record";
import type {
  MediaJobLifecycleMaintenance,
  MediaLifecycleCheckpoint,
  MediaLifecycleCheckpointUpdate,
  MediaLifecycleElection,
  MediaLifecycleLeadership
} from "@/lib/jobs/lifecycle-maintenance";
import {
  postgresRowToMediaJobRecord,
  type PostgresMediaJobRow
} from "@/lib/jobs/postgres/row-mapper";
import type { MediaJobRecord } from "@/lib/jobs/types";
import { isMediaArtifactId } from "@/lib/storage/media-storage";
import { API_ERROR_CODES } from "@/lib/types";

const ADVISORY_LOCK_NAMESPACE = 1_449_428_563;
const ADVISORY_LOCK_KEY = 5_907;
const MAX_BATCH = 1_000;
const MAX_RETENTION_SECONDS = 604_800;

const JOB_COLUMNS = `
  job_id, status, progress, processing_preset, source_metadata,
  final_result_metadata, canonical_error, created_at, started_at,
  completed_at, expires_at, cancellation_requested_at, retry_count,
  lease_owner, lease_expires_at, version
`;

const UPDATED_JOB_COLUMNS = `
  jobs.job_id, jobs.status, jobs.progress, jobs.processing_preset,
  jobs.source_metadata, jobs.final_result_metadata, jobs.canonical_error,
  jobs.created_at, jobs.started_at, jobs.completed_at, jobs.expires_at,
  jobs.cancellation_requested_at, jobs.retry_count, jobs.lease_owner,
  jobs.lease_expires_at, jobs.version
`;

type CheckpointRow = Readonly<{
  last_recovery_at: unknown;
  last_reconciliation_at: unknown;
  last_expiration_at: unknown;
  last_full_sweep_at: unknown;
  updated_at: unknown;
  version: unknown;
}>;

export class PostgresLifecycleMaintenanceError extends Error {
  constructor(message = "PostgreSQL lifecycle maintenance failed.") {
    super(message);
    this.name = "PostgresLifecycleMaintenanceError";
  }
}

function batch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH) {
    throw new TypeError("Lifecycle maintenance batch size is invalid.");
  }
  return value;
}

function retention(value: number): number {
  if (!Number.isSafeInteger(value) || value < 60 || value > MAX_RETENTION_SECONDS) {
    throw new TypeError("Lifecycle retention is invalid.");
  }
  return value;
}

function timestamp(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new PostgresLifecycleMaintenanceError();
  return parsed.toISOString();
}

function checkpoint(row: CheckpointRow | undefined): MediaLifecycleCheckpoint {
  const version = typeof row?.version === "string" ? Number(row.version) : row?.version;
  if (!row || !Number.isSafeInteger(version) || (version as number) < 0) {
    throw new PostgresLifecycleMaintenanceError();
  }
  return Object.freeze({
    lastRecoveryAt: timestamp(row.last_recovery_at, true),
    lastReconciliationAt: timestamp(row.last_reconciliation_at, true),
    lastExpirationAt: timestamp(row.last_expiration_at, true),
    lastFullSweepAt: timestamp(row.last_full_sweep_at, true),
    updatedAt: timestamp(row.updated_at) as string,
    version: version as number
  });
}

function record(row: QueryResultRow): MediaJobRecord {
  try {
    return postgresRowToMediaJobRecord(row as PostgresMediaJobRow);
  } catch {
    throw new PostgresLifecycleMaintenanceError("PostgreSQL lifecycle data was rejected.");
  }
}

export function createPostgresMediaJobLifecycleMaintenance(
  pool: Pool
): MediaJobLifecycleMaintenance {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("PostgreSQL lifecycle maintenance requires a pool.");
  }

  async function query<Row extends QueryResultRow>(sql: string, parameters: readonly unknown[] = []) {
    try {
      return await pool.query<Row>(sql, [...parameters]);
    } catch (error) {
      if (error instanceof PostgresLifecycleMaintenanceError) throw error;
      throw new PostgresLifecycleMaintenanceError();
    }
  }

  async function expireOverdueActiveJobs(limit: number): Promise<readonly MediaJobRecord[]> {
    const failure = createCanonicalMediaJobFailure(API_ERROR_CODES.PROCESSING_TIMEOUT);
    const result = await query(
      `WITH overdue AS (
         SELECT job_id FROM media_jobs
         WHERE status IN ('queued', 'running')
           AND deadline_at IS NOT NULL
           AND deadline_at <= statement_timestamp()
         ORDER BY deadline_at, job_id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE media_jobs AS jobs
       SET status = 'expired',
           started_at = COALESCE(jobs.started_at, jobs.created_at),
           completed_at = statement_timestamp(),
           expires_at = statement_timestamp(),
           cancellation_requested_at = NULL,
           source_metadata = NULL,
           final_result_metadata = NULL,
           canonical_error = $2::jsonb,
           lease_owner = NULL,
           lease_expires_at = NULL,
           lease_attempt_id = NULL,
           source_url = NULL,
           format_id = NULL,
           available_at = NULL,
           deadline_at = NULL,
           version = jobs.version + 1
       FROM overdue
       WHERE jobs.job_id = overdue.job_id
       RETURNING ${UPDATED_JOB_COLUMNS}`,
      [batch(limit), JSON.stringify(failure)]
    );
    return Object.freeze(result.rows.map(record));
  }

  async function expireTerminalJobs(limit: number): Promise<readonly MediaJobRecord[]> {
    const result = await query(
      `WITH terminal AS (
         SELECT job_id FROM media_jobs
         WHERE status IN ('ready', 'failed', 'cancelled')
           AND expires_at IS NOT NULL
           AND expires_at <= statement_timestamp()
         ORDER BY expires_at, job_id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE media_jobs AS jobs
       SET status = 'expired', version = jobs.version + 1
       FROM terminal
       WHERE jobs.job_id = terminal.job_id
       RETURNING ${UPDATED_JOB_COLUMNS}`,
      [batch(limit)]
    );
    return Object.freeze(result.rows.map(record));
  }

  async function deleteRetainedExpiredJobs(limit: number, retentionSeconds: number): Promise<number> {
    const result = await query(
      `WITH retained AS (
         SELECT jobs.job_id FROM media_jobs AS jobs
         WHERE jobs.status = 'expired'
           AND jobs.expires_at <= statement_timestamp() - ($2::bigint * interval '1 second')
           AND NOT EXISTS (
             SELECT 1 FROM media_artifacts AS artifacts WHERE artifacts.job_id = jobs.job_id
           )
         ORDER BY jobs.expires_at, jobs.job_id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       DELETE FROM media_jobs AS jobs
       USING retained
       WHERE jobs.job_id = retained.job_id
       RETURNING jobs.job_id`,
      [batch(limit), retention(retentionSeconds)]
    );
    return result.rowCount ?? 0;
  }

  async function expireReadyJobForMissingArtifact(
    artifactId: string,
    expectedVersion: number
  ): Promise<boolean> {
    if (!isMediaArtifactId(artifactId, "final")) return false;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("Artifact version is invalid.");
    }
    const client = await pool.connect().catch(() => { throw new PostgresLifecycleMaintenanceError(); });
    try {
      await client.query("BEGIN");
      const artifact = await client.query<{
        job_id: string;
        publication_state: string;
        version: string | number;
      }>(
        `SELECT job_id, publication_state, version FROM media_artifacts
         WHERE artifact_id = $1 FOR UPDATE`,
        [artifactId]
      );
      if (!artifact.rows[0]) {
        await client.query("ROLLBACK");
        return false;
      }
      const job = await client.query<{ status: string; file_id: string | null }>(
        `SELECT status, final_result_metadata ->> 'fileId' AS file_id
         FROM media_jobs WHERE job_id = $1 FOR UPDATE`,
        [artifact.rows[0].job_id]
      );
      const artifactVersion = Number(artifact.rows[0].version);
      if (artifact.rows[0].publication_state === "missing" && job.rows[0]?.status === "expired") {
        await client.query("COMMIT");
        return true;
      }
      if (
        artifact.rows[0].publication_state !== "published" ||
        artifactVersion !== expectedVersion ||
        job.rows[0]?.status !== "ready" ||
        job.rows[0].file_id !== artifactId
      ) {
        await client.query("ROLLBACK");
        return false;
      }
      const marked = await client.query(
        `UPDATE media_artifacts SET publication_state = 'missing',
           updated_at = statement_timestamp(), version = version + 1
         WHERE artifact_id = $1 AND version = $2 AND publication_state = 'published'`,
        [artifactId, expectedVersion]
      );
      const expired = await client.query(
        `UPDATE media_jobs SET status = 'expired', version = version + 1
         WHERE job_id = $1 AND status = 'ready'
           AND final_result_metadata ->> 'fileId' = $2`,
        [artifact.rows[0].job_id, artifactId]
      );
      if (marked.rowCount !== 1 || expired.rowCount !== 1) {
        throw new PostgresLifecycleMaintenanceError();
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof PostgresLifecycleMaintenanceError) throw error;
      throw new PostgresLifecycleMaintenanceError();
    } finally {
      client.release();
    }
  }

  async function failJobForDanglingPublishedArtifact(
    artifactId: string,
    expectedVersion: number
  ): Promise<boolean> {
    if (!isMediaArtifactId(artifactId, "final")) return false;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("Artifact version is invalid.");
    }
    const failure = createCanonicalMediaJobFailure(API_ERROR_CODES.PROCESSING_FAILED);
    const result = await query(
      `UPDATE media_jobs AS jobs
       SET status = 'failed',
           started_at = COALESCE(jobs.started_at, jobs.created_at),
           completed_at = statement_timestamp(),
           expires_at = artifacts.expires_at,
           cancellation_requested_at = NULL,
           source_metadata = NULL,
           final_result_metadata = NULL,
           canonical_error = $3::jsonb,
           lease_owner = NULL,
           lease_expires_at = NULL,
           lease_attempt_id = NULL,
           source_url = NULL,
           format_id = NULL,
           available_at = NULL,
           deadline_at = NULL,
           version = jobs.version + 1
       FROM media_artifacts AS artifacts
       WHERE artifacts.artifact_id = $1
         AND artifacts.version = $2
         AND artifacts.kind = 'final'
         AND artifacts.publication_state = 'published'
         AND jobs.job_id = artifacts.job_id
         AND jobs.status IN ('queued', 'running')
         AND jobs.cancellation_requested_at IS NULL
         AND (
           jobs.status = 'queued'
           OR jobs.lease_expires_at IS NULL
           OR jobs.lease_expires_at <= statement_timestamp()
         )
       RETURNING jobs.job_id`,
      [artifactId, expectedVersion, JSON.stringify(failure)]
    );
    return result.rowCount === 1;
  }

  async function getCheckpoint(): Promise<MediaLifecycleCheckpoint> {
    const result = await query<CheckpointRow>(
      `SELECT last_recovery_at, last_reconciliation_at, last_expiration_at,
              last_full_sweep_at, updated_at, version
       FROM media_lifecycle_state WHERE singleton_key = 1`
    );
    return checkpoint(result.rows[0]);
  }

  async function recordCheckpoint(update: MediaLifecycleCheckpointUpdate): Promise<MediaLifecycleCheckpoint> {
    if (!update || typeof update !== "object") throw new TypeError("Lifecycle checkpoint update is invalid.");
    const result = await query<CheckpointRow>(
      `UPDATE media_lifecycle_state
       SET last_recovery_at = CASE WHEN $1::boolean THEN statement_timestamp() ELSE last_recovery_at END,
           last_reconciliation_at = CASE WHEN $2::boolean THEN statement_timestamp() ELSE last_reconciliation_at END,
           last_expiration_at = CASE WHEN $3::boolean THEN statement_timestamp() ELSE last_expiration_at END,
           last_full_sweep_at = CASE WHEN $4::boolean THEN statement_timestamp() ELSE last_full_sweep_at END,
           updated_at = statement_timestamp(),
           version = version + 1
       WHERE singleton_key = 1
       RETURNING last_recovery_at, last_reconciliation_at, last_expiration_at,
                 last_full_sweep_at, updated_at, version`,
      [update.recovery === true, update.reconciliation === true, update.expiration === true, update.fullSweep === true]
    );
    return checkpoint(result.rows[0]);
  }

  return Object.freeze({
    expireOverdueActiveJobs,
    expireTerminalJobs,
    expireReadyJobForMissingArtifact,
    failJobForDanglingPublishedArtifact,
    deleteRetainedExpiredJobs,
    getCheckpoint,
    recordCheckpoint
  });
}

export function createPostgresMediaLifecycleElection(pool: Pool): MediaLifecycleElection {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("PostgreSQL lifecycle election requires a pool.");
  }

  async function tryAcquire(): Promise<MediaLifecycleLeadership | null> {
    let client: PoolClient | null = null;
    try {
      client = await pool.connect();
      const acquired = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired",
        [ADVISORY_LOCK_NAMESPACE, ADVISORY_LOCK_KEY]
      );
      if (acquired.rows[0]?.acquired !== true) {
        client.release();
        return null;
      }
    } catch {
      client?.release(true);
      throw new PostgresLifecycleMaintenanceError("PostgreSQL lifecycle election failed.");
    }

    const ownedClient = client;
    let released = false;
    let connectionLost = false;
    const lost = (): void => { connectionLost = true; };
    ownedClient.on("error", lost);
    ownedClient.on("end", lost);

    const leadership: MediaLifecycleLeadership = Object.freeze({
      async verify(): Promise<boolean> {
        if (released || connectionLost) return false;
        try {
          const result = await ownedClient.query<{ held: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_locks
               WHERE locktype = 'advisory'
                 AND pid = pg_backend_pid()
                 AND classid = $1::integer::oid
                 AND objid = $2::integer::oid
                 AND granted
             ) AS held`,
            [ADVISORY_LOCK_NAMESPACE, ADVISORY_LOCK_KEY]
          );
          return result.rows[0]?.held === true;
        } catch {
          connectionLost = true;
          return false;
        }
      },
      async release(): Promise<void> {
        if (released) return;
        released = true;
        ownedClient.off("error", lost);
        ownedClient.off("end", lost);
        if (!connectionLost) {
          await ownedClient.query("SELECT pg_advisory_unlock($1, $2)", [ADVISORY_LOCK_NAMESPACE, ADVISORY_LOCK_KEY]).catch(() => undefined);
        }
        ownedClient.release(connectionLost);
      }
    });
    return leadership;
  }

  return Object.freeze({ tryAcquire });
}
