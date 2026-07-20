import "server-only";
import type { MediaJobRecord } from "@/lib/jobs/types";
import type {
  ObservedMaintenanceOperation,
  ObservedMediaStage,
  ObservedProcessingPreset,
  OperationalErrorCategory,
  OperationalEvent,
  OperationalLogLevel,
  OperationalOutcome,
  OperationalReasonCode
} from "@/lib/observability/contract";
import type { OperationalLogFields, OperationalLogger } from "@/lib/observability/logger";
import {
  isObservedPreset,
  type OperationalMetrics
} from "@/lib/observability/operational-metrics";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";

const MAX_COUNTER = 1_000_000;

export type OperationalSignals = Readonly<{
  logger: OperationalLogger;
  metrics: OperationalMetrics;
  emit(level: OperationalLogLevel, event: OperationalEvent, fields?: OperationalLogFields): void;
  preset(value: unknown): ObservedProcessingPreset;
  jobDurationSeconds(record: Pick<MediaJobRecord, "createdAt">, nowMs?: number): number;
  boundedCount(value: unknown): number;
  maintenanceStarted(operation: ObservedMaintenanceOperation): number;
  maintenanceCompleted(operation: ObservedMaintenanceOperation, startedAt: number, fields?: Readonly<Record<string, number>>): void;
  maintenanceFailed(operation: ObservedMaintenanceOperation, startedAt: number, category?: OperationalErrorCategory): void;
}>;

const EVENTS: Readonly<Record<ObservedMaintenanceOperation, Readonly<{
  started: OperationalEvent;
  completed: OperationalEvent;
  failed: OperationalEvent;
}>>> = Object.freeze({
  recovery: Object.freeze({ started: "recovery.started", completed: "recovery.completed", failed: "recovery.failed" }),
  reconciliation: Object.freeze({ started: "reconciliation.started", completed: "reconciliation.completed", failed: "reconciliation.failed" }),
  cleanup: Object.freeze({ started: "cleanup.started", completed: "cleanup.completed", failed: "cleanup.failed" }),
  expiration: Object.freeze({ started: "cleanup.started", completed: "cleanup.completed", failed: "cleanup.failed" })
});

function reasonFor(operation: ObservedMaintenanceOperation): OperationalReasonCode {
  return operation === "reconciliation" || operation === "cleanup" || operation === "expiration"
    ? "maintenance_failed"
    : "internal_error";
}

export function createOperationalSignals(
  logger: OperationalLogger,
  metrics: OperationalMetrics,
  now: () => number = () => performance.now()
): OperationalSignals {
  function emit(level: OperationalLogLevel, event: OperationalEvent, fields: OperationalLogFields = {}): void {
    try { logger.log(level, event, fields); } catch { /* telemetry is never business authority */ }
  }
  function safeMetric(operation: () => void): void {
    try { operation(); } catch { /* invalid telemetry cannot change runtime outcome */ }
  }
  function boundedCount(value: unknown): number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? Math.min(value, MAX_COUNTER)
      : 0;
  }
  function maintenanceStarted(operation: ObservedMaintenanceOperation): number {
    const startedAt = now();
    emit("info", EVENTS[operation].started, { outcome: "success", reasonCode: "none" });
    return startedAt;
  }
  function maintenanceCompleted(
    operation: ObservedMaintenanceOperation,
    startedAt: number,
    fields: Readonly<Record<string, number>> = {}
  ): void {
    const durationMs = Math.max(0, now() - startedAt);
    const metadata = Object.fromEntries(
      Object.entries(fields).slice(0, 16).map(([key, value]) => [key, boundedCount(value)])
    );
    emit("info", EVENTS[operation].completed, {
      outcome: "success",
      reasonCode: "none",
      durationMs,
      metadata
    });
    const unixSeconds = Date.now() / 1_000;
    safeMetric(() => metrics.maintenanceSuccess(operation, unixSeconds));
  }
  function maintenanceFailed(
    operation: ObservedMaintenanceOperation,
    startedAt: number,
    category: OperationalErrorCategory = "internal"
  ): void {
    emit("warn", EVENTS[operation].failed, {
      outcome: "failure",
      reasonCode: reasonFor(operation),
      errorCategory: category,
      durationMs: Math.max(0, now() - startedAt)
    });
    safeMetric(() => metrics.maintenanceFailure(operation, category));
  }

  return Object.freeze({
    logger,
    metrics,
    emit,
    preset(value) { return isObservedPreset(value) ? value : "unknown"; },
    jobDurationSeconds(record, nowMs = Date.now()) {
      const created = Date.parse(record.createdAt);
      return Number.isFinite(created) ? Math.max(0, nowMs - created) / 1_000 : 0;
    },
    boundedCount,
    maintenanceStarted,
    maintenanceCompleted,
    maintenanceFailed
  });
}

