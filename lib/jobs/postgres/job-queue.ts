import "server-only";
import type { QueryResult, QueryResultRow } from "pg";
import {
  createCanonicalMediaJobFailure,
  sanitizeMediaJobResult,
  sanitizeMediaJobSourceMetadata
} from "@/lib/jobs/job-record";
import {
  createJobAttemptId,
  isSafeDurableJobId,
  isSafeJobAttemptId,
  isSafeJobWorkerId,
  sanitizeMediaJobWorkItem,
  type ClaimedMediaJob,
  type EnqueueDurableMediaJobInput,
  type JobLeaseQueue,
  type JobLeaseQueueCancellationResult,
  type JobLeaseQueueClaimResult,
  type JobLeaseQueueEnqueueResult,
  type JobLeaseRecoveryResult,
  type JobLeaseRef,
  type OwnedJobCompletion,
  type OwnedJobCompletionResult,
  type OwnedJobObservationResult,
  type OwnedJobUpdateResult
} from "@/lib/jobs/job-lease-queue";
import {
  postgresRowToMediaJobRecord,
  type PostgresMediaJobRow
} from "@/lib/jobs/postgres/row-mapper";
import type { PostgresQueryExecutor } from "@/lib/jobs/postgres/repository";
import type { MediaJobRecord } from "@/lib/jobs/types";
import { API_ERROR_CODES } from "@/lib/types";

const DEFAULT_TERMINAL_TTL_MS = 60 * 60 * 1000;
const MAX_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RECOVERY_BATCH_SIZE = 100;
const DEFAULT_RETRY_BACKOFF_BASE_MS = 5_000;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 300_000;
const DEFAULT_ACTIVE_TTL_SECONDS = 86_400;

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
  lease_attempt_id,
  version
`;

const SELECT_JOB_COLUMNS = `
  jobs.job_id,
  jobs.status,
  jobs.progress,
  jobs.processing_preset,
  jobs.source_metadata,
  jobs.final_result_metadata,
  jobs.canonical_error,
  jobs.created_at,
  jobs.started_at,
  jobs.completed_at,
  jobs.expires_at,
  jobs.cancellation_requested_at,
  jobs.retry_count,
  jobs.lease_owner,
  jobs.lease_expires_at,
  jobs.lease_attempt_id,
  jobs.version
`;

type PostgresClaimedJobRow = PostgresMediaJobRow & Readonly<{
  source_url: unknown;
  format_id: unknown;
  lease_attempt_id: unknown;
}>;

type PostgresOwnedJobRow = PostgresMediaJobRow & Readonly<{
  lease_attempt_id: unknown;
}>;

export class PostgresJobLeaseQueueError extends Error {
  constructor(message = "PostgreSQL job queue operation failed.") {
    super(message);
    this.name = "PostgresJobLeaseQueueError";
  }
}

export type CreatePostgresJobLeaseQueueOptions = Readonly<{
  database: PostgresQueryExecutor;
  leaseDurationMs: number;
  maxRetries: number;
  terminalTtlMs?: number;
  recoveryBatchSize?: number;
  retryBackoffBaseMs?: number;
  retryBackoffMaxMs?: number;
  activeTtlSeconds?: number;
}>;

function boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is outside its supported range.`);
  }
  return value;
}

function rowRecord(row: QueryResultRow): MediaJobRecord {
  try {
    return postgresRowToMediaJobRecord(row as PostgresMediaJobRow);
  } catch {
    throw new PostgresJobLeaseQueueError("PostgreSQL job queue rejected stored data.");
  }
}

function leaseFor(record: MediaJobRecord, attemptId: unknown): JobLeaseRef {
  if (
    record.status !== "running" ||
    !isSafeJobWorkerId(record.leaseOwner) ||
    !isSafeJobAttemptId(attemptId) ||
    record.leaseExpiresAt === null
  ) {
    throw new PostgresJobLeaseQueueError("PostgreSQL job queue rejected lease data.");
  }
  return Object.freeze({
    jobId: record.jobId,
    workerId: record.leaseOwner,
    attemptId,
    version: record.version,
    leaseExpiresAt: record.leaseExpiresAt
  });
}

