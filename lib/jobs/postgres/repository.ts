import "server-only";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  applyMediaJobMutation,
  createMediaJobRecord
} from "@/lib/jobs/job-record";
import {
  mediaJobRecordToPostgresParameters,
  postgresRowToMediaJobRecord,
  type PostgresMediaJobRow
} from "@/lib/jobs/postgres/row-mapper";
import type {
  JobRepository,
  JobRepositoryCancellationResult,
  JobRepositoryCreateResult,
  JobRepositoryUpdateResult
} from "@/lib/jobs/repository";
import type { MediaJobRecord } from "@/lib/jobs/types";

const DEFAULT_TERMINAL_TTL_MS = 60 * 60 * 1000;
const MAX_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_JOB_ID = /^[a-zA-Z0-9_-]{1,128}$/;

const SELECT_COLUMNS = `
  job_id,
  status,
  progress,
  processing_preset,
  source_metadata,
  final_result_metadata,
  canonical_error,
  created_at,
  started_at,
  completed_at,
  expires_at,
  cancellation_requested_at,
  retry_count,
  lease_owner,
  lease_expires_at,
  version,
  available_at
`;

const INSERT_JOB = `
  INSERT INTO media_jobs (
    job_id, status, progress, processing_preset, source_metadata,
    final_result_metadata, canonical_error, created_at, started_at,
    completed_at, expires_at, cancellation_requested_at, retry_count,
    lease_owner, lease_expires_at, version, available_at
  ) VALUES (
    $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::timestamptz,
    $9::timestamptz, $10::timestamptz, $11::timestamptz, $12::timestamptz,
    $13, $14, $15::timestamptz, $16, $8::timestamptz
  )
  ON CONFLICT (job_id) DO NOTHING
  RETURNING ${SELECT_COLUMNS}
`;

const UPDATE_JOB = `
  UPDATE media_jobs
  SET
    status = $2,
    progress = $3,
    processing_preset = $4,
    source_metadata = $5::jsonb,
    final_result_metadata = $6::jsonb,
    canonical_error = $7::jsonb,
    created_at = $8::timestamptz,
    started_at = $9::timestamptz,
    completed_at = $10::timestamptz,
    expires_at = $11::timestamptz,
    cancellation_requested_at = $12::timestamptz,
    retry_count = $13,
    lease_owner = $14::text,
    lease_expires_at = $15::timestamptz,
    lease_attempt_id = CASE WHEN $14::text IS NULL THEN NULL ELSE lease_attempt_id END,
    source_url = CASE
      WHEN $2 IN ('ready', 'failed', 'cancelled', 'expired') THEN NULL
      ELSE source_url
    END,
    format_id = CASE
      WHEN $2 IN ('ready', 'failed', 'cancelled', 'expired') THEN NULL
      ELSE format_id
    END,
    available_at = CASE
      WHEN $2 = 'queued' THEN COALESCE(available_at, $8::timestamptz)
      ELSE NULL
    END,
    deadline_at = CASE WHEN $2 IN ('queued', 'running') THEN deadline_at ELSE NULL END,
    version = $16
  WHERE job_id = $1 AND version = $17
  RETURNING ${SELECT_COLUMNS}
`;

export class PostgresJobRepositoryError extends Error {
  constructor(message = "PostgreSQL job repository operation failed.") {
    super(message);
    this.name = "PostgresJobRepositoryError";
  }
}

export type PostgresQueryExecutor = Pool | PoolClient;

export type CreatePostgresJobRepositoryOptions = Readonly<{
  database: PostgresQueryExecutor;
  terminalTtlMs?: number;
  now?: () => number;
}>;

export type PostgreSQLJobRepository = JobRepository;

function normalizeTerminalTtl(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_TTL_MS;
  return Math.min(MAX_TERMINAL_TTL_MS, Math.max(0, Math.trunc(value as number)));
}

function validNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value)) throw new TypeError("Media job clock must return a finite timestamp.");
  return value;
}

function safeJobId(jobId: string): boolean {
  return typeof jobId === "string" && SAFE_JOB_ID.test(jobId);
}

function rowRecord(row: QueryResultRow): MediaJobRecord {
  try {
    return postgresRowToMediaJobRecord(row as PostgresMediaJobRow);
  } catch {
    throw new PostgresJobRepositoryError("PostgreSQL job repository rejected stored data.");
  }
}

