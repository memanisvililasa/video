import "server-only";
import type {
  OperationalErrorCategory,
  OperationalReasonCode
} from "@/lib/observability/contract";

const REDACTED = "[REDACTED]";
const UNAVAILABLE = "[UNAVAILABLE]";
const TRUNCATED = "[TRUNCATED]";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const SENSITIVE_KEY = /(?:authorization|cookie|credential|database.?url|test.?database.?url|password|passwd|secret|token|source.?url|payload|headers?|raw.?sql|query|connection.?string|stderr|command|absolute.?path|storage.?path|durable.?root)/i;
const CONNECTION_STRING = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s]+/i;
const AUTHORIZATION_VALUE = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+\-/=]+/i;
const FULL_URL = /\bhttps?:\/\/[^\s]+/i;
const SQL_TEXT = /\b(?:select|insert|update|delete|alter|create|drop|grant|revoke)\s+[\s\S]{3,}/i;
const UNIX_ABSOLUTE_PATH = /(?:^|[\s'"(])\/(?:[A-Za-z0-9._-]+\/)+(?:[A-Za-z0-9._-]+)?/;
const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:\\(?:Users|Windows|Program Files|tmp)\\/i;

export const REDACTION_LIMITS = Object.freeze({
  maxDepth: 4,
  maxKeys: 32,
  maxItems: 32,
  maxStringLength: 256
});

export type RedactionLimits = Readonly<typeof REDACTION_LIMITS>;

function neutralizeControls(value: string): string {
  return value.replace(CONTROL_CHARACTERS, " ").replace(/\s{2,}/g, " ").trim();
}

function looksSensitive(value: string): boolean {
  return CONNECTION_STRING.test(value) ||
    AUTHORIZATION_VALUE.test(value) ||
    FULL_URL.test(value) ||
    SQL_TEXT.test(value) ||
    UNIX_ABSOLUTE_PATH.test(value) ||
    WINDOWS_ABSOLUTE_PATH.test(value);
}

export function sanitizeBoundedString(value: string, maximum: number = REDACTION_LIMITS.maxStringLength): string {
  const neutral = neutralizeControls(value);
  if (looksSensitive(neutral)) return REDACTED;
  if (neutral.length <= maximum) return neutral;
  return `${neutral.slice(0, Math.max(0, maximum - TRUNCATED.length))}${TRUNCATED}`;
}

export function sanitizeUrl(value: unknown): Readonly<Record<string, string>> | typeof REDACTED {
  try {
    const url = value instanceof URL ? value : new URL(String(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return REDACTED;
    if (url.username || url.password) return REDACTED;
    const hostname = url.hostname.toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[a-f0-9:]+\])$/.test(hostname)) {
      return REDACTED;
    }
    return Object.freeze({ protocol: url.protocol, origin: `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ""}` });
  } catch {
    return REDACTED;
  }
}

export function redactValue(
  value: unknown,
  limits: RedactionLimits = REDACTION_LIMITS
): unknown {
  const seen = new WeakSet<object>();

  function visit(input: unknown, depth: number): unknown {
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") return sanitizeBoundedString(input, limits.maxStringLength);
    if (typeof input === "number") return Number.isFinite(input) ? input : UNAVAILABLE;
    if (typeof input === "bigint") return sanitizeBoundedString(input.toString(), limits.maxStringLength);
    if (typeof input === "undefined" || typeof input === "symbol" || typeof input === "function") {
      return UNAVAILABLE;
    }
    if (input instanceof URL) return sanitizeUrl(input);
    if (input instanceof Error) {
      return Object.freeze({ errorCategory: classifyError(input).category });
    }
    if (depth >= limits.maxDepth) return TRUNCATED;
    if (typeof input !== "object") return UNAVAILABLE;
    if (seen.has(input)) return "[CIRCULAR]";
    seen.add(input);

    if (Array.isArray(input)) {
      const result: unknown[] = [];
      const count = Math.min(input.length, limits.maxItems);
      for (let index = 0; index < count; index += 1) {
        try {
          result.push(visit(input[index], depth + 1));
        } catch {
          result.push(UNAVAILABLE);
        }
      }
      if (input.length > count) result.push(TRUNCATED);
      return result;
    }

    const output: Record<string, unknown> = {};
    let keys: string[];
    try {
      keys = Object.keys(input).sort((left, right) => left.localeCompare(right, "en"));
    } catch {
      return UNAVAILABLE;
    }
    const count = Math.min(keys.length, limits.maxKeys);
    for (const key of keys.slice(0, count)) {
      const safeKey = sanitizeBoundedString(key, 64);
      if (!safeKey || safeKey === REDACTED) continue;
      if (SENSITIVE_KEY.test(key)) {
        output[safeKey] = REDACTED;
        continue;
      }
      try {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        output[safeKey] = descriptor && "value" in descriptor
          ? visit(descriptor.value, depth + 1)
          : UNAVAILABLE;
      } catch {
        output[safeKey] = UNAVAILABLE;
      }
    }
    if (keys.length > count) output.truncated = true;
    return output;
  }

  try {
    return visit(value, 0);
  } catch {
    return UNAVAILABLE;
  }
}

function safeErrorProperty(error: unknown, property: string): unknown {
  try {
    if (!error || typeof error !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, property);
    if (descriptor && "value" in descriptor) return descriptor.value;
    return undefined;
  } catch {
    return undefined;
  }
}

export function classifyError(error: unknown): Readonly<{
  category: OperationalErrorCategory;
  reasonCode: OperationalReasonCode;
}> {
  const name = safeErrorProperty(error, "name");
  const code = safeErrorProperty(error, "code");
  const normalizedName = typeof name === "string" ? name.toLowerCase() : "";
  const normalizedCode = typeof code === "string" ? code.toUpperCase() : "";

  if (normalizedName === "postgresschemacompatibilityerror") {
    return { category: "migration", reasonCode: "schema_mismatch" };
  }
  if (normalizedName.includes("storage") || normalizedName.includes("volume") || normalizedName.includes("marker")) {
    return { category: "storage", reasonCode: "storage_unavailable" };
  }
  if (normalizedCode === "INVALID_REQUEST") return { category: "validation", reasonCode: "invalid_request" };
  if (normalizedCode === "RATE_LIMITED") return { category: "validation", reasonCode: "rate_limited" };
  if (normalizedCode === "JOB_NOT_FOUND") return { category: "validation", reasonCode: "job_not_found" };
  if (normalizedCode === "JOB_NOT_READY") return { category: "validation", reasonCode: "job_not_ready" };
  if (normalizedName.includes("abort") || normalizedCode === "ABORT_ERR") {
    return { category: "cancellation", reasonCode: "cancelled" };
  }
  if (normalizedName.includes("timeout") || normalizedCode === "ETIMEDOUT") {
    return { category: "timeout", reasonCode: "readiness_timeout" };
  }
  if (/^(?:ECONN|ENOTFOUND|EAI_AGAIN|EPIPE)/.test(normalizedCode)) {
    return { category: "network", reasonCode: "dependency_unavailable" };
  }
  if (/^(?:EACCES|EPERM|EROFS|ENOENT|ENOSPC)$/.test(normalizedCode)) {
    return { category: "storage", reasonCode: "storage_unavailable" };
  }
  if (normalizedCode.startsWith("PG") || normalizedName.includes("postgres")) {
    return { category: "database", reasonCode: "database_unavailable" };
  }
  if (normalizedName === "typeerror" || normalizedName.includes("validation")) {
    return { category: "validation", reasonCode: "invalid_request" };
  }
  return { category: "internal", reasonCode: "internal_error" };
}

export const REDACTED_VALUE = REDACTED;