function validateLeaseRef(value: JobLeaseRef): JobLeaseRef {
  if (
    typeof value !== "object" ||
    value === null ||
    !isSafeDurableJobId(value.jobId) ||
    !isSafeJobWorkerId(value.workerId) ||
    !isSafeJobAttemptId(value.attemptId) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.leaseExpiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.leaseExpiresAt)) ||
    new Date(value.leaseExpiresAt).toISOString() !== value.leaseExpiresAt
  ) {
    throw new TypeError("Job lease reference is invalid.");
  }
  return value;
}

function claimedJob(row: PostgresClaimedJobRow): ClaimedMediaJob {
  const record = rowRecord(row);
  let workItem;
  try {
    workItem = sanitizeMediaJobWorkItem({
      sourceUrl: row.source_url,
      formatId: row.format_id,
      processingPreset: record.processingPreset
    });
  } catch {
    throw new PostgresJobLeaseQueueError("PostgreSQL job queue rejected stored payload.");
  }
  return Object.freeze({ record, workItem, lease: leaseFor(record, row.lease_attempt_id) });
}

function sameCompletion(record: MediaJobRecord, completion: OwnedJobCompletion): boolean {
  if (completion.type === "ready") {
    let result;
    try {
      result = sanitizeMediaJobResult(completion.result, record.processingPreset);
    } catch {
      return false;
    }
    return record.status === "ready" && JSON.stringify(record.finalMetadata) === JSON.stringify(result);
  }
  if (completion.type === "failed") {
    let failure;
    try {
      failure = createCanonicalMediaJobFailure(completion.errorCode);
    } catch {
      return false;
    }
    return record.status === "failed" && JSON.stringify(record.canonicalError) === JSON.stringify(failure);
  }
  return (
    record.status === "cancelled" &&
    record.canonicalError?.code === API_ERROR_CODES.JOB_CANCELLED
  );
}

