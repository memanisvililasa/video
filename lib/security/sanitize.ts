import { createApiError } from "@/lib/errors";
import { API_ERROR_CODES, type ApiError } from "@/lib/types";

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const CONTROL_CHARACTERS_GLOBAL = /[\u0000-\u001F\u007F]/g;
const SLASHES_AND_BACKSLASHES = /[/\\]+/g;
const UNSAFE_FILENAME_CHARACTERS = /[<>:"|?*]/g;
const PATH_TRAVERSAL_DOTS = /\.{2,}/g;

export type SanitizedStringResult =
  | { ok: true; value: string }
  | { ok: false; error: ApiError; code: ApiError["code"]; message: string };

export type SanitizeStringOptions = {
  fallback?: string;
  maxLength?: number;
};

function sanitizeFailure(message: string): SanitizedStringResult {
  const error = createApiError(API_ERROR_CODES.INVALID_URL, message);
  return { ok: false, error, code: error.code, message: error.message };
}

function sanitizeSuccess(value: string): SanitizedStringResult {
  return { ok: true, value };
}

function removeControlCharacters(value: string): string {
  return value.replace(CONTROL_CHARACTERS_GLOBAL, "");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}

export function validateNoControlCharacters(value: unknown): SanitizedStringResult {
  if (typeof value !== "string") return sanitizeFailure("Ожидалась строка.");
  if (hasControlCharacters(value)) return sanitizeFailure("Строка содержит недопустимые управляющие символы.");
  return sanitizeSuccess(value);
}

export function stripControlCharacters(value: unknown): SanitizedStringResult {
  if (typeof value !== "string") return sanitizeFailure("Ожидалась строка.");
  return sanitizeSuccess(removeControlCharacters(value));
}

export function normalizeInputString(value: unknown): SanitizedStringResult {
  if (typeof value !== "string") return sanitizeFailure("Ожидалась строка.");
  return sanitizeSuccess(normalizeWhitespace(removeControlCharacters(value)));
}

export function sanitizeClientIdentifier(value: unknown): SanitizedStringResult {
  if (typeof value !== "string") return sanitizeFailure("Ожидалась строка.");
  return sanitizeSuccess(value.slice(0, 64).replace(/[^a-fA-F0-9:.,-]/g, ""));
}

export function sanitizeFilename(value: unknown, options: SanitizeStringOptions = {}): SanitizedStringResult {
  const fallback = options.fallback ?? "download";
  const maxLength = options.maxLength ?? 180;

  if (typeof value !== "string") return sanitizeSuccess(fallback);

  const sanitized = normalizeWhitespace(removeControlCharacters(value))
    .replace(SLASHES_AND_BACKSLASHES, "-")
    .replace(UNSAFE_FILENAME_CHARACTERS, "-")
    .replace(PATH_TRAVERSAL_DOTS, ".")
    .replace(/^-+|-+$/g, "")
    .replace(/^\.+/, "")
    .slice(0, maxLength)
    .trim();

  return sanitizeSuccess(sanitized || fallback);
}

export function sanitizeTitle(value: unknown, options: SanitizeStringOptions = {}): SanitizedStringResult {
  const fallback = options.fallback ?? "Untitled video";
  const maxLength = options.maxLength ?? 160;

  if (typeof value !== "string") return sanitizeSuccess(fallback);

  const sanitized = normalizeWhitespace(removeControlCharacters(value))
    .replace(SLASHES_AND_BACKSLASHES, " ")
    .replace(PATH_TRAVERSAL_DOTS, ".")
    .slice(0, maxLength)
    .trim();

  return sanitizeSuccess(sanitized || fallback);
}

export function getClientIdentifier(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || headers.get("x-real-ip") || "anonymous";
  const result = sanitizeClientIdentifier(candidate);
  return result.ok ? result.value : "anonymous";
}
