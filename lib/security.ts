import { isSupportedHostname } from "@/lib/platforms";

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;
const IPV4_LITERAL = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export type UrlValidation = { ok: true; url: URL } | { ok: false; message: string };

function isPrivateIpv4(hostname: string): boolean {
  if (!IPV4_LITERAL.test(hostname)) return false;
  const parts = hostname.split(".").map(Number);
  if (parts.some((part) => part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isUnsafeHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/\.$/, "");
  return (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local") ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe80:") ||
    isPrivateIpv4(value)
  );
}

/**
 * Validates input before it can reach an adapter. This endpoint never fetches
 * user-supplied URLs; future adapters must additionally pin DNS results and
 * reject private/reserved resolved addresses immediately before every request.
 */
export function validateVideoUrl(value: unknown): UrlValidation {
  if (typeof value !== "string") return { ok: false, message: "Укажите ссылку на видео." };

  const sanitized = value.replace(CONTROL_CHARACTERS, "").trim();
  if (!sanitized || sanitized.length > 2048) {
    return { ok: false, message: "Ссылка пуста или превышает допустимую длину." };
  }

  let url: URL;
  try {
    url = new URL(sanitized);
  } catch {
    return { ok: false, message: "Введите корректную ссылку формата https://…" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: "Разрешены только HTTP(S)-ссылки." };
  }
  if (url.username || url.password || (url.port && url.port !== "80" && url.port !== "443")) {
    return { ok: false, message: "Ссылка содержит недопустимые параметры подключения." };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isUnsafeHostname(hostname) && hostname !== "demo.videosave.local") {
    return { ok: false, message: "Внутренние и локальные адреса не поддерживаются." };
  }
  if (!isSupportedHostname(hostname)) {
    return { ok: false, message: "Неподдерживаемая платформа или домен." };
  }

  url.hostname = hostname;
  return { ok: true, url };
}

export function getClientIdentifier(headers: Headers): string {
  // The identifier stays in memory only and is never emitted in application logs.
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || headers.get("x-real-ip") || "anonymous";
  return candidate.slice(0, 64).replace(/[^a-fA-F0-9:.,-]/g, "");
}