export function createPostgresJobLeaseQueue(
  options: CreatePostgresJobLeaseQueueOptions
): JobLeaseQueue {
  if (!options?.database || typeof options.database.query !== "function") {
    throw new TypeError("PostgreSQL job queue requires a query executor.");
  }
  const database = options.database;
  const leaseDurationMs = boundedInteger(
    "PostgreSQL job queue lease duration",
    options.leaseDurationMs,
    15_000,
    300_000
  );
  const maxRetries = boundedInteger(
    "PostgreSQL job queue maximum retries",
    options.maxRetries,
    0,
    10
  );
  const terminalTtlMs = boundedInteger(
    "PostgreSQL job queue terminal TTL",
    options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS,
    0,
    MAX_TERMINAL_TTL_MS
  );
  const recoveryBatchSize = boundedInteger(
    "PostgreSQL job queue recovery batch size",
    options.recoveryBatchSize ?? DEFAULT_RECOVERY_BATCH_SIZE,
    1,
    1_000
  );
  const retryBackoffBaseMs = boundedInteger(
    "PostgreSQL job queue retry backoff base",
    options.retryBackoffBaseMs ?? DEFAULT_RETRY_BACKOFF_BASE_MS,
    1_000,
    300_000
  );
  const retryBackoffMaxMs = boundedInteger(
    "PostgreSQL job queue retry backoff maximum",
    options.retryBackoffMaxMs ?? DEFAULT_RETRY_BACKOFF_MAX_MS,
    retryBackoffBaseMs,
    3_600_000
  );
  const activeTtlSeconds = boundedInteger(
    "PostgreSQL job queue active TTL",
    options.activeTtlSeconds ?? DEFAULT_ACTIVE_TTL_SECONDS,
    300,
    604_800
  );

  async function query<Row extends QueryResultRow>(
    sql: string,
    parameters: readonly unknown[] = []
  ): Promise<QueryResult<Row>> {
    try {
      return await database.query<Row>(sql, [...parameters]);
    } catch (error) {
      if (error instanceof PostgresJobLeaseQueueError) throw error;
      throw new PostgresJobLeaseQueueError();
    }
  }

  async function get(jobId: string): Promise<MediaJobRecord | null> {
    if (!isSafeDurableJobId(jobId)) return null;
    const result = await query(
      `SELECT ${SELECT_COLUMNS} FROM media_jobs WHERE job_id = $1`,
      [jobId]
    );
    return result.rows[0] ? rowRecord(result.rows[0]) : null;
  }

  async function inspectOwnedFailure(lease: JobLeaseRef): Promise<OwnedJobUpdateResult> {
    const result = await query(
      `
        SELECT ${SELECT_COLUMNS},
          (
            status = 'running'
            AND lease_owner = $2
            AND version = $3
            AND lease_attempt_id = $4
            AND lease_expires_at > statement_timestamp()
            AND cancellation_requested_at IS NULL
          ) AS ownership_active
        FROM media_jobs
        WHERE job_id = $1
      `,
      [lease.jobId, lease.workerId, lease.version, lease.attemptId]
    );
    if (!result.rows[0]) return Object.freeze({ outcome: "not-found" });
    const record = rowRecord(result.rows[0]);
    if (record.status === "cancelled") {
      return Object.freeze({ outcome: "cancelled", record });
    }
    if ((result.rows[0] as QueryResultRow).ownership_active === true) {
      return Object.freeze({ outcome: "invalid-state", record });
    }
    if (record.status !== "running") {
      return Object.freeze({ outcome: "invalid-state", record });
    }
    return Object.freeze({ outcome: "ownership-lost" });
  }

  async function enqueue(
    input: EnqueueDurableMediaJobInput
  ): Promise<JobLeaseQueueEnqueueResult> {
    if (typeof input !== "object" || input === null || !isSafeDurableJobId(input.jobId)) {
      return Object.freeze({ outcome: "invalid-state" });
    }
    let workItem;
    try {
      workItem = sanitizeMediaJobWorkItem(input);
    } catch {
      return Object.freeze({ outcome: "invalid-state" });
    }
    const inserted = await query(
      `
        INSERT INTO media_jobs (
          job_id, status, progress, processing_preset, source_metadata,
          final_result_metadata, canonical_error, created_at, started_at,
          completed_at, expires_at, cancellation_requested_at, retry_count,
          lease_owner, lease_expires_at, version, source_url, format_id,
          available_at, deadline_at
        ) VALUES (
          $1, 'queued', 0, $2, NULL, NULL, NULL, statement_timestamp(), NULL,
          NULL, NULL, NULL, 0, NULL, NULL, 1, $3, $4,
          statement_timestamp(), statement_timestamp() + ($5::bigint * interval '1 second')
        )
        ON CONFLICT (job_id) DO NOTHING
        RETURNING ${SELECT_COLUMNS}
      `,
      [input.jobId, workItem.processingPreset, workItem.sourceUrl, workItem.formatId, activeTtlSeconds]
    );
    if (inserted.rows[0]) {
      return Object.freeze({ outcome: "created", record: rowRecord(inserted.rows[0]) });
    }
    const existing = await get(input.jobId);
    if (!existing) throw new PostgresJobLeaseQueueError();
    return Object.freeze({ outcome: "duplicate", record: existing });
  }

  async function claimNext(workerId: string): Promise<JobLeaseQueueClaimResult> {
    if (!isSafeJobWorkerId(workerId)) throw new TypeError("Job worker ID is invalid.");
    const attemptId = createJobAttemptId();
    // The data-modifying CTE is one PostgreSQL statement and therefore one atomic transaction.
    const claimed = await query<PostgresClaimedJobRow>(
      `
        WITH next_job AS (
          SELECT job_id
          FROM media_jobs
          WHERE status = 'queued'
            AND cancellation_requested_at IS NULL
            AND expires_at IS NULL
            AND available_at <= statement_timestamp()
            AND (deadline_at IS NULL OR deadline_at > statement_timestamp())
            AND source_url IS NOT NULL
            AND format_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM media_artifacts
              WHERE media_artifacts.job_id = media_jobs.job_id
                AND media_artifacts.publication_state = 'published'
            )
          ORDER BY created_at, job_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE media_jobs AS jobs
        SET status = 'running',
            started_at = statement_timestamp(),
            source_metadata = NULL,
            lease_owner = $1,
            lease_expires_at = statement_timestamp() + ($2::bigint * interval '1 millisecond'),
            lease_attempt_id = $3,
            available_at = NULL,
            version = jobs.version + 1
        FROM next_job
        WHERE jobs.job_id = next_job.job_id
        RETURNING ${SELECT_JOB_COLUMNS}, jobs.source_url, jobs.format_id
      `,
      [workerId, leaseDurationMs, attemptId]
    );
    return claimed.rows[0]
      ? Object.freeze({ outcome: "claimed", job: claimedJob(claimed.rows[0]) })
      : Object.freeze({ outcome: "empty" });
  }

  async function requestCancellation(
    jobId: string
  ): Promise<JobLeaseQueueCancellationResult> {
    if (!isSafeDurableJobId(jobId)) return Object.freeze({ outcome: "not-found" });
    const failure = createCanonicalMediaJobFailure(API_ERROR_CODES.JOB_CANCELLED);
    const cancelled = await query(
      `
        UPDATE media_jobs
        SET status = 'cancelled',
            completed_at = GREATEST(statement_timestamp(), COALESCE(started_at, created_at)),
            expires_at = GREATEST(statement_timestamp(), COALESCE(started_at, created_at))
              + ($3::bigint * interval '1 millisecond'),
            cancellation_requested_at = GREATEST(statement_timestamp(), created_at),
            final_result_metadata = NULL,
            canonical_error = $2::jsonb,
            lease_owner = NULL,
            lease_expires_at = NULL,
            lease_attempt_id = NULL,
            source_url = NULL,
            format_id = NULL,
            available_at = NULL,
            deadline_at = NULL,
            version = version + 1
        WHERE job_id = $1 AND status IN ('queued', 'running')
        RETURNING ${SELECT_COLUMNS}
      `,
      [jobId, JSON.stringify(failure), terminalTtlMs]
    );
    if (cancelled.rows[0]) {
      return Object.freeze({ outcome: "cancelled", record: rowRecord(cancelled.rows[0]) });
    }
    const existing = await get(jobId);
    return existing
      ? Object.freeze({ outcome: "unchanged", record: existing })
      : Object.freeze({ outcome: "not-found" });
  }

  async function observeOwnedState(
    leaseValue: JobLeaseRef
  ): Promise<OwnedJobObservationResult> {
    const lease = validateLeaseRef(leaseValue);
    const result = await query(
      `SELECT ${SELECT_COLUMNS},
         (status = 'running' AND lease_owner = $2 AND lease_attempt_id = $3
           AND version = $4 AND lease_expires_at > statement_timestamp()
           AND (deadline_at IS NULL OR deadline_at > statement_timestamp())
           AND cancellation_requested_at IS NULL) AS ownership_active,
         (deadline_at IS NOT NULL AND deadline_at <= statement_timestamp()) AS deadline_expired
       FROM media_jobs WHERE job_id = $1`,
      [lease.jobId, lease.workerId, lease.attemptId, lease.version]
    );
    if (!result.rows[0]) return Object.freeze({ outcome: "not-found" });
    const record = rowRecord(result.rows[0]);
    const row = result.rows[0] as QueryResultRow;
    if (record.status === "cancelled") return Object.freeze({ outcome: "cancelled", record });
    if (record.status === "expired" || row.deadline_expired === true) {
      return Object.freeze({ outcome: "expired", record });
    }
    if (row.ownership_active === true) return Object.freeze({ outcome: "active", record });
    if (record.status !== "running") return Object.freeze({ outcome: "terminal", record });
    return Object.freeze({ outcome: "ownership-lost" });
  }

  async function renewLease(leaseValue: JobLeaseRef): Promise<OwnedJobUpdateResult> {
    const lease = validateLeaseRef(leaseValue);
    const updated = await query<PostgresOwnedJobRow>(
      `
        UPDATE media_jobs
        SET lease_expires_at = statement_timestamp() + ($5::bigint * interval '1 millisecond'),
            version = version + 1
        WHERE job_id = $1
          AND status = 'running'
          AND lease_owner = $2
          AND version = $3
          AND lease_attempt_id = $4
          AND lease_expires_at > statement_timestamp()
          AND (deadline_at IS NULL OR deadline_at > statement_timestamp())
          AND cancellation_requested_at IS NULL
        RETURNING ${SELECT_COLUMNS}
      `,
      [lease.jobId, lease.workerId, lease.version, lease.attemptId, leaseDurationMs]
    );
    if (updated.rows[0]) {
      const record = rowRecord(updated.rows[0]);
      return Object.freeze({
        outcome: "updated",
        record,
        lease: leaseFor(record, updated.rows[0].lease_attempt_id)
      });
    }
    return inspectOwnedFailure(lease);
  }

  async function setSourceMetadataOwned(
    leaseValue: JobLeaseRef,
    sourceMetadataValue: Parameters<JobLeaseQueue["setSourceMetadataOwned"]>[1]
  ): Promise<OwnedJobUpdateResult> {
    const lease = validateLeaseRef(leaseValue);
    let sourceMetadata;
    try {
      sourceMetadata = sanitizeMediaJobSourceMetadata(
        sourceMetadataValue,
        "1970-01-01T00:00:00.000Z"
      );
    } catch {
      const current = await get(lease.jobId);
      return current
        ? Object.freeze({ outcome: "invalid-state", record: current })
        : Object.freeze({ outcome: "not-found" });
    }
    const updated = await query<PostgresOwnedJobRow>(
      `
        UPDATE media_jobs
        SET source_metadata = jsonb_build_object(
              'sourceId', $5::text,
              'filename', $6::text,
              'sizeBytes', $7::bigint,
              'contentType', $8::text,
              'registeredAt', to_char(
                statement_timestamp() AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
            ),
            version = version + 1
        WHERE job_id = $1
          AND status = 'running'
          AND lease_owner = $2
          AND version = $3
          AND lease_attempt_id = $4
          AND lease_expires_at > statement_timestamp()
          AND (deadline_at IS NULL OR deadline_at > statement_timestamp())
          AND cancellation_requested_at IS NULL
          AND source_metadata IS NULL
        RETURNING ${SELECT_COLUMNS}
      `,
      [
        lease.jobId,
        lease.workerId,
        lease.version,
        lease.attemptId,
        sourceMetadata.sourceId,
        sourceMetadata.filename,
        sourceMetadata.sizeBytes,
        sourceMetadata.contentType
      ]
    );
    if (updated.rows[0]) {
      const record = rowRecord(updated.rows[0]);
      return Object.freeze({
        outcome: "updated",
        record,
        lease: leaseFor(record, updated.rows[0].lease_attempt_id)
      });
    }
    return inspectOwnedFailure(lease);
  }

  async function updateProgressOwned(
    leaseValue: JobLeaseRef,
    progress: number
  ): Promise<OwnedJobUpdateResult> {
    const lease = validateLeaseRef(leaseValue);
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
      const current = await get(lease.jobId);
      return current
        ? Object.freeze({ outcome: "invalid-state", record: current })
        : Object.freeze({ outcome: "not-found" });
    }
    const updated = await query<PostgresOwnedJobRow>(
      `
        UPDATE media_jobs
        SET progress = $5, version = version + 1
        WHERE job_id = $1
          AND status = 'running'
          AND lease_owner = $2
          AND version = $3
          AND lease_attempt_id = $4
          AND lease_expires_at > statement_timestamp()
          AND (deadline_at IS NULL OR deadline_at > statement_timestamp())
          AND cancellation_requested_at IS NULL
          AND $5 >= progress
        RETURNING ${SELECT_COLUMNS}
      `,
      [lease.jobId, lease.workerId, lease.version, lease.attemptId, progress]
    );
    if (updated.rows[0]) {
      const record = rowRecord(updated.rows[0]);
      return Object.freeze({
        outcome: "updated",
        record,
        lease: leaseFor(record, updated.rows[0].lease_attempt_id)
      });
    }
    return inspectOwnedFailure(lease);
  }

  async function completeOwned(
    leaseValue: JobLeaseRef,
    completion: OwnedJobCompletion
  ): Promise<OwnedJobCompletionResult> {
    const lease = validateLeaseRef(leaseValue);
    let status: "ready" | "failed" | "cancelled";
    let progress: number | null = null;
    let finalMetadata: string | null = null;
    let canonicalError: string | null = null;
    let cancellationRequested = false;
    try {
      if (completion.type === "ready") {
        status = "ready";
        progress = 100;
        finalMetadata = JSON.stringify(sanitizeMediaJobResult(completion.result, "original"));
      } else if (completion.type === "failed") {
        if (completion.errorCode === API_ERROR_CODES.JOB_CANCELLED) {
          throw new TypeError("Cancellation must use the cancelled completion type.");
        }
        status = "failed";
        canonicalError = JSON.stringify(createCanonicalMediaJobFailure(completion.errorCode));
      } else if (completion.type === "cancelled") {
        status = "cancelled";
        cancellationRequested = true;
        canonicalError = JSON.stringify(
          createCanonicalMediaJobFailure(API_ERROR_CODES.JOB_CANCELLED)
        );
      } else {
        throw new TypeError("Owned job completion is invalid.");
      }
    } catch {
      const current = await get(lease.jobId);
      return current
        ? Object.freeze({ outcome: "invalid-state", record: current })
        : Object.freeze({ outcome: "not-found" });
    }

    // A ready result is preset-bound. Read only the preset, never the payload, before sanitizing it.
    if (completion.type === "ready") {
      const current = await get(lease.jobId);
      if (!current) return Object.freeze({ outcome: "not-found" });
      try {
        finalMetadata = JSON.stringify(
          sanitizeMediaJobResult(completion.result, current.processingPreset)
        );
      } catch {
        return Object.freeze({ outcome: "invalid-state", record: current });
      }
    }

    const completed = await query(
      `
        UPDATE media_jobs
        SET status = $5,
            progress = COALESCE($6::double precision, progress),
            final_result_metadata = $7::jsonb,
            canonical_error = $8::jsonb,
            completed_at = statement_timestamp(),
            expires_at = statement_timestamp() + ($9::bigint * interval '1 millisecond'),
            cancellation_requested_at = CASE
              WHEN $10::boolean THEN statement_timestamp()
              ELSE cancellation_requested_at
            END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            lease_attempt_id = NULL,
            source_url = NULL,
            format_id = NULL,
            available_at = NULL,
            deadline_at = NULL,
            version = version + 1
        WHERE job_id = $1
          AND status = 'running'
          AND lease_owner = $2
          AND version = $3
          AND lease_attempt_id = $4
          AND lease_expires_at > statement_timestamp()
          AND (deadline_at IS NULL OR deadline_at > statement_timestamp())
          AND cancellation_requested_at IS NULL
        RETURNING ${SELECT_COLUMNS}
      `,
      [
        lease.jobId,
        lease.workerId,
        lease.version,
        lease.attemptId,
        status,
        progress,
        finalMetadata,
        canonicalError,
        terminalTtlMs,
        cancellationRequested
      ]
    );
    if (completed.rows[0]) {
      return Object.freeze({ outcome: "completed", record: rowRecord(completed.rows[0]) });
    }

    const current = await get(lease.jobId);
    if (!current) return Object.freeze({ outcome: "not-found" });
    if (current.version === lease.version + 1 && sameCompletion(current, completion)) {
      return Object.freeze({ outcome: "already-completed", record: current });
    }
    if (current.status !== "running" && current.status !== "queued") {
      return Object.freeze({ outcome: "invalid-state", record: current });
    }
    return Object.freeze({ outcome: "ownership-lost" });
  }

  async function recoverExpiredLeases(): Promise<JobLeaseRecoveryResult> {
    const failure = createCanonicalMediaJobFailure(API_ERROR_CODES.PROCESSING_FAILED);
    const recovered = await query(
      `
        WITH expired_jobs AS (
          SELECT job_id
          FROM media_jobs
          WHERE status = 'running'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= statement_timestamp()
            AND (deadline_at IS NULL OR deadline_at > statement_timestamp())
          ORDER BY lease_expires_at, job_id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE media_jobs AS jobs
        SET status = CASE WHEN jobs.retry_count < $2 THEN 'queued' ELSE 'failed' END,
            retry_count = CASE
              WHEN jobs.retry_count < $2 THEN jobs.retry_count + 1
              ELSE jobs.retry_count
            END,
            started_at = CASE WHEN jobs.retry_count < $2 THEN NULL ELSE jobs.started_at END,
            completed_at = CASE
              WHEN jobs.retry_count < $2 THEN NULL
              ELSE statement_timestamp()
            END,
            expires_at = CASE
              WHEN jobs.retry_count < $2 THEN NULL
              ELSE statement_timestamp() + ($6::bigint * interval '1 millisecond')
            END,
            source_metadata = NULL,
            final_result_metadata = NULL,
            canonical_error = CASE
              WHEN jobs.retry_count < $2 THEN NULL
              ELSE $3::jsonb
            END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            lease_attempt_id = NULL,
            available_at = CASE
              WHEN jobs.retry_count < $2 THEN statement_timestamp() + (
                LEAST($5::bigint, $4::bigint * power(2, jobs.retry_count)::bigint)
                * interval '1 millisecond'
              )
              ELSE NULL
            END,
            deadline_at = CASE WHEN jobs.retry_count < $2 THEN jobs.deadline_at ELSE NULL END,
            source_url = CASE WHEN jobs.retry_count < $2 THEN jobs.source_url ELSE NULL END,
            format_id = CASE WHEN jobs.retry_count < $2 THEN jobs.format_id ELSE NULL END,
            version = jobs.version + 1
        FROM expired_jobs
        WHERE jobs.job_id = expired_jobs.job_id
        RETURNING ${SELECT_JOB_COLUMNS}
      `,
      [recoveryBatchSize, maxRetries, JSON.stringify(failure), retryBackoffBaseMs, retryBackoffMaxMs, terminalTtlMs]
    );
    const records = recovered.rows.map(rowRecord);
    return Object.freeze({
      requeued: Object.freeze(records.filter((record) => record.status === "queued")),
      failed: Object.freeze(records.filter((record) => record.status === "failed"))
    });
  }

  return Object.freeze({
    enqueue,
    claimNext,
    requestCancellation,
    observeOwnedState,
    renewLease,
    setSourceMetadataOwned,
    updateProgressOwned,
    completeOwned,
    recoverExpiredLeases
  });
}