export function safeSignalMetric(operation: () => void): void {
  try { operation(); } catch { /* telemetry is deliberately non-authoritative */ }
}

export function stageOutcome(errorCategory: OperationalErrorCategory): OperationalOutcome {
  return errorCategory === "cancellation" ? "cancelled" : "failure";
}

export function stageReason(stage: ObservedMediaStage): OperationalReasonCode {
  if (stage === "download") return "download_failed";
  if (stage === "probe") return "probe_failed";
  if (stage === "publication") return "publication_failed";
  return "transcode_failed";
}

export function jobErrorCategory(code: ApiErrorCode | undefined): OperationalErrorCategory {
  if (!code) return "internal";
  if (code === API_ERROR_CODES.PRIVATE_OR_LOCAL_URL) return "ssrf";
  if (
    code === API_ERROR_CODES.DOWNLOAD_FAILED ||
    code === API_ERROR_CODES.EXTRACTION_FAILED ||
    code === API_ERROR_CODES.EXTRACTOR_FAILED ||
    code === API_ERROR_CODES.EXTRACTOR_TIMEOUT ||
    code === API_ERROR_CODES.SOURCE_EXPIRED
  ) return "download";
  if (code === API_ERROR_CODES.FFPROBE_FAILED || code === API_ERROR_CODES.INVALID_MEDIA_FILE) return "probe";
  if (code === API_ERROR_CODES.PROCESSING_TIMEOUT) return "timeout";
  if (code === API_ERROR_CODES.JOB_CANCELLED) return "cancellation";
  if (
    code === API_ERROR_CODES.FFMPEG_NOT_AVAILABLE ||
    code === API_ERROR_CODES.MERGE_FAILED ||
    code === API_ERROR_CODES.UNSUPPORTED_CODEC ||
    code === API_ERROR_CODES.AUDIO_STREAM_NOT_FOUND ||
    code === API_ERROR_CODES.PROCESSING_FAILED
  ) return "transcode";
  if (code === API_ERROR_CODES.OUTPUT_TOO_LARGE) return "publication";
  if (
    code === API_ERROR_CODES.INVALID_REQUEST ||
    code === API_ERROR_CODES.RIGHTS_NOT_CONFIRMED ||
    code === API_ERROR_CODES.UNSUPPORTED_PRESET ||
    code === API_ERROR_CODES.INVALID_FORMAT ||
    code === API_ERROR_CODES.INVALID_URL ||
    code === API_ERROR_CODES.UNSUPPORTED_URL ||
    code === API_ERROR_CODES.UNSUPPORTED_PLATFORM ||
    code === API_ERROR_CODES.CONTENT_UNAVAILABLE ||
    code === API_ERROR_CODES.LOGIN_REQUIRED ||
    code === API_ERROR_CODES.PRIVATE_CONTENT ||
    code === API_ERROR_CODES.MEMBERS_ONLY ||
    code === API_ERROR_CODES.DRM_PROTECTED ||
    code === API_ERROR_CODES.GEO_RESTRICTED ||
    code === API_ERROR_CODES.REGION_RESTRICTED ||
    code === API_ERROR_CODES.AGE_RESTRICTED ||
    code === API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE ||
    code === API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED ||
    code === API_ERROR_CODES.IMAGE_POST_NOT_SUPPORTED ||
    code === API_ERROR_CODES.CAROUSEL_NOT_SUPPORTED ||
    code === API_ERROR_CODES.STORY_NOT_SUPPORTED ||
    code === API_ERROR_CODES.LIVE_NOT_SUPPORTED ||
    code === API_ERROR_CODES.PLAYLIST_NOT_SUPPORTED ||
    code === API_ERROR_CODES.NO_SUPPORTED_FORMAT ||
    code === API_ERROR_CODES.AUTH_REQUIRED ||
    code === API_ERROR_CODES.PROTECTED_CONTENT ||
    code === API_ERROR_CODES.FILE_TOO_LARGE ||
    code === API_ERROR_CODES.VIDEO_TOO_LONG ||
    code === API_ERROR_CODES.VIDEO_RESOLUTION_TOO_HIGH ||
    code === API_ERROR_CODES.INVALID_JOB_STATE
  ) return "validation";
  return "internal";
}
