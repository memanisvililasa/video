import "server-only";

export const OBSERVABILITY_SCHEMA_VERSION = "1.0" as const;
export const REQUEST_ID_HEADER = "x-request-id" as const;

export const LOG_LEVELS = Object.freeze(["debug", "info", "warn", "error"] as const);
export type OperationalLogLevel = (typeof LOG_LEVELS)[number];

export const PROCESS_ROLES = Object.freeze(["local", "web", "worker", "migration"] as const);
export type ObservedProcessRole = (typeof PROCESS_ROLES)[number];

export const OPERATIONAL_EVENTS = Object.freeze([
  "process.starting",
  "process.ready",
  "process.not_ready",
  "process.stopping",
  "process.stopped",
  "config.invalid",
  "http.request.completed",
  "job.submit.accepted",
  "job.submit.rejected",
  "job.status.read",
  "job.cancel.requested",
  "job.file.requested",
  "job.file.rejected",
  "db.connected",
  "db.unavailable",
  "migration.status",
  "migration.mismatch"
] as const);
export type OperationalEvent = (typeof OPERATIONAL_EVENTS)[number];

export const OUTCOMES = Object.freeze([
  "success",
  "failure",
  "rejected",
  "cancelled",
  "unknown"
] as const);
export type OperationalOutcome = (typeof OUTCOMES)[number];

export const ERROR_CATEGORIES = Object.freeze([
  "validation",
  "configuration",
  "database",
  "storage",
  "network",
  "ssrf",
  "timeout",
  "cancellation",
  "download",
  "probe",
  "transcode",
  "publication",
  "migration",
  "internal"
] as const);
export type OperationalErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const REASON_CODES = Object.freeze([
  "none",
  "invalid_event",
  "invalid_configuration",
  "invalid_request",
  "rate_limited",
  "job_not_found",
  "job_not_ready",
  "dependency_unavailable",
  "database_unavailable",
  "schema_mismatch",
  "storage_unavailable",
  "tool_unavailable",
  "listener_unavailable",
  "readiness_timeout",
  "readiness_failed",
  "method_not_allowed",
  "body_not_allowed",
  "request_aborted",
  "cancelled",
  "internal_error"
] as const);
export type OperationalReasonCode = (typeof REASON_CODES)[number];

export const HTTP_ROUTES = Object.freeze([
  "job_submit",
  "job_status",
  "job_cancel",
  "job_file"
] as const);
export type ObservedHttpRoute = (typeof HTTP_ROUTES)[number];

export const HTTP_METHODS = Object.freeze(["GET", "HEAD", "POST", "DELETE"] as const);
export type ObservedHttpMethod = (typeof HTTP_METHODS)[number];

export const HTTP_STATUS_CLASSES = Object.freeze(["1xx", "2xx", "3xx", "4xx", "5xx"] as const);
export type HttpStatusClass = (typeof HTTP_STATUS_CLASSES)[number];

export const MEDIA_STAGES = Object.freeze([
  "queued",
  "download",
  "probe",
  "transcode",
  "remux",
  "audio",
  "publication",
  "completion"
] as const);
export type ObservedMediaStage = (typeof MEDIA_STAGES)[number];

export type ProcessMetadata = Readonly<{
  schemaVersion: typeof OBSERVABILITY_SCHEMA_VERSION;
  service: "videosave";
  processRole: ObservedProcessRole;
  processInstanceId: string;
  releaseCommit: string;
  releaseId: string;
  releaseCategory: "local" | "test" | "production";
}>;

export function isOperationalEvent(value: string): value is OperationalEvent {
  return (OPERATIONAL_EVENTS as readonly string[]).includes(value);
}

export function isReasonCode(value: string): value is OperationalReasonCode {
  return (REASON_CODES as readonly string[]).includes(value);
}

export function statusClass(statusCode: number): HttpStatusClass {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) return "5xx";
  return `${Math.floor(statusCode / 100)}xx` as HttpStatusClass;
}
