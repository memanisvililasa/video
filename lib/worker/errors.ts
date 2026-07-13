import "server-only";
import { AppError } from "@/lib/errors";
import { DurableMediaStorageError } from "@/lib/storage/durable-volume";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";
import {
  WorkerAttemptControlError,
  type WorkerAttemptAbortReason
} from "@/lib/worker/lease-session";

export type WorkerErrorDisposition =
  | Readonly<{ type: "terminal"; code: ApiErrorCode }>
  | Readonly<{ type: "retryable"; code: ApiErrorCode }>
  | Readonly<{ type: "cancelled" }>
  | Readonly<{ type: "ownership-lost" }>
  | Readonly<{ type: "shutdown" }>;

const RETRYABLE_CODES = new Set<ApiErrorCode>([
  API_ERROR_CODES.EXTRACTION_FAILED,
  API_ERROR_CODES.DOWNLOAD_FAILED,
  API_ERROR_CODES.FFMPEG_NOT_AVAILABLE,
  API_ERROR_CODES.INTERNAL_ERROR
]);

export function classifyWorkerError(
  error: unknown,
  abortReason: WorkerAttemptAbortReason | null
): WorkerErrorDisposition {
  const reason = abortReason ?? (error instanceof WorkerAttemptControlError ? error.reason : null);
  if (reason === "cancellation") return Object.freeze({ type: "cancelled" });
  if (reason === "ownership-lost" || reason === "db-transport" || reason === "terminal-state") {
    return Object.freeze({ type: "ownership-lost" });
  }
  if (reason === "infrastructure-unavailable") {
    return Object.freeze({ type: "retryable", code: API_ERROR_CODES.PROCESSING_FAILED });
  }
  if (reason === "shutdown") return Object.freeze({ type: "shutdown" });
  if (reason === "attempt-timeout") {
    return Object.freeze({ type: "terminal", code: API_ERROR_CODES.PROCESSING_TIMEOUT });
  }
  if (error instanceof DurableMediaStorageError) {
    return Object.freeze({ type: "retryable", code: API_ERROR_CODES.PROCESSING_FAILED });
  }
  if (error instanceof AppError) {
    if (error.code === API_ERROR_CODES.JOB_CANCELLED) {
      return Object.freeze({ type: "cancelled" });
    }
    return RETRYABLE_CODES.has(error.code)
      ? Object.freeze({ type: "retryable", code: error.code })
      : Object.freeze({ type: "terminal", code: error.code });
  }
  return Object.freeze({ type: "retryable", code: API_ERROR_CODES.INTERNAL_ERROR });
}
