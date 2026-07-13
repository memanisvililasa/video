import { API_ERROR_MESSAGES, AppError } from "@/lib/errors";
import type { ProcessingPreset } from "@/lib/ffmpeg/types";
import type {
  MediaJobFailure,
  MediaJobOutputMetadata,
  MediaJobRecord,
  MediaJobResult,
  MediaJobSnapshot,
  MediaJobSourceMetadata,
  MediaJobStatus
} from "@/lib/jobs/types";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";

const SAFE_JOB_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_FILE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_SOURCE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_CONTENT_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/;
const SAFE_MEDIA_IDENTIFIER = /^[a-zA-Z0-9_.-]{1,256}$/;
const SAFE_LEASE_OWNER = /^[a-zA-Z0-9_.:-]{1,128}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const VALID_PROCESSING_PRESETS = new Set<ProcessingPreset>([
  "original",
  "remux-to-mp4",
  "compatible-mp4",
  "audio-only"
]);
const TERMINAL_STATUSES = new Set<MediaJobStatus>(["ready", "failed", "cancelled"]);

const ALLOWED_TRANSITIONS: Readonly<Record<MediaJobStatus, ReadonlySet<MediaJobStatus>>> = {
  queued: new Set(["running", "cancelled"]),
  running: new Set(["ready", "failed", "cancelled"]),
  ready: new Set(["expired"]),
  failed: new Set(["expired"]),
  cancelled: new Set(["expired"]),
  expired: new Set()
};

export type CreateMediaJobRecordInput = Readonly<{
  jobId: string;
  processingPreset: ProcessingPreset;
}>;

export type MediaJobSourceMetadataInput = Readonly<{
  sourceId: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
}>;

export type MediaJobMutation =
  | Readonly<{ type: "start" }>
  | Readonly<{ type: "progress"; progress: number }>
  | Readonly<{ type: "set-source-metadata"; sourceMetadata: MediaJobSourceMetadataInput }>
  | Readonly<{ type: "complete"; result: MediaJobResult }>
  | Readonly<{ type: "fail"; errorCode: ApiErrorCode }>
  | Readonly<{ type: "cancel" }>
  | Readonly<{ type: "expire" }>;

export type ApplyMediaJobMutationResult =
  | Readonly<{ ok: true; record: MediaJobRecord }>
  | Readonly<{ ok: false }>;

function isoTimestamp(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("Media job clock must return a finite timestamp.");
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TypeError("Media job clock returned an unsupported timestamp.");
  }
  return timestamp.toISOString();
}

export function createCanonicalMediaJobFailure(code: ApiErrorCode): MediaJobFailure {
  if (!Object.prototype.hasOwnProperty.call(API_ERROR_MESSAGES, code)) {
    throw new TypeError("Media job canonical error code is invalid.");
  }
  return Object.freeze({ code, message: API_ERROR_MESSAGES[code] });
}

function sanitizeOptionalIdentifier(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && SAFE_MEDIA_IDENTIFIER.test(value) ? value : undefined;
}

function sanitizeOutputMetadata(value: unknown): MediaJobOutputMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Media job output metadata is invalid.");
  }

  const metadata = value as Partial<MediaJobOutputMetadata>;
  const width = metadata.width;
  const height = metadata.height;
  const videoCodec = sanitizeOptionalIdentifier(metadata.videoCodec);
  const audioCodec = sanitizeOptionalIdentifier(metadata.audioCodec);
  if (
    typeof metadata.durationSeconds !== "number" ||
    !Number.isFinite(metadata.durationSeconds) ||
    metadata.durationSeconds <= 0 ||
    typeof metadata.formatName !== "string" ||
    !metadata.formatName ||
    metadata.formatName.length > 256 ||
    CONTROL_CHARACTERS.test(metadata.formatName) ||
    typeof metadata.hasVideo !== "boolean" ||
    typeof metadata.hasAudio !== "boolean" ||
    (width !== undefined && (!Number.isSafeInteger(width) || width <= 0 || width > 16_384)) ||
    (height !== undefined && (!Number.isSafeInteger(height) || height <= 0 || height > 16_384)) ||
    (metadata.videoCodec !== undefined && videoCodec === undefined) ||
    (metadata.audioCodec !== undefined && audioCodec === undefined)
  ) {
    throw new TypeError("Media job output metadata is invalid.");
  }

  return Object.freeze({
    durationSeconds: metadata.durationSeconds,
    formatName: metadata.formatName,
    hasVideo: metadata.hasVideo,
    hasAudio: metadata.hasAudio,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(videoCodec ? { videoCodec } : {}),
    ...(audioCodec ? { audioCodec } : {})
  });
}

