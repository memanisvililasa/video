import { createApiError } from "@/lib/errors";
import { API_ERROR_CODES, type ApiError } from "@/lib/types";

const IPV4_LITERAL = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV4_LIKE = /^[\d.]+$/;
const HEXADECIMAL_IPV4 = /^0x[0-9a-f]+$/i;
const INTEGER_IPV4 = /^\d+$/;
const OCTAL_IPV4_PART = /^0[0-7]+$/;

export type HostSafetyReason =
  | "LOCALHOST"
  | "PRIVATE_IPV4"
  | "RESERVED_IPV4"
  | "PRIVATE_IPV6"
  | "RESERVED_IPV6"
  | "INTERNAL_HOSTNAME"
  | "INVALID_HOSTNAME";

export type HostSafety =
  | { ok: true; hostname: string }
  | { ok: false; hostname: string; reason: HostSafetyReason; error: ApiError; code: ApiError["code"]; message: string };

function hostFailure(hostname: string, reason: HostSafetyReason, message = "Локальные и внутренние адреса не поддерживаются."): HostSafety {
  const error = createApiError(
    reason === "INVALID_HOSTNAME" ? API_ERROR_CODES.INVALID_URL : API_ERROR_CODES.PRIVATE_OR_LOCAL_URL,
    message
  );

  return { ok: false, hostname, reason, error, code: error.code, message: error.message };
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, "$1");
}

function normalizeHostname(hostname: string): string {
  return stripIpv6Brackets(hostname.toLowerCase().replace(/\.$/, ""));
}

function parseIpv4(hostname: string): number[] | null {
  if (!IPV4_LITERAL.test(hostname)) return null;

  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }

  return parts;
}

function isInvalidIpv4LikeHostname(hostname: string): boolean {
  return IPV4_LIKE.test(hostname) && hostname.includes(".") && !parseIpv4(hostname);
}

function isPrivateOrLocalIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isReservedIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  return (
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0)
  );
}

function isLinkLocalIpv6(value: string): boolean {
  return value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb");
}

function getUnsafeIpv6Reason(hostname: string): HostSafetyReason | null {
  const value = hostname.toLowerCase();
  if (!value.includes(":")) return null;

  if (
    value === "::" ||
    value === "::1" ||
    value.startsWith("::ffff:0:") ||
    value.startsWith("64:ff9b:") ||
    value.startsWith("100:") ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    isLinkLocalIpv6(value)
  ) {
    return "PRIVATE_IPV6";
  }

  if (
    value.startsWith("2001:db8:") ||
    value.startsWith("2001:2:") ||
    value.startsWith("2001:10:") ||
    value.startsWith("ff")
  ) {
    return "RESERVED_IPV6";
  }

  return null;
}

function hasSuspiciousIpv4Encoding(hostname: string): boolean {
  if (HEXADECIMAL_IPV4.test(hostname) || INTEGER_IPV4.test(hostname)) return true;
  return hostname.split(".").some((part) => OCTAL_IPV4_PART.test(part));
}

function isInternalHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return true;
  if (hostname.endsWith(".internal") || hostname.endsWith(".lan") || hostname.endsWith(".home") || hostname.endsWith(".corp")) return true;
  return !hostname.includes(".") && !hostname.includes(":") && !parseIpv4(hostname);
}

export function checkHostnameSafety(hostname: string): HostSafety {
  const normalized = normalizeHostname(hostname);

  if (!normalized || normalized.length > 253) {
    return hostFailure(normalized, "INVALID_HOSTNAME", "Hostname отсутствует или превышает допустимую длину.");
  }

  if (isInternalHostname(normalized)) {
    return hostFailure(normalized, normalized.includes("localhost") ? "LOCALHOST" : "INTERNAL_HOSTNAME");
  }

  if (hasSuspiciousIpv4Encoding(normalized)) {
    return hostFailure(normalized, "PRIVATE_IPV4");
  }

  if (isInvalidIpv4LikeHostname(normalized)) {
    return hostFailure(normalized, "INVALID_HOSTNAME", "Hostname содержит некорректный IP-адрес.");
  }

  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    if (isPrivateOrLocalIpv4(ipv4)) return hostFailure(normalized, "PRIVATE_IPV4");
    if (isReservedIpv4(ipv4)) return hostFailure(normalized, "RESERVED_IPV4");
    return { ok: true, hostname: normalized };
  }

  const unsafeIpv6Reason = getUnsafeIpv6Reason(normalized);
  if (unsafeIpv6Reason) {
    return hostFailure(normalized, unsafeIpv6Reason);
  }

  return { ok: true, hostname: normalized };
}

// Apply before every outbound request. DNS resolution checks will be added in the API layer.
export function validateOutboundHostname(hostname: string): HostSafety {
  return checkHostnameSafety(hostname);
}

// Apply again after every redirect target before following it.
export function validateRedirectHostname(hostname: string): HostSafety {
  return checkHostnameSafety(hostname);
}
