import "server-only";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { sanitizeMediaJobResult } from "@/lib/jobs/job-record";
import {
  isSafeDurableJobId,
  isSafeJobAttemptId,
  isSafeJobWorkerId,
  type JobLeaseRef
} from "@/lib/jobs/job-lease-queue";
import {
  postgresRowToMediaJobRecord,
  type PostgresMediaJobRow
} from "@/lib/jobs/postgres/row-mapper";
import type { MediaJobRecord } from "@/lib/jobs/types";
import { sanitizeFilename } from "@/lib/security/sanitize";
import type {
  ArtifactMutationResult,
  FinalPublicationCoordinator,
  MediaArtifactRecord,
  MediaArtifactRepository,
  PublishReadyInput,
  PublishReadyResult,
  ReserveMediaArtifactInput,
  ReserveMediaArtifactResult
} from "@/lib/storage/media-artifact-repository";
import {
  isMediaArtifactId,
  parseMediaStorageKey,
  type MediaArtifactKind,
  type MediaObjectDescriptor,
  type MediaStorageKey
} from "@/lib/storage/media-storage";
import {
  postgresRowToMediaArtifact,
  type PostgresMediaArtifactRow
} from "@/lib/storage/postgres/artifact-row-mapper";

const CONTENT_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/;
const CHECKSUM = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_BATCH = 1_000;

const ARTIFACT_COLUMNS = `
  artifact_id,
  job_id,
  attempt_id,
  kind,
  publication_state,
  storage_key,
  filename,
  content_type,
  byte_size,
  checksum_sha256,
  created_at,
  updated_at,
  published_at,
  expires_at,
  version
`;

const JOB_COLUMNS = `
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
  version
`;

type JobLeaseRow = PostgresMediaJobRow & Readonly<{
  lease_attempt_id: unknown;
  ownership_active?: unknown;
}>;

export class PostgresMediaArtifactRepositoryError extends Error {
  constructor(message = "PostgreSQL media artifact operation failed.") {
    super(message);
    this.name = "PostgresMediaArtifactRepositoryError";
  }
}

export type CreatePostgresMediaArtifactRepositoryOptions = Readonly<{
  pool: Pool;
}>;

export type PostgresMediaArtifactRuntime = Readonly<{
  artifacts: MediaArtifactRepository;
  publication: FinalPublicationCoordinator;
}>;

function artifactRecord(row: QueryResultRow): MediaArtifactRecord {
  try {
    return postgresRowToMediaArtifact(row as PostgresMediaArtifactRow);
  } catch {
    throw new PostgresMediaArtifactRepositoryError("PostgreSQL media artifact data was rejected.");
  }
}

function jobRecord(row: QueryResultRow): MediaJobRecord {
  try {
    return postgresRowToMediaJobRecord(row as PostgresMediaJobRow);
  } catch {
    throw new PostgresMediaArtifactRepositoryError("PostgreSQL media job data was rejected.");
  }
}

function validateLease(value: JobLeaseRef): JobLeaseRef {
  if (
    typeof value !== "object" ||
    value === null ||
    !isSafeDurableJobId(value.jobId) ||
    !isSafeJobWorkerId(value.workerId) ||
    !isSafeJobAttemptId(value.attemptId) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.leaseExpiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.leaseExpiresAt))
  ) throw new TypeError("Media artifact lease is invalid.");
  return value;
}

function leaseFromRow(row: JobLeaseRow): JobLeaseRef {
  const record = jobRecord(row);
  if (
    record.status !== "running" ||
    !isSafeJobWorkerId(record.leaseOwner) ||
    !isSafeJobAttemptId(row.lease_attempt_id) ||
    record.leaseExpiresAt === null
  ) throw new PostgresMediaArtifactRepositoryError("PostgreSQL lease data was rejected.");
  return Object.freeze({
    jobId: record.jobId,
    workerId: record.leaseOwner,
    attemptId: row.lease_attempt_id,
    version: record.version,
    leaseExpiresAt: record.leaseExpiresAt
  });
}

function batchLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH) throw new TypeError("Artifact batch limit is invalid.");
  return value;
}

function validateDescriptor(value: MediaObjectDescriptor): MediaObjectDescriptor {
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 1 ||
    value.sizeBytes > MAX_ARTIFACT_BYTES ||
    typeof value.checksumSha256 !== "string" ||
    !CHECKSUM.test(value.checksumSha256) ||
    typeof value.modifiedAt !== "string" ||
    !Number.isFinite(Date.parse(value.modifiedAt))
  ) throw new TypeError("Media object descriptor is invalid.");
  parseMediaStorageKey(value.key);
  return value;
}

function validateReservation(input: ReserveMediaArtifactInput): Readonly<{
  artifactId: string;
  kind: MediaArtifactKind;
  object: MediaObjectDescriptor;
  filename: string;
  contentType: string;
  ttlSeconds: number;
}> {
  if (!isMediaArtifactId(input?.artifactId, input?.kind)) throw new TypeError("Media artifact ID is invalid.");
  const object = validateDescriptor(input.object);
  const expectedDirectory = input.kind === "source" ? "/source/" : input.kind === "partial" ? "/partial/" : "/staged/";
  if (!object.key.startsWith("jobs/") || !object.key.includes(expectedDirectory)) {
    throw new TypeError("Media artifact storage kind is invalid.");
  }
  const sanitized = sanitizeFilename(input.filename, { fallback: "media", maxLength: 180 });
  if (!sanitized.ok || !CONTENT_TYPE.test(input.contentType)) throw new TypeError("Media artifact metadata is invalid.");
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 604_800) {
    throw new TypeError("Media artifact TTL is invalid.");
  }
  return Object.freeze({ ...input, object, filename: sanitized.value });
}

function reservationMatches(artifact: MediaArtifactRecord, lease: JobLeaseRef, input: ReturnType<typeof validateReservation>): boolean {
  return artifact.jobId === lease.jobId &&
    artifact.attemptId === lease.attemptId &&
    artifact.kind === input.kind &&
    artifact.publicationState === "staged" &&
    artifact.storageKey === input.object.key &&
    artifact.filename === input.filename &&
    artifact.contentType === input.contentType &&
    artifact.sizeBytes === input.object.sizeBytes &&
    artifact.checksumSha256 === input.object.checksumSha256;
}

function samePublishedObject(artifact: MediaArtifactRecord, input: PublishReadyInput): boolean {
  return artifact.artifactId === input.artifactId &&
    artifact.artifactId === input.publishedObject.fileId &&
    artifact.storageKey === input.publishedObject.key &&
    artifact.sizeBytes === input.publishedObject.sizeBytes &&
    artifact.checksumSha256 === input.publishedObject.checksumSha256;
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined);
}