export function sanitizeMediaJobResult(
  value: unknown,
  expectedPreset: ProcessingPreset
): MediaJobResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Media job result is invalid.");
  }

  const result = value as Partial<MediaJobResult>;
  if (
    typeof result.fileId !== "string" ||
    !SAFE_FILE_ID.test(result.fileId) ||
    result.downloadUrl !== `/api/file/${result.fileId}` ||
    typeof result.filename !== "string" ||
    !result.filename ||
    result.filename.length > 180 ||
    result.filename.includes("/") ||
    result.filename.includes("\\") ||
    CONTROL_CHARACTERS.test(result.filename) ||
    !Number.isSafeInteger(result.sizeBytes) ||
    (result.sizeBytes as number) <= 0 ||
    typeof result.mimeType !== "string" ||
    !SAFE_CONTENT_TYPE.test(result.mimeType) ||
    typeof result.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(result.expiresAt))
  ) {
    throw new TypeError("Media job result is invalid.");
  }

  return Object.freeze({
    fileId: result.fileId,
    downloadUrl: result.downloadUrl,
    filename: result.filename,
    sizeBytes: result.sizeBytes,
    mimeType: result.mimeType,
    expiresAt: result.expiresAt,
    processingPreset: expectedPreset,
    media: sanitizeOutputMetadata(result.media)
  }) as MediaJobResult;
}

export function sanitizeMediaJobSourceMetadata(
  value: MediaJobSourceMetadataInput,
  registeredAt: string
): MediaJobSourceMetadata {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.sourceId !== "string" ||
    !SAFE_SOURCE_ID.test(value.sourceId) ||
    typeof value.filename !== "string" ||
    !value.filename ||
    value.filename.length > 180 ||
    value.filename.includes("/") ||
    value.filename.includes("\\") ||
    CONTROL_CHARACTERS.test(value.filename) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes <= 0 ||
    typeof value.contentType !== "string" ||
    !SAFE_CONTENT_TYPE.test(value.contentType)
  ) {
    throw new TypeError("Media job source metadata is invalid.");
  }

  return Object.freeze({
    sourceId: value.sourceId,
    filename: value.filename,
    sizeBytes: value.sizeBytes,
    contentType: value.contentType,
    registeredAt
  });
}

function cloneResult(result: Readonly<MediaJobResult> | null): Readonly<MediaJobResult> | null {
  if (!result) return null;
  return Object.freeze({ ...result, media: Object.freeze({ ...result.media }) });
}

function cloneSourceMetadata(
  sourceMetadata: MediaJobSourceMetadata | null
): MediaJobSourceMetadata | null {
  return sourceMetadata ? Object.freeze({ ...sourceMetadata }) : null;
}

function freezeRecord(record: MediaJobRecord): MediaJobRecord {
  return Object.freeze({
    ...record,
    sourceMetadata: cloneSourceMetadata(record.sourceMetadata),
    finalMetadata: cloneResult(record.finalMetadata),
    canonicalError: record.canonicalError ? Object.freeze({ ...record.canonicalError }) : null
  });
}

