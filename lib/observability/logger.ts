import "server-only";
import {
  ERROR_CATEGORIES,
  HTTP_METHODS,
  HTTP_ROUTES,
  HTTP_STATUS_CLASSES,
  LOG_LEVELS,
  MEDIA_STAGES,
  OUTCOMES,
  PROCESSING_PRESETS,
  isOperationalEvent,
  isReasonCode,
  type OperationalErrorCategory,
  type OperationalEvent,
  type OperationalLogLevel,
  type OperationalOutcome,
  type OperationalReasonCode,
  type ProcessMetadata
} from "@/lib/observability/contract";
import { currentRequestContext } from "@/lib/observability/request-context";
import { isValidRequestId } from "@/lib/observability/request-id";
import { classifyError, redactValue } from "@/lib/observability/redaction";

const MAX_LOG_LINE_BYTES = 8 * 1024;
const PUBLIC_JOB_ID = /^job_[a-zA-Z0-9_-]{1,124}$/;
const SAFE_PRESETS = new Set<string>(PROCESSING_PRESETS);
const SAFE_PROVIDERS = new Set(["youtube", "vimeo", "direct", "generic", "unknown"]);

export type OperationalLogFields = Readonly<{
  outcome?: OperationalOutcome;
  reasonCode?: OperationalReasonCode;
  requestId?: string;
  publicJobId?: string;
  attempt?: number;
  durationMs?: number;
  route?: (typeof HTTP_ROUTES)[number];
  method?: (typeof HTTP_METHODS)[number];
  statusCode?: number;
  statusClass?: (typeof HTTP_STATUS_CLASSES)[number];
  stage?: (typeof MEDIA_STAGES)[number];
  preset?: string;
  provider?: string;
  errorCategory?: OperationalErrorCategory;
  metadata?: unknown;
}>;

export type OperationalLogRecord = Readonly<Record<string, unknown>>;

export type OperationalLogSink = (
  record: OperationalLogRecord,
  line: string,
  level: OperationalLogLevel
) => void;

export type OperationalLogger = Readonly<{
  log(level: OperationalLogLevel, event: OperationalEvent | string, fields?: OperationalLogFields): void;
  debug(event: OperationalEvent | string, fields?: OperationalLogFields): void;
  info(event: OperationalEvent | string, fields?: OperationalLogFields): void;
  warn(event: OperationalEvent | string, fields?: OperationalLogFields): void;
  error(event: OperationalEvent | string, fields?: OperationalLogFields): void;
  child(defaultFields: OperationalLogFields): OperationalLogger;
}>;

export type CreateOperationalLoggerOptions = Readonly<{
  metadata: ProcessMetadata;
  level?: OperationalLogLevel;
  sink?: OperationalLogSink;
  now?: () => Date;
}>;

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function defaultSink(_record: OperationalLogRecord, line: string, level: OperationalLogLevel): void {
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

function safeInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function safeDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86_400_000
    ? Math.round(value * 1000) / 1000
    : undefined;
}

function normalizeFields(fields: OperationalLogFields): Record<string, unknown> {
  const context = currentRequestContext();
  const output: Record<string, unknown> = {};
  const requestId = fields.requestId && isValidRequestId(fields.requestId)
    ? fields.requestId
    : context?.requestId;
  if (requestId) output.requestId = requestId;
  const publicJobId = fields.publicJobId ?? context?.publicJobId;
  if (publicJobId && PUBLIC_JOB_ID.test(publicJobId)) output.publicJobId = publicJobId;
  const attempt = safeInteger(fields.attempt, 0, 100);
  if (attempt !== undefined) output.attempt = attempt;
  const durationMs = safeDuration(fields.durationMs);
  if (durationMs !== undefined) output.durationMs = durationMs;
  if (includes(HTTP_ROUTES, fields.route)) output.route = fields.route;
  else if (context?.route) output.route = context.route;
  if (includes(HTTP_METHODS, fields.method)) output.method = fields.method;
  else if (context?.method) output.method = context.method;
  const statusCode = safeInteger(fields.statusCode, 100, 599);
  if (statusCode !== undefined) output.statusCode = statusCode;
  if (includes(HTTP_STATUS_CLASSES, fields.statusClass)) output.statusClass = fields.statusClass;
  if (includes(MEDIA_STAGES, fields.stage)) output.stage = fields.stage;
  if (typeof fields.preset === "string" && SAFE_PRESETS.has(fields.preset)) output.preset = fields.preset;
  if (typeof fields.provider === "string" && SAFE_PROVIDERS.has(fields.provider)) output.provider = fields.provider;
  if (includes(ERROR_CATEGORIES, fields.errorCategory)) output.errorCategory = fields.errorCategory;
  if (fields.metadata !== undefined) output.metadata = redactValue(fields.metadata);
  return output;
}

