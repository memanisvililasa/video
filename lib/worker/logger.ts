import "server-only";

export type WorkerLogLevel = "info" | "warn" | "error";
export type WorkerLogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface WorkerLogger {
  info(event: string, fields?: WorkerLogFields): void;
  warn(event: string, fields?: WorkerLogFields): void;
  error(event: string, fields?: WorkerLogFields): void;
}

export const NOOP_WORKER_LOGGER: WorkerLogger = Object.freeze({
  info() {},
  warn() {},
  error() {}
});

const SAFE_EVENT = /^[a-z][a-z0-9_.-]{0,63}$/;
const SAFE_FIELD = /^[a-z][a-zA-Z0-9_]{0,47}$/;

function sanitizeEntry(event: string, fields: WorkerLogFields = {}): Record<string, unknown> {
  const safeEvent = SAFE_EVENT.test(event) ? event : "worker.invalid-event";
  const safeFields: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELD.test(key)) continue;
    if (typeof value === "string") safeFields[key] = value.slice(0, 160);
    else if (typeof value === "number" && Number.isFinite(value)) safeFields[key] = value;
    else if (typeof value === "boolean" || value === null) safeFields[key] = value;
  }
  return { timestamp: new Date().toISOString(), event: safeEvent, ...safeFields };
}

export function createStructuredWorkerLogger(): WorkerLogger {
  const write = (level: WorkerLogLevel, event: string, fields?: WorkerLogFields): void => {
    const line = JSON.stringify({ level, ...sanitizeEntry(event, fields) });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.info(line);
  };
  return Object.freeze({
    info: (event: string, fields?: WorkerLogFields) => write("info", event, fields),
    warn: (event: string, fields?: WorkerLogFields) => write("warn", event, fields),
    error: (event: string, fields?: WorkerLogFields) => write("error", event, fields)
  });
}