function hasOnlyKeys(value: object, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function requireIsoTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} is invalid.`);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function optionalIsoTimestamp(value: unknown, name: string): string | null {
  return value === null ? null : requireIsoTimestamp(value, name);
}

function validateTimestampOrder(record: MediaJobRecord): void {
  const createdAt = Date.parse(record.createdAt);
  const startedAt = record.startedAt ? Date.parse(record.startedAt) : null;
  const completedAt = record.completedAt ? Date.parse(record.completedAt) : null;
  const expiresAt = record.expiresAt ? Date.parse(record.expiresAt) : null;
  const cancellationRequestedAt = record.cancellationRequestedAt
    ? Date.parse(record.cancellationRequestedAt)
    : null;

  if (
    (startedAt !== null && startedAt < createdAt) ||
    (completedAt !== null && completedAt < (startedAt ?? createdAt)) ||
    (expiresAt !== null && completedAt !== null && expiresAt < completedAt) ||
    (cancellationRequestedAt !== null && cancellationRequestedAt < createdAt) ||
    (record.sourceMetadata !== null &&
      Date.parse(record.sourceMetadata.registeredAt) < (startedAt ?? createdAt))
  ) {
    throw new TypeError("Media job lifecycle timestamps are inconsistent.");
  }
}

function validateLifecycleShape(record: MediaJobRecord): void {
  const activeShape =
    record.completedAt === null &&
    record.expiresAt === null &&
    record.cancellationRequestedAt === null &&
    record.finalMetadata === null &&
    record.canonicalError === null;
  const readyShape =
    record.startedAt !== null &&
    record.completedAt !== null &&
    record.expiresAt !== null &&
    record.cancellationRequestedAt === null &&
    record.progress === 100 &&
    record.finalMetadata !== null &&
    record.canonicalError === null;
  const failedShape =
    record.startedAt !== null &&
    record.completedAt !== null &&
    record.expiresAt !== null &&
    record.cancellationRequestedAt === null &&
    record.finalMetadata === null &&
    record.canonicalError !== null &&
    record.canonicalError.code !== API_ERROR_CODES.JOB_CANCELLED;
  const cancelledShape =
    record.completedAt !== null &&
    record.expiresAt !== null &&
    record.cancellationRequestedAt !== null &&
    record.finalMetadata === null &&
    record.canonicalError?.code === API_ERROR_CODES.JOB_CANCELLED;

  switch (record.status) {
    case "queued":
      if (!activeShape || record.startedAt !== null || record.sourceMetadata !== null) {
        throw new TypeError("Queued media job state is inconsistent.");
      }
      break;
    case "running":
      if (!activeShape || record.startedAt === null) {
        throw new TypeError("Running media job state is inconsistent.");
      }
      break;
    case "ready":
      if (!readyShape) throw new TypeError("Ready media job state is inconsistent.");
      break;
    case "failed":
      if (!failedShape) throw new TypeError("Failed media job state is inconsistent.");
      break;
    case "cancelled":
      if (!cancelledShape) throw new TypeError("Cancelled media job state is inconsistent.");
      break;
    case "expired":
      if (!readyShape && !failedShape && !cancelledShape) {
        throw new TypeError("Expired media job state is inconsistent.");
      }
      break;
  }
}

/**
 * Fail-closed validation for records crossing a persistence boundary. The
 * returned value is a new deeply frozen record and never aliases JSONB values.
 */
export function validateMediaJobRecord(value: unknown): MediaJobRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Persistent media job record is invalid.");
  }
  const candidate = value as Partial<MediaJobRecord>;
  if (
    typeof candidate.jobId !== "string" ||
    !SAFE_JOB_ID.test(candidate.jobId) ||
    typeof candidate.status !== "string" ||
    !Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, candidate.status) ||
    typeof candidate.processingPreset !== "string" ||
    !VALID_PROCESSING_PRESETS.has(candidate.processingPreset as ProcessingPreset) ||
    typeof candidate.progress !== "number" ||
    !Number.isFinite(candidate.progress) ||
    candidate.progress < 0 ||
    candidate.progress > 100 ||
    !Number.isSafeInteger(candidate.retryCount) ||
    (candidate.retryCount as number) < 0 ||
    !Number.isSafeInteger(candidate.version) ||
    (candidate.version as number) < 1 ||
    (candidate.leaseOwner !== null &&
      (typeof candidate.leaseOwner !== "string" || !SAFE_LEASE_OWNER.test(candidate.leaseOwner)))
  ) {
    throw new TypeError("Persistent media job record is invalid.");
  }

  const createdAt = requireIsoTimestamp(candidate.createdAt, "Media job createdAt");
  const startedAt = optionalIsoTimestamp(candidate.startedAt, "Media job startedAt");
  const completedAt = optionalIsoTimestamp(candidate.completedAt, "Media job completedAt");
  const expiresAt = optionalIsoTimestamp(candidate.expiresAt, "Media job expiresAt");
  const cancellationRequestedAt = optionalIsoTimestamp(
    candidate.cancellationRequestedAt,
    "Media job cancellationRequestedAt"
  );
  const leaseExpiresAt = optionalIsoTimestamp(
    candidate.leaseExpiresAt,
    "Media job leaseExpiresAt"
  );

  let sourceMetadata: MediaJobSourceMetadata | null = null;
  if (candidate.sourceMetadata !== null) {
    if (
      typeof candidate.sourceMetadata !== "object" ||
      Array.isArray(candidate.sourceMetadata) ||
      !hasOnlyKeys(candidate.sourceMetadata, [
        "sourceId",
        "filename",
        "sizeBytes",
        "contentType",
        "registeredAt"
      ])
    ) {
      throw new TypeError("Media job source metadata is invalid.");
    }
    const registeredAt = requireIsoTimestamp(
      candidate.sourceMetadata.registeredAt,
      "Media job source registeredAt"
    );
    sourceMetadata = sanitizeMediaJobSourceMetadata(candidate.sourceMetadata, registeredAt);
  }

  let finalMetadata: Readonly<MediaJobResult> | null = null;
  if (candidate.finalMetadata !== null) {
    if (
      typeof candidate.finalMetadata !== "object" ||
      Array.isArray(candidate.finalMetadata) ||
      !hasOnlyKeys(candidate.finalMetadata, [
        "fileId",
        "downloadUrl",
        "filename",
        "sizeBytes",
        "mimeType",
        "expiresAt",
        "processingPreset",
        "media"
      ]) ||
      typeof candidate.finalMetadata.media !== "object" ||
      candidate.finalMetadata.media === null ||
      Array.isArray(candidate.finalMetadata.media) ||
      !hasOnlyKeys(candidate.finalMetadata.media, [
        "durationSeconds",
        "formatName",
        "hasVideo",
        "hasAudio",
        "width",
        "height",
        "videoCodec",
        "audioCodec"
      ]) ||
      candidate.finalMetadata.processingPreset !== candidate.processingPreset
    ) {
      throw new TypeError("Media job result is invalid.");
    }
    finalMetadata = sanitizeMediaJobResult(
      candidate.finalMetadata,
      candidate.processingPreset
    );
  }

  let canonicalError: Readonly<MediaJobFailure> | null = null;
  if (candidate.canonicalError !== null) {
    if (
      typeof candidate.canonicalError !== "object" ||
      Array.isArray(candidate.canonicalError) ||
      !hasOnlyKeys(candidate.canonicalError, ["code", "message"])
    ) {
      throw new TypeError("Media job canonical error is invalid.");
    }
    canonicalError = createCanonicalMediaJobFailure(candidate.canonicalError.code as ApiErrorCode);
    if (candidate.canonicalError.message !== canonicalError.message) {
      throw new TypeError("Media job canonical error is invalid.");
    }
  }

  const record = freezeRecord({
    jobId: candidate.jobId,
    status: candidate.status as MediaJobStatus,
    processingPreset: candidate.processingPreset,
    createdAt,
    startedAt,
    completedAt,
    expiresAt,
    cancellationRequestedAt,
    progress: candidate.progress,
    sourceMetadata,
    finalMetadata,
    canonicalError,
    retryCount: candidate.retryCount as number,
    leaseOwner: candidate.leaseOwner,
    leaseExpiresAt,
    version: candidate.version as number
  });
  if (
    (record.leaseOwner === null) !== (record.leaseExpiresAt === null) ||
    (record.status !== "running" &&
      (record.leaseOwner !== null || record.leaseExpiresAt !== null))
  ) {
    throw new TypeError("Media job lease state is inconsistent.");
  }
  validateLifecycleShape(record);
  validateTimestampOrder(record);
  return record;
}

export function cloneMediaJobRecord(record: MediaJobRecord): MediaJobRecord {
  return freezeRecord(record);
}

export function isMediaJobTerminal(status: MediaJobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function assertMediaJobTransition(from: MediaJobStatus, to: MediaJobStatus): void {
  if (!ALLOWED_TRANSITIONS[from]?.has(to)) {
    throw new AppError(API_ERROR_CODES.INVALID_JOB_STATE);
  }
}

export function createMediaJobRecord(
  input: CreateMediaJobRecordInput,
  nowMs: number
): MediaJobRecord {
  if (
    typeof input !== "object" ||
    input === null ||
    !SAFE_JOB_ID.test(input.jobId) ||
    !VALID_PROCESSING_PRESETS.has(input.processingPreset)
  ) {
    throw new TypeError("Media job creation input is invalid.");
  }

  return freezeRecord({
    jobId: input.jobId,
    status: "queued",
    processingPreset: input.processingPreset,
    createdAt: isoTimestamp(nowMs),
    startedAt: null,
    completedAt: null,
    expiresAt: null,
    cancellationRequestedAt: null,
    progress: 0,
    sourceMetadata: null,
    finalMetadata: null,
    canonicalError: null,
    retryCount: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    version: 1
  });
}

function transitionRecord(
  record: MediaJobRecord,
  status: MediaJobStatus,
  nowMs: number,
  terminalTtlMs: number,
  changes: Partial<MediaJobRecord> = {}
): MediaJobRecord {
  assertMediaJobTransition(record.status, status);
  const timestamp = isoTimestamp(nowMs);
  const terminal = TERMINAL_STATUSES.has(status);
  return freezeRecord({
    ...record,
    ...changes,
    status,
    ...(status === "running" ? { startedAt: timestamp } : {}),
    ...(terminal
      ? {
          completedAt: timestamp,
          expiresAt: isoTimestamp(nowMs + terminalTtlMs),
          leaseOwner: null,
          leaseExpiresAt: null
        }
      : {}),
    version: record.version + 1
  });
}

export function applyMediaJobMutation(
  record: MediaJobRecord,
  mutation: MediaJobMutation,
  nowMs: number,
  terminalTtlMs: number
): ApplyMediaJobMutationResult {
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(terminalTtlMs) || terminalTtlMs < 0) {
    throw new TypeError("Media job mutation timing is invalid.");
  }

  try {
    switch (mutation.type) {
      case "start":
        return { ok: true, record: transitionRecord(record, "running", nowMs, terminalTtlMs) };
      case "progress": {
        if (
          record.status !== "running" ||
          !Number.isFinite(mutation.progress) ||
          mutation.progress < 0 ||
          mutation.progress > 100 ||
          mutation.progress < record.progress
        ) {
          return { ok: false };
        }
        return {
          ok: true,
          record: freezeRecord({ ...record, progress: mutation.progress, version: record.version + 1 })
        };
      }
      case "set-source-metadata": {
        if (record.status !== "running" || record.sourceMetadata !== null) return { ok: false };
        const sourceMetadata = sanitizeMediaJobSourceMetadata(
          mutation.sourceMetadata,
          isoTimestamp(nowMs)
        );
        return {
          ok: true,
          record: freezeRecord({ ...record, sourceMetadata, version: record.version + 1 })
        };
      }
      case "complete": {
        if (record.status !== "running") return { ok: false };
        const finalMetadata = sanitizeMediaJobResult(mutation.result, record.processingPreset);
        return {
          ok: true,
          record: transitionRecord(record, "ready", nowMs, terminalTtlMs, {
            progress: 100,
            finalMetadata,
            canonicalError: null
          })
        };
      }
      case "fail":
        if (record.status !== "running") return { ok: false };
        return {
          ok: true,
          record: transitionRecord(record, "failed", nowMs, terminalTtlMs, {
            canonicalError: createCanonicalMediaJobFailure(mutation.errorCode),
            finalMetadata: null
          })
        };
      case "cancel":
        if (record.status !== "queued" && record.status !== "running") return { ok: false };
        return {
          ok: true,
          record: transitionRecord(record, "cancelled", nowMs, terminalTtlMs, {
            cancellationRequestedAt: isoTimestamp(nowMs),
            canonicalError: createCanonicalMediaJobFailure(API_ERROR_CODES.JOB_CANCELLED),
            finalMetadata: null
          })
        };
      case "expire":
        if (!TERMINAL_STATUSES.has(record.status)) return { ok: false };
        return {
          ok: true,
          record: transitionRecord(record, "expired", nowMs, terminalTtlMs)
        };
      default: {
        const exhaustive: never = mutation;
        throw exhaustive;
      }
    }
  } catch (error) {
    if (error instanceof AppError || error instanceof TypeError) return { ok: false };
    throw error;
  }
}

export function mediaJobRecordToSnapshot(record: MediaJobRecord): MediaJobSnapshot {
  const result = cloneResult(record.finalMetadata);
  const error = record.canonicalError ? Object.freeze({ ...record.canonicalError }) : undefined;
  return Object.freeze({
    jobId: record.jobId,
    status: record.status,
    processingPreset: record.processingPreset,
    createdAt: record.createdAt,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    progress: record.progress,
    ...(result ? { result } : {}),
    ...(error ? { error } : {})
  });
}