export function createPostgresJobRepository(
  options: CreatePostgresJobRepositoryOptions
): PostgreSQLJobRepository {
  if (!options?.database || typeof options.database.query !== "function") {
    throw new TypeError("PostgreSQL job repository requires a query executor.");
  }
  const database = options.database;
  const terminalTtlMs = normalizeTerminalTtl(options.terminalTtlMs);
  const now = options.now ?? Date.now;

  async function query<Row extends QueryResultRow>(
    sql: string,
    parameters: unknown[] = []
  ): Promise<QueryResult<Row>> {
    try {
      return await database.query<Row>(sql, parameters);
    } catch (error) {
      if (error instanceof PostgresJobRepositoryError) throw error;
      throw new PostgresJobRepositoryError();
    }
  }

  async function get(jobId: string): Promise<MediaJobRecord | null> {
    if (!safeJobId(jobId)) return null;
    const result = await query(
      `SELECT ${SELECT_COLUMNS} FROM media_jobs WHERE job_id = $1`,
      [jobId]
    );
    return result.rows[0] ? rowRecord(result.rows[0]) : null;
  }

  async function create(
    input: Parameters<JobRepository["create"]>[0]
  ): Promise<JobRepositoryCreateResult> {
    let record: MediaJobRecord;
    try {
      record = createMediaJobRecord(input, validNow(now));
    } catch (error) {
      if (error instanceof TypeError) return Object.freeze({ outcome: "invalid-state" });
      throw error;
    }

    const inserted = await query(INSERT_JOB, [...mediaJobRecordToPostgresParameters(record)]);
    if (inserted.rows[0]) {
      return Object.freeze({ outcome: "created", record: rowRecord(inserted.rows[0]) });
    }
    const existing = await get(record.jobId);
    if (!existing) {
      throw new PostgresJobRepositoryError();
    }
    return Object.freeze({ outcome: "duplicate", record: existing });
  }

  async function list(): Promise<readonly MediaJobRecord[]> {
    const result = await query(
      `SELECT ${SELECT_COLUMNS} FROM media_jobs ORDER BY created_at, job_id`
    );
    return Object.freeze(result.rows.map(rowRecord));
  }

  async function writeMutation(
    jobId: string,
    expectedVersion: number,
    mutation: Parameters<JobRepository["update"]>[2]
  ): Promise<JobRepositoryUpdateResult> {
    if (!safeJobId(jobId)) return Object.freeze({ outcome: "not-found" });
    const current = await get(jobId);
    if (!current) return Object.freeze({ outcome: "not-found" });
    if (!Number.isSafeInteger(expectedVersion) || current.version !== expectedVersion) {
      return Object.freeze({ outcome: "version-conflict", record: current });
    }

    const applied = applyMediaJobMutation(current, mutation, validNow(now), terminalTtlMs);
    if (!applied.ok) return Object.freeze({ outcome: "invalid-state", record: current });

    const parameters = [...mediaJobRecordToPostgresParameters(applied.record), expectedVersion];
    const updated = await query(UPDATE_JOB, parameters);
    if (updated.rows[0]) {
      return Object.freeze({ outcome: "updated", record: rowRecord(updated.rows[0]) });
    }

    const competing = await get(jobId);
    return competing
      ? Object.freeze({ outcome: "version-conflict", record: competing })
      : Object.freeze({ outcome: "not-found" });
  }

  async function update(
    jobId: string,
    expectedVersion: number,
    mutation: Parameters<JobRepository["update"]>[2]
  ): Promise<JobRepositoryUpdateResult> {
    return writeMutation(jobId, expectedVersion, mutation);
  }

  async function requestCancellation(
    jobId: string,
    expectedVersion: number
  ): Promise<JobRepositoryCancellationResult> {
    if (!safeJobId(jobId)) return Object.freeze({ outcome: "not-found" });
    const current = await get(jobId);
    if (!current) return Object.freeze({ outcome: "not-found" });
    if (!Number.isSafeInteger(expectedVersion) || current.version !== expectedVersion) {
      return Object.freeze({ outcome: "version-conflict", record: current });
    }
    if (current.status !== "queued" && current.status !== "running") {
      return Object.freeze({ outcome: "unchanged", record: current });
    }

    const applied = applyMediaJobMutation(current, { type: "cancel" }, validNow(now), terminalTtlMs);
    if (!applied.ok) return Object.freeze({ outcome: "unchanged", record: current });
    const parameters = [...mediaJobRecordToPostgresParameters(applied.record), expectedVersion];
    const updated = await query(UPDATE_JOB, parameters);
    if (updated.rows[0]) {
      return Object.freeze({ outcome: "updated", record: rowRecord(updated.rows[0]) });
    }

    const competing = await get(jobId);
    return competing
      ? Object.freeze({ outcome: "version-conflict", record: competing })
      : Object.freeze({ outcome: "not-found" });
  }

  async function cleanupExpired(nowMs = validNow(now)): Promise<number> {
    if (!Number.isFinite(nowMs)) throw new TypeError("Cleanup timestamp must be finite.");
    const timestamp = new Date(nowMs);
    if (!Number.isFinite(timestamp.getTime())) {
      throw new TypeError("Cleanup timestamp is unsupported.");
    }
    const result = await query(
      `
        DELETE FROM media_jobs
        WHERE status = 'expired'
           OR (
             status IN ('ready', 'failed', 'cancelled')
             AND expires_at IS NOT NULL
             AND expires_at <= $1::timestamptz
           )
        RETURNING job_id
      `,
      [timestamp.toISOString()]
    );
    return result.rowCount ?? result.rows.length;
  }

  return Object.freeze({ create, get, list, update, requestCancellation, cleanupExpired });
}