export function createPostgresMediaArtifactRuntime(
  options: CreatePostgresMediaArtifactRepositoryOptions
): PostgresMediaArtifactRuntime {
  if (!options?.pool || typeof options.pool.connect !== "function") throw new TypeError("PostgreSQL artifact repository requires a pool.");
  const pool = options.pool;

  async function safeQuery<Row extends QueryResultRow>(sql: string, parameters: readonly unknown[] = []) {
    try {
      return await pool.query<Row>(sql, [...parameters]);
    } catch (error) {
      if (error instanceof PostgresMediaArtifactRepositoryError) throw error;
      throw new PostgresMediaArtifactRepositoryError();
    }
  }

  async function get(artifactId: string): Promise<MediaArtifactRecord | null> {
    if (!isMediaArtifactId(artifactId)) return null;
    const result = await safeQuery(`SELECT ${ARTIFACT_COLUMNS} FROM media_artifacts WHERE artifact_id = $1`, [artifactId]);
    return result.rows[0] ? artifactRecord(result.rows[0]) : null;
  }

  async function reserveOwned(leaseValue: JobLeaseRef, inputValue: ReserveMediaArtifactInput): Promise<ReserveMediaArtifactResult> {
    const lease = validateLease(leaseValue);
    let input: ReturnType<typeof validateReservation>;
    try {
      input = validateReservation(inputValue);
    } catch {
      const current = await safeQuery(`SELECT ${JOB_COLUMNS} FROM media_jobs WHERE job_id = $1`, [lease.jobId]);
      return Object.freeze({ outcome: "invalid-state", record: current.rows[0] ? jobRecord(current.rows[0]) : null });
    }
    const client = await pool.connect().catch(() => { throw new PostgresMediaArtifactRepositoryError(); });
    try {
      await client.query("BEGIN");
      const jobs = await client.query<JobLeaseRow>(
        `SELECT ${JOB_COLUMNS}, lease_attempt_id,
          (status = 'running' AND lease_owner = $2 AND lease_attempt_id = $3
            AND lease_expires_at > statement_timestamp()
            AND (deadline_at IS NULL OR deadline_at > statement_timestamp())
            AND cancellation_requested_at IS NULL) AS ownership_active
         FROM media_jobs WHERE job_id = $1 FOR UPDATE`,
        [lease.jobId, lease.workerId, lease.attemptId]
      );
      if (!jobs.rows[0]) {
        await rollback(client);
        return Object.freeze({ outcome: "not-found" });
      }
      const current = jobRecord(jobs.rows[0]);
      const existingRows = await client.query(`SELECT ${ARTIFACT_COLUMNS} FROM media_artifacts WHERE artifact_id = $1`, [input.artifactId]);
      const existing = existingRows.rows[0] ? artifactRecord(existingRows.rows[0]) : null;
      if (
        existing &&
        reservationMatches(existing, lease, input) &&
        jobs.rows[0].ownership_active === true &&
        current.version === lease.version + 1
      ) {
        await client.query("COMMIT");
        return Object.freeze({ outcome: "already-reserved", artifact: existing, lease: leaseFromRow(jobs.rows[0]) });
      }
      if (
        jobs.rows[0].ownership_active !== true ||
        current.version !== lease.version ||
        current.status !== "running"
      ) {
        await rollback(client);
        return current.status === "running"
          ? Object.freeze({ outcome: "ownership-lost" })
          : Object.freeze({ outcome: "invalid-state", record: current });
      }
      if (existing) {
        await rollback(client);
        return Object.freeze({ outcome: "invalid-state", record: current });
      }
      const inserted = await client.query(
        `INSERT INTO media_artifacts (
           artifact_id, job_id, attempt_id, kind, publication_state, storage_key,
           filename, content_type, byte_size, checksum_sha256, expires_at, version
         ) VALUES ($1, $2, $3, $4, 'staged', $5, $6, $7, $8, $9,
           statement_timestamp() + ($10::bigint * interval '1 second'), 1)
         RETURNING ${ARTIFACT_COLUMNS}`,
        [
          input.artifactId,
          lease.jobId,
          lease.attemptId,
          input.kind,
          input.object.key,
          input.filename,
          input.contentType,
          input.object.sizeBytes,
          input.object.checksumSha256,
          input.ttlSeconds
        ]
      );
      const updated = await client.query<JobLeaseRow>(
        `UPDATE media_jobs SET version = version + 1
         WHERE job_id = $1 AND version = $2
         RETURNING ${JOB_COLUMNS}, lease_attempt_id`,
        [lease.jobId, lease.version]
      );
      if (!inserted.rows[0] || !updated.rows[0]) throw new PostgresMediaArtifactRepositoryError();
      await client.query("COMMIT");
      return Object.freeze({
        outcome: "reserved",
        artifact: artifactRecord(inserted.rows[0]),
        lease: leaseFromRow(updated.rows[0])
      });
    } catch (error) {
      await rollback(client);
      if (error instanceof PostgresMediaArtifactRepositoryError) throw error;
      throw new PostgresMediaArtifactRepositoryError();
    } finally {
      client.release();
    }
  }

  async function getPublicFinal(fileId: string): Promise<MediaArtifactRecord | null> {
    if (!isMediaArtifactId(fileId, "final")) return null;
    const result = await safeQuery(
      `SELECT ${ARTIFACT_COLUMNS.replaceAll("\n  ", "\n  artifacts.")}
       FROM media_artifacts AS artifacts
       INNER JOIN media_jobs AS jobs ON jobs.job_id = artifacts.job_id
       WHERE artifacts.artifact_id = $1
         AND artifacts.kind = 'final'
         AND artifacts.publication_state = 'published'
         AND artifacts.expires_at > statement_timestamp()
         AND jobs.status = 'ready'
         AND jobs.final_result_metadata ->> 'fileId' = artifacts.artifact_id`,
      [fileId]
    );
    return result.rows[0] ? artifactRecord(result.rows[0]) : null;
  }

  async function listForJob(jobId: string): Promise<readonly MediaArtifactRecord[]> {
    if (!isSafeDurableJobId(jobId)) return Object.freeze([]);
    const result = await safeQuery(
      `SELECT ${ARTIFACT_COLUMNS} FROM media_artifacts WHERE job_id = $1 ORDER BY created_at, artifact_id`,
      [jobId]
    );
    return Object.freeze(result.rows.map(artifactRecord));
  }

  async function listReconciliationCandidates(limitValue: number): Promise<readonly MediaArtifactRecord[]> {
    const result = await safeQuery(
      `SELECT ${ARTIFACT_COLUMNS} FROM media_artifacts
       ORDER BY CASE publication_state WHEN 'staged' THEN 0 WHEN 'missing' THEN 1 ELSE 2 END,
         updated_at, artifact_id LIMIT $1`,
      [batchLimit(limitValue)]
    );
    return Object.freeze(result.rows.map(artifactRecord));
  }

  async function listExpiredPublished(limitValue: number): Promise<readonly MediaArtifactRecord[]> {
    const result = await safeQuery(
      `SELECT ${ARTIFACT_COLUMNS} FROM media_artifacts
       WHERE publication_state = 'published' AND expires_at <= statement_timestamp()
       ORDER BY expires_at, artifact_id LIMIT $1`,
      [batchLimit(limitValue)]
    );
    return Object.freeze(result.rows.map(artifactRecord));
  }

  async function findByStorageKeys(keys: readonly MediaStorageKey[]): Promise<readonly MediaArtifactRecord[]> {
    if (keys.length === 0) return Object.freeze([]);
    if (keys.length > MAX_BATCH) throw new TypeError("Artifact key lookup batch is too large.");
    const validated = keys.map((key) => parseMediaStorageKey(key));
    const result = await safeQuery(
      `SELECT ${ARTIFACT_COLUMNS} FROM media_artifacts WHERE storage_key = ANY($1::text[]) ORDER BY storage_key`,
      [validated]
    );
    return Object.freeze(result.rows.map(artifactRecord));
  }

  async function markMissing(artifactId: string, expectedVersion: number): Promise<ArtifactMutationResult> {
    if (!isMediaArtifactId(artifactId)) return Object.freeze({ outcome: "not-found" });
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new TypeError("Artifact version is invalid.");
    const updated = await safeQuery(
      `UPDATE media_artifacts SET publication_state = 'missing', updated_at = statement_timestamp(), version = version + 1
       WHERE artifact_id = $1 AND version = $2 AND publication_state <> 'missing'
       RETURNING ${ARTIFACT_COLUMNS}`,
      [artifactId, expectedVersion]
    );
    if (updated.rows[0]) return Object.freeze({ outcome: "updated", artifact: artifactRecord(updated.rows[0]) });
    const current = await get(artifactId);
    if (!current) return Object.freeze({ outcome: "not-found" });
    if (current.publicationState === "missing") return Object.freeze({ outcome: "unchanged", artifact: current });
    return Object.freeze({ outcome: "version-conflict", artifact: current });
  }

  async function deleteArtifact(artifactId: string, expectedVersion: number): Promise<ArtifactMutationResult> {
    if (!isMediaArtifactId(artifactId)) return Object.freeze({ outcome: "not-found" });
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new TypeError("Artifact version is invalid.");
    const deleted = await safeQuery(
      `DELETE FROM media_artifacts WHERE artifact_id = $1 AND version = $2 RETURNING ${ARTIFACT_COLUMNS}`,
      [artifactId, expectedVersion]
    );
    if (deleted.rows[0]) return Object.freeze({ outcome: "updated", artifact: artifactRecord(deleted.rows[0]) });
    const current = await get(artifactId);
    return current
      ? Object.freeze({ outcome: "version-conflict", artifact: current })
      : Object.freeze({ outcome: "not-found" });
  }

  async function isAttemptActive(jobId: string, attemptId: string): Promise<boolean> {
    if (!isSafeDurableJobId(jobId) || !isSafeJobAttemptId(attemptId)) return false;
    const result = await safeQuery(
      `SELECT 1 FROM media_jobs WHERE job_id = $1 AND lease_attempt_id = $2
       AND status = 'running' AND lease_expires_at > statement_timestamp()
       AND (deadline_at IS NULL OR deadline_at > statement_timestamp())
       AND cancellation_requested_at IS NULL`,
      [jobId, attemptId]
    );
    return Boolean(result.rows[0]);
  }

  async function isOwnedLeaseActive(leaseValue: JobLeaseRef): Promise<boolean> {
    const lease = validateLease(leaseValue);
    const result = await safeQuery(
      `SELECT 1 FROM media_jobs WHERE job_id = $1 AND lease_owner = $2
       AND lease_attempt_id = $3 AND version = $4 AND status = 'running'
       AND lease_expires_at > statement_timestamp()
       AND (deadline_at IS NULL OR deadline_at > statement_timestamp())
       AND cancellation_requested_at IS NULL`,
      [lease.jobId, lease.workerId, lease.attemptId, lease.version]
    );
    return Boolean(result.rows[0]);
  }

  async function completeReadyOwned(inputValue: PublishReadyInput): Promise<PublishReadyResult> {
    const lease = validateLease(inputValue.lease);
    if (!isMediaArtifactId(inputValue.artifactId, "final") || inputValue.publishedObject.fileId !== inputValue.artifactId) {
      return Object.freeze({ outcome: "invalid-state", record: null });
    }
    try {
      validateDescriptor(inputValue.publishedObject);
      if (!inputValue.publishedObject.key.startsWith("published/")) throw new TypeError();
    } catch {
      return Object.freeze({ outcome: "invalid-state", record: null });
    }
    const client = await pool.connect().catch(() => { throw new PostgresMediaArtifactRepositoryError(); });
    try {
      await client.query("BEGIN");
      const jobs = await client.query<JobLeaseRow>(
        `SELECT ${JOB_COLUMNS}, lease_attempt_id,
          (status = 'running' AND lease_owner = $2 AND lease_attempt_id = $3
            AND version = $4 AND lease_expires_at > statement_timestamp()
            AND (deadline_at IS NULL OR deadline_at > statement_timestamp())
            AND cancellation_requested_at IS NULL) AS ownership_active
         FROM media_jobs WHERE job_id = $1 FOR UPDATE`,
        [lease.jobId, lease.workerId, lease.attemptId, lease.version]
      );
      if (!jobs.rows[0]) {
        await rollback(client);
        return Object.freeze({ outcome: "not-found" });
      }
      const record = jobRecord(jobs.rows[0]);
      const artifactRows = await client.query(
        `SELECT ${ARTIFACT_COLUMNS} FROM media_artifacts WHERE artifact_id = $1 FOR UPDATE`,
        [inputValue.artifactId]
      );
      if (!artifactRows.rows[0]) {
        await rollback(client);
        return Object.freeze({ outcome: "not-found" });
      }
      const artifact = artifactRecord(artifactRows.rows[0]);
      if (
        record.status === "ready" &&
        artifact.publicationState === "published" &&
        record.finalMetadata?.fileId === artifact.artifactId &&
        samePublishedObject(artifact, inputValue)
      ) {
        await client.query("COMMIT");
        return Object.freeze({ outcome: "already-completed", artifact, record });
      }
      if (jobs.rows[0].ownership_active !== true) {
        await rollback(client);
        return record.status === "running"
          ? Object.freeze({ outcome: "ownership-lost" })
          : Object.freeze({ outcome: "invalid-state", record });
      }
      if (
        artifact.jobId !== lease.jobId ||
        artifact.attemptId !== lease.attemptId ||
        artifact.kind !== "final" ||
        artifact.publicationState !== "staged" ||
        artifact.sizeBytes !== inputValue.publishedObject.sizeBytes ||
        artifact.checksumSha256 !== inputValue.publishedObject.checksumSha256
      ) {
        await rollback(client);
        return Object.freeze({ outcome: "invalid-state", record });
      }
      let result;
      try {
        result = sanitizeMediaJobResult({
          fileId: artifact.artifactId,
          downloadUrl: `/api/file/${artifact.artifactId}`,
          filename: artifact.filename,
          sizeBytes: artifact.sizeBytes,
          mimeType: artifact.contentType,
          expiresAt: artifact.expiresAt,
          processingPreset: record.processingPreset,
          media: inputValue.media
        }, record.processingPreset);
      } catch {
        await rollback(client);
        return Object.freeze({ outcome: "invalid-state", record });
      }
      const published = await client.query(
        `UPDATE media_artifacts
         SET publication_state = 'published', storage_key = $2,
           published_at = statement_timestamp(), updated_at = statement_timestamp(), version = version + 1
         WHERE artifact_id = $1 AND version = $3 AND publication_state = 'staged'
         RETURNING ${ARTIFACT_COLUMNS}`,
        [artifact.artifactId, inputValue.publishedObject.key, artifact.version]
      );
      const completed = await client.query(
        `UPDATE media_jobs SET status = 'ready', progress = 100,
           final_result_metadata = $2::jsonb, canonical_error = NULL,
           completed_at = statement_timestamp(), expires_at = $3::timestamptz,
           cancellation_requested_at = NULL, lease_owner = NULL,
           lease_expires_at = NULL, lease_attempt_id = NULL,
           source_url = NULL, format_id = NULL,
           available_at = NULL, deadline_at = NULL, version = version + 1
         WHERE job_id = $1 AND status = 'running' AND version = $4
         RETURNING ${JOB_COLUMNS}`,
        [lease.jobId, JSON.stringify(result), artifact.expiresAt, lease.version]
      );
      if (!published.rows[0] || !completed.rows[0]) throw new PostgresMediaArtifactRepositoryError();
      await client.query("COMMIT");
      return Object.freeze({
        outcome: "completed",
        artifact: artifactRecord(published.rows[0]),
        record: jobRecord(completed.rows[0])
      });
    } catch (error) {
      await rollback(client);
      if (error instanceof PostgresMediaArtifactRepositoryError) throw error;
      throw new PostgresMediaArtifactRepositoryError();
    } finally {
      client.release();
    }
  }

  const artifacts: MediaArtifactRepository = Object.freeze({
    reserveOwned,
    get,
    getPublicFinal,
    listForJob,
    listReconciliationCandidates,
    listExpiredPublished,
    findByStorageKeys,
    markMissing,
    delete: deleteArtifact,
    isAttemptActive,
    isOwnedLeaseActive
  });
  const publication: FinalPublicationCoordinator = Object.freeze({ completeReadyOwned });
  return Object.freeze({ artifacts, publication });
}
