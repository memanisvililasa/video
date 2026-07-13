import "server-only";
import {
  isMediaArtifactId,
  parseMediaStorageKey,
  type MediaArtifactKind,
  type MediaPublicationState
} from "@/lib/storage/media-storage";
import type { MediaArtifactRecord } from "@/lib/storage/media-artifact-repository";
import { isSafeDurableJobId, isSafeJobAttemptId } from "@/lib/jobs/job-lease-queue";

const STATES = new Set<MediaPublicationState>(["staged", "published", "missing"]);
const KINDS = new Set<MediaArtifactKind>(["source", "partial", "final"]);
const CONTENT_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/;
const CHECKSUM = /^[a-f0-9]{64}$/;

export class PostgresMediaArtifactRowError extends Error {
  constructor() {
    super("PostgreSQL media artifact row is invalid.");
    this.name = "PostgresMediaArtifactRowError";
  }
}

export type PostgresMediaArtifactRow = Readonly<{
  artifact_id: unknown;
  job_id: unknown;
  attempt_id: unknown;
  kind: unknown;
  publication_state: unknown;
  storage_key: unknown;
  filename: unknown;
  content_type: unknown;
  byte_size: unknown;
  checksum_sha256: unknown;
  created_at: unknown;
  updated_at: unknown;
  published_at: unknown;
  expires_at: unknown;
  version: unknown;
}>;

function timestamp(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (!(value instanceof Date) && typeof value !== "string") throw new PostgresMediaArtifactRowError();
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new PostgresMediaArtifactRowError();
  return parsed.toISOString();
}

function integer(value: unknown, minimum: number): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < minimum) throw new PostgresMediaArtifactRowError();
  return parsed as number;
}

export function postgresRowToMediaArtifact(row: PostgresMediaArtifactRow): MediaArtifactRecord {
  try {
    if (!KINDS.has(row.kind as MediaArtifactKind) || !STATES.has(row.publication_state as MediaPublicationState)) {
      throw new PostgresMediaArtifactRowError();
    }
    const kind = row.kind as MediaArtifactKind;
    const state = row.publication_state as MediaPublicationState;
    if (
      !isMediaArtifactId(row.artifact_id, kind) ||
      !isSafeDurableJobId(row.job_id) ||
      !isSafeJobAttemptId(row.attempt_id) ||
      typeof row.filename !== "string" ||
      row.filename.length < 1 ||
      row.filename.length > 180 ||
      /[/\\\u0000-\u001f\u007f]/.test(row.filename) ||
      typeof row.content_type !== "string" ||
      !CONTENT_TYPE.test(row.content_type) ||
      typeof row.checksum_sha256 !== "string" ||
      !CHECKSUM.test(row.checksum_sha256)
    ) throw new PostgresMediaArtifactRowError();
    const createdAt = timestamp(row.created_at) as string;
    const updatedAt = timestamp(row.updated_at) as string;
    const publishedAt = timestamp(row.published_at, true);
    const expiresAt = timestamp(row.expires_at) as string;
    if (
      Date.parse(updatedAt) < Date.parse(createdAt) ||
      Date.parse(expiresAt) < Date.parse(createdAt) ||
      (publishedAt !== null && Date.parse(publishedAt) < Date.parse(createdAt)) ||
      (state === "staged" && publishedAt !== null) ||
      (state === "published" && (kind !== "final" || publishedAt === null))
    ) throw new PostgresMediaArtifactRowError();
    return Object.freeze({
      artifactId: row.artifact_id,
      jobId: row.job_id,
      attemptId: row.attempt_id,
      kind,
      publicationState: state,
      storageKey: parseMediaStorageKey(row.storage_key),
      filename: row.filename,
      contentType: row.content_type,
      sizeBytes: integer(row.byte_size, 1),
      checksumSha256: row.checksum_sha256,
      createdAt,
      updatedAt,
      publishedAt,
      expiresAt,
      version: integer(row.version, 1)
    });
  } catch {
    throw new PostgresMediaArtifactRowError();
  }
}
