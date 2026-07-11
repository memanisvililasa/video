import {
  isProcessingPreset,
  type CreateDownloadJobData,
  type MediaJobApiError,
  type MediaJobApiMetadata,
  type MediaJobApiResult,
  type MediaJobApiSnapshot,
  type MediaJobApiStatus,
  type ProcessingPreset
} from "@/lib/api/media-job-dto";
import { API_ERROR_MESSAGES, AppError } from "@/lib/errors";
import type { ProcessingPreset as InternalProcessingPreset } from "@/lib/ffmpeg/types";
import type { MediaJobOutputMetadata, MediaJobResult, MediaJobSnapshot } from "@/lib/jobs/types";
import { isValidJobId } from "@/lib/api/media-job-validation";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";

const FILE_ID = /^file_[a-zA-Z0-9_-]+$/;
const MAX_FILE_ID_LENGTH = 128;
const MAX_FILENAME_LENGTH = 180;
const MAX_FORMAT_NAME_LENGTH = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/;
const FORMAT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9,._-]*$/;
const MEDIA_IDENTIFIER = /^[a-zA-Z0-9_.-]{1,256}$/;
const API_ERROR_CODE_SET: ReadonlySet<string> = new Set(Object.values(API_ERROR_CODES));
const MEDIA_JOB_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
  "expired"
]);

type PresetUnionsMatch =
  Exclude<InternalProcessingPreset, ProcessingPreset> extends never
    ? Exclude<ProcessingPreset, InternalProcessingPreset> extends never
      ? true
      : false
    : false;

const PRESET_UNIONS_MATCH: PresetUnionsMatch = true;

type SerializedBase = Readonly<{
  jobId: string;
  status: MediaJobApiStatus;
  progress: number;
  processingPreset: ProcessingPreset;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
}>;

function internalError(): AppError {
  return new AppError(API_ERROR_CODES.INTERNAL_ERROR);
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && API_ERROR_CODE_SET.has(value);
}

function isMediaJobStatus(value: unknown): value is MediaJobApiStatus {
  return typeof value === "string" && MEDIA_JOB_STATUSES.has(value);
}

function isSafeFileId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 6 &&
    value.length <= MAX_FILE_ID_LENGTH &&
    !CONTROL_CHARACTERS.test(value) &&
    FILE_ID.test(value)
  );
}

function normalizeProgress(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function normalizeRequiredTimestamp(value: unknown): string {
  if (typeof value !== "string") throw internalError();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw internalError();
  return new Date(timestamp).toISOString();
}

function normalizeOptionalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function sanitizeOptionalMediaIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && MEDIA_IDENTIFIER.test(value) ? value : undefined;
}

