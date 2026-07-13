import "server-only";
import { validateMediaJobRecord } from "@/lib/jobs/job-record";
import type { MediaJobRecord } from "@/lib/jobs/types";

export const POSTGRES_JOB_JSON_MAX_BYTES = 256 * 1024;

export class PostgresRowMappingError extends Error {
  constructor() {
    super("PostgreSQL media job row is invalid.");
    this.name = "PostgresRowMappingError";
  }
}

export type PostgresMediaJobRow = Readonly<{
  job_id: unknown;
  status: unknown;
  progress: unknown;
  processing_preset: unknown;
  source_metadata: unknown;
  final_result_metadata: unknown;
  canonical_error: unknown;
  created_at: unknown;
  started_at: unknown;
  completed_at: unknown;
  expires_at: unknown;
  cancellation_requested_at: unknown;
  retry_count: unknown;
  lease_owner: unknown;
  lease_expires_at: unknown;
  version: unknown;
}>;

function timestamp(value: unknown): string | null {
  if (value === null) return null;
  if (!(value instanceof Date) && typeof value !== "string") {
    throw new PostgresRowMappingError();
  }
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new PostgresRowMappingError();
  return parsed.toISOString();
}

function integer(value: unknown): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
    throw new PostgresRowMappingError();
  }
  return parsed as number;
}

function jsonClone(value: unknown): unknown {
  if (value === null) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new PostgresRowMappingError();
  }
  if (Buffer.byteLength(serialized, "utf8") > POSTGRES_JOB_JSON_MAX_BYTES) {
    throw new PostgresRowMappingError();
  }
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new PostgresRowMappingError();
  }
}

function jsonParameter(value: unknown): string | null {
  if (value === null) return null;
  const cloned = jsonClone(value);
  return JSON.stringify(cloned);
}

export function postgresRowToMediaJobRecord(row: PostgresMediaJobRow): MediaJobRecord {
  try {
    return validateMediaJobRecord({
      jobId: row.job_id,
      status: row.status,
      progress: row.progress,
      processingPreset: row.processing_preset,
      sourceMetadata: jsonClone(row.source_metadata),
      finalMetadata: jsonClone(row.final_result_metadata),
      canonicalError: jsonClone(row.canonical_error),
      createdAt: timestamp(row.created_at),
      startedAt: timestamp(row.started_at),
      completedAt: timestamp(row.completed_at),
      expiresAt: timestamp(row.expires_at),
      cancellationRequestedAt: timestamp(row.cancellation_requested_at),
      retryCount: integer(row.retry_count),
      leaseOwner: row.lease_owner,
      leaseExpiresAt: timestamp(row.lease_expires_at),
      version: integer(row.version)
    });
  } catch {
    throw new PostgresRowMappingError();
  }
}

/** Parameters follow the authoritative migration column order. */
export function mediaJobRecordToPostgresParameters(record: MediaJobRecord): readonly unknown[] {
  let validated: MediaJobRecord;
  try {
    validated = validateMediaJobRecord(record);
  } catch {
    throw new PostgresRowMappingError();
  }
  return Object.freeze([
    validated.jobId,
    validated.status,
    validated.progress,
    validated.processingPreset,
    jsonParameter(validated.sourceMetadata),
    jsonParameter(validated.finalMetadata),
    jsonParameter(validated.canonicalError),
    validated.createdAt,
    validated.startedAt,
    validated.completedAt,
    validated.expiresAt,
    validated.cancellationRequestedAt,
    validated.retryCount,
    validated.leaseOwner,
    validated.leaseExpiresAt,
    validated.version
  ]);
}
