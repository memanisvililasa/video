import { isProcessingPreset, type CreateDownloadJobRequest } from "@/lib/api/media-job-dto";
import { AppError } from "@/lib/errors";
import { API_ERROR_CODES } from "@/lib/types";

const CREATE_DOWNLOAD_JOB_KEYS = ["url", "formatId", "processingPreset", "rightsConfirmed"] as const;
const MAX_URL_LENGTH = 2_048;
const MAX_FORMAT_ID_LENGTH = 64;
const MAX_JOB_ID_LENGTH = 128;
const FORMAT_ID = /^[a-zA-Z0-9._-]+$/;
const JOB_ID = /^job_[a-zA-Z0-9_-]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasUnexpectedKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).some(
    (key) => !CREATE_DOWNLOAD_JOB_KEYS.includes(key as (typeof CREATE_DOWNLOAD_JOB_KEYS)[number])
  );
}

function invalidRequest(): AppError {
  return new AppError(API_ERROR_CODES.INVALID_REQUEST);
}

function rightsNotConfirmed(): AppError {
  return new AppError(API_ERROR_CODES.RIGHTS_NOT_CONFIRMED);
}

function unsupportedPreset(): AppError {
  return new AppError(API_ERROR_CODES.UNSUPPORTED_PRESET);
}

function invalidFormat(): AppError {
  return new AppError(API_ERROR_CODES.INVALID_FORMAT);
}

export function parseCreateDownloadJobRequest(value: unknown): CreateDownloadJobRequest {
  if (!isPlainObject(value) || hasUnexpectedKeys(value)) throw invalidRequest();

  if (value.rightsConfirmed !== true) throw rightsNotConfirmed();

  if (
    typeof value.url !== "string" ||
    !value.url.trim() ||
    value.url.length > MAX_URL_LENGTH ||
    CONTROL_CHARACTERS.test(value.url)
  ) {
    throw invalidRequest();
  }

  if (
    typeof value.formatId !== "string" ||
    !value.formatId ||
    value.formatId.length > MAX_FORMAT_ID_LENGTH ||
    !FORMAT_ID.test(value.formatId)
  ) {
    throw invalidFormat();
  }

  if (!isProcessingPreset(value.processingPreset)) throw unsupportedPreset();

  return Object.freeze({
    url: value.url.trim(),
    formatId: value.formatId,
    processingPreset: value.processingPreset,
    rightsConfirmed: true
  });
}

export function isValidJobId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 5 &&
    value.length <= MAX_JOB_ID_LENGTH &&
    !CONTROL_CHARACTERS.test(value) &&
    JOB_ID.test(value)
  );
}

export function parseJobId(value: unknown): string {
  if (!isValidJobId(value)) throw invalidRequest();
  return value;
}
