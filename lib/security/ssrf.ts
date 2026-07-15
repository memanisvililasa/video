import { isIP } from "node:net";
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

type CanonicalIpAddress = Readonly<{
  address: string;
  family: 4 | 6;
  mappedIpv4?: string;
  ipv4Compatible: boolean;
}>;

function canonicalIpv6(value: string): string | null {
  if (value.includes("%") || isIP(value) !== 6) return null;
  try {
    return stripIpv6Brackets(new URL(`http://[${value}]/`).hostname).toLowerCase();
  } catch {
    return null;
  }
}

function expandIpv6(value: string): readonly number[] | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return null;
  const words = [
    ...left,
    ...Array.from({ length: omitted }, () => "0"),
    ...right
  ];
  if (words.length !== 8 || words.some((word) => !/^[a-f0-9]{1,4}$/.test(word))) return null;
  return words.map((word) => Number.parseInt(word, 16));
}

function embeddedIpv4(words: readonly number[]): string {
  return [
    words[6] >>> 8,
    words[6] & 0xff,
    words[7] >>> 8,
    words[7] & 0xff
  ].join(".");
}

/** Canonicalizes IP literals before policy decisions and network pinning. */
export function canonicalizeIpAddress(hostname: string): CanonicalIpAddress | null {
  const normalized = normalizeHostname(hostname);
  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    return Object.freeze({ address: ipv4.join("."), family: 4, ipv4Compatible: false });
  }
  if (!normalized.includes(":")) return null;

  const address = canonicalIpv6(normalized);
  if (!address) return null;
  const words = expandIpv6(address);
  if (!words) return null;
  const zeroPrefix = words.slice(0, 5).every((word) => word === 0);
  const mappedIpv4 = zeroPrefix && words[5] === 0xffff ? embeddedIpv4(words) : undefined;
  const ipv4Compatible = words.slice(0, 6).every((word) => word === 0);
  return Object.freeze({ address, family: 6, mappedIpv4, ipv4Compatible });
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

  if (!normalized || normalized.length > 253 || normalized.includes("%")) {
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
    return { ok: true, hostname: ipv4.join(".") };
  }

  if (normalized.includes(":")) {
    const canonical = canonicalizeIpAddress(normalized);
    if (!canonical || canonical.family !== 6) {
      return hostFailure(normalized, "INVALID_HOSTNAME", "Hostname содержит некорректный IP-адрес.");
    }
    if (canonical.mappedIpv4) {
      const mapped = parseIpv4(canonical.mappedIpv4);
      if (!mapped) return hostFailure(normalized, "INVALID_HOSTNAME", "Hostname содержит некорректный IP-адрес.");
      if (isPrivateOrLocalIpv4(mapped)) return hostFailure(normalized, "PRIVATE_IPV4");
      if (isReservedIpv4(mapped)) return hostFailure(normalized, "RESERVED_IPV4");
      return { ok: true, hostname: canonical.mappedIpv4 };
    }

    const unsafeIpv6Reason = getUnsafeIpv6Reason(canonical.address);
    if (unsafeIpv6Reason) {
      return hostFailure(normalized, unsafeIpv6Reason);
    }
    if (canonical.ipv4Compatible || canonical.address.startsWith("::")) {
      return hostFailure(normalized, "RESERVED_IPV6");
    }
    return { ok: true, hostname: canonical.address };
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