function serializeMetadata(value: MediaJobOutputMetadata): MediaJobApiMetadata | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const metadata = value as Partial<MediaJobOutputMetadata>;
  if (
    typeof metadata.durationSeconds !== "number" ||
    !Number.isFinite(metadata.durationSeconds) ||
    metadata.durationSeconds <= 0 ||
    typeof metadata.formatName !== "string" ||
    !metadata.formatName ||
    metadata.formatName.length > MAX_FORMAT_NAME_LENGTH ||
    CONTROL_CHARACTERS.test(metadata.formatName) ||
    !FORMAT_NAME.test(metadata.formatName) ||
    typeof metadata.hasVideo !== "boolean" ||
    typeof metadata.hasAudio !== "boolean"
  ) {
    return null;
  }

  const width = metadata.width;
  const height = metadata.height;
  if (
    (width !== undefined && (!Number.isSafeInteger(width) || width <= 0 || width > 16_384)) ||
    (height !== undefined && (!Number.isSafeInteger(height) || height <= 0 || height > 16_384))
  ) {
    return null;
  }

  const videoCodec = sanitizeOptionalMediaIdentifier(metadata.videoCodec);
  const audioCodec = sanitizeOptionalMediaIdentifier(metadata.audioCodec);
  if (
    (metadata.videoCodec !== undefined && videoCodec === undefined) ||
    (metadata.audioCodec !== undefined && audioCodec === undefined)
  ) {
    return null;
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

function serializeResult(
  value: MediaJobResult | undefined,
  processingPreset: ProcessingPreset
): MediaJobApiResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const result = value as Partial<MediaJobResult>;
  if (
    !isSafeFileId(result.fileId) ||
    typeof result.filename !== "string" ||
    !result.filename ||
    result.filename.length > MAX_FILENAME_LENGTH ||
    result.filename.includes("/") ||
    result.filename.includes("\\") ||
    CONTROL_CHARACTERS.test(result.filename) ||
    typeof result.mimeType !== "string" ||
    !CONTENT_TYPE.test(result.mimeType) ||
    !Number.isSafeInteger(result.sizeBytes) ||
    (result.sizeBytes as number) <= 0
  ) {
    return null;
  }

  const expiresAt = normalizeOptionalTimestamp(result.expiresAt);
  const media = serializeMetadata(result.media as MediaJobOutputMetadata);
  if (!expiresAt || !media) return null;

  return Object.freeze({
    fileId: result.fileId,
    filename: result.filename,
    mimeType: result.mimeType,
    sizeBytes: result.sizeBytes as number,
    downloadUrl: `/api/file/${result.fileId}`,
    expiresAt,
    processingPreset,
    media
  });
}

function safeError(code: unknown): MediaJobApiError {
  const safeCode = isApiErrorCode(code) ? code : API_ERROR_CODES.INTERNAL_ERROR;
  return Object.freeze({ code: safeCode, message: API_ERROR_MESSAGES[safeCode] });
}

function failedSnapshot(base: SerializedBase, code: unknown): MediaJobApiSnapshot {
  return Object.freeze({
    ...base,
    status: "failed" as const,
    error: safeError(code)
  });
}

export function serializeMediaJobSnapshot(snapshot: MediaJobSnapshot): MediaJobApiSnapshot {
  void PRESET_UNIONS_MATCH;
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) throw internalError();
  if (!isValidJobId(snapshot.jobId)) throw internalError();
  if (!isMediaJobStatus(snapshot.status)) throw internalError();
  if (!isProcessingPreset(snapshot.processingPreset)) throw internalError();

  const base: SerializedBase = Object.freeze({
    jobId: snapshot.jobId,
    status: snapshot.status,
    progress: normalizeProgress(snapshot.progress),
    processingPreset: snapshot.processingPreset,
    createdAt: normalizeRequiredTimestamp(snapshot.createdAt),
    startedAt: normalizeOptionalTimestamp(snapshot.startedAt),
    completedAt: normalizeOptionalTimestamp(snapshot.completedAt),
    expiresAt: normalizeOptionalTimestamp(snapshot.expiresAt)
  });

  switch (snapshot.status) {
    case "ready": {
      const result = serializeResult(snapshot.result, snapshot.processingPreset);
      if (!result) return failedSnapshot(base, API_ERROR_CODES.INTERNAL_ERROR);
      return Object.freeze({ ...base, status: "ready", result });
    }
    case "failed":
      return failedSnapshot(base, snapshot.error?.code);
    case "queued":
    case "running":
    case "cancelled":
    case "expired":
      return Object.freeze({ ...base, status: snapshot.status });
    default: {
      const exhaustive: never = snapshot.status;
      throw exhaustive;
    }
  }
}

export function serializeCreateDownloadJobData(snapshot: MediaJobSnapshot): CreateDownloadJobData {
  const serialized = serializeMediaJobSnapshot(snapshot);
  if (serialized.status !== "queued") throw internalError();

  return Object.freeze({
    jobId: serialized.jobId,
    status: "queued",
    progress: serialized.progress,
    processingPreset: serialized.processingPreset,
    createdAt: serialized.createdAt,
    expiresAt: null,
    statusUrl: `/api/jobs/${serialized.jobId}`,
    cancelUrl: `/api/jobs/${serialized.jobId}`
  });
}