function serializeBounded(record: Record<string, unknown>): Readonly<{ record: OperationalLogRecord; line: string }> {
  let candidate = record;
  let line = JSON.stringify(candidate);
  if (Buffer.byteLength(line, "utf8") <= MAX_LOG_LINE_BYTES) return { record: Object.freeze(candidate), line };
  candidate = { ...record, metadata: { truncated: true } };
  line = JSON.stringify(candidate);
  if (Buffer.byteLength(line, "utf8") <= MAX_LOG_LINE_BYTES) return { record: Object.freeze(candidate), line };
  candidate = Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== "metadata"));
  line = JSON.stringify(candidate);
  return { record: Object.freeze(candidate), line: line.slice(0, MAX_LOG_LINE_BYTES) };
}

export function createOperationalLogger(options: CreateOperationalLoggerOptions): OperationalLogger {
  const minimumLevel = options.level ?? "info";
  if (!includes(LOG_LEVELS, minimumLevel)) throw new TypeError("Operational log level is invalid.");
  const threshold = LOG_LEVELS.indexOf(minimumLevel);
  const sink = options.sink ?? (options.metadata.releaseCategory === "test" ? (() => undefined) : defaultSink);
  const now = options.now ?? (() => new Date());

  function create(defaultFields: OperationalLogFields): OperationalLogger {
    function log(level: OperationalLogLevel, requestedEvent: OperationalEvent | string, fields: OperationalLogFields = {}): void {
      try {
        if (!includes(LOG_LEVELS, level) || LOG_LEVELS.indexOf(level) < threshold) return;
        const event = isOperationalEvent(requestedEvent) ? requestedEvent : "config.invalid";
        const requestedOutcome = fields.outcome;
        const outcome = includes(OUTCOMES, requestedOutcome) ? requestedOutcome : "success";
        const requestedReason = fields.reasonCode;
        const reasonCode = !isOperationalEvent(requestedEvent)
          ? "invalid_event"
          : typeof requestedReason === "string" && isReasonCode(requestedReason)
            ? requestedReason
            : "none";
        const timestamp = now().toISOString();
        const record: Record<string, unknown> = {
          schemaVersion: options.metadata.schemaVersion,
          timestamp,
          level,
          event,
          service: options.metadata.service,
          processRole: options.metadata.processRole,
          processInstanceId: options.metadata.processInstanceId,
          releaseCommit: options.metadata.releaseCommit,
          releaseId: options.metadata.releaseId,
          outcome,
          reasonCode,
          ...normalizeFields({ ...defaultFields, ...fields })
        };
        const serialized = serializeBounded(record);
        sink(serialized.record, serialized.line, level);
      } catch {
        // Operational telemetry is deliberately non-authoritative for business behavior.
      }
    }
    return Object.freeze({
      log,
      debug: (event, fields) => log("debug", event, fields),
      info: (event, fields) => log("info", event, fields),
      warn: (event, fields) => log("warn", event, fields),
      error: (event, fields) => log("error", event, fields),
      child: (fields) => create({ ...defaultFields, ...fields })
    });
  }

  return create({});
}

export function sanitizeLogLevel(value: string | undefined): OperationalLogLevel {
  const normalized = value?.trim().toLowerCase() || "info";
  if (!includes(LOG_LEVELS, normalized)) throw new TypeError("OBSERVABILITY_LOG_LEVEL is invalid.");
  return normalized;
}

export function safeReasonFromError(error: unknown): Readonly<{
  errorCategory: OperationalErrorCategory;
  reasonCode: OperationalReasonCode;
}> {
  const classified = classifyError(error);
  return Object.freeze({ errorCategory: classified.category, reasonCode: classified.reasonCode });
}
