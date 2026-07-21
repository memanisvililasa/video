import { AppError } from "@/lib/errors";
import type { CanonicalXPostIdentity } from "@/lib/extractors/x-url";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";

const MAX_SYNTHETIC_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60;
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 8_294_400;
const TITLE_MAX_CODE_POINTS = 160;
const DESCRIPTION_MAX_CODE_POINTS = 512;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const DANGEROUS_FILENAME_CHARACTERS = /[<>:"/\\|?*]/g;
const URL_LIKE_TEXT = /(?:https?:\/\/|www\.)[^\s]+/giu;
const DOMAIN_LIKE_TEXT = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/giu;
const MENTION = /(^|[^\p{L}\p{N}_])@[A-Za-z0-9_]{1,15}\b/gu;
const NAMED_SECRET = /\b(?:access[_-]?token|authorization|bearer|cookie|csrf|guest[_-]?token|session|signature|signed|token)\s*[:=]\s*[^\s]+/giu;
const AUTHORIZATION_VALUE = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}={0,2}/giu;
const JWT_LIKE_TEXT = /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/gu;
const OPAQUE_TOKEN_LIKE_TEXT = /\b[A-Za-z0-9_-]{40,}\b/gu;
const ALLOWED_OUTPUT_KEYS = new Set([
  "schemaVersion",
  "platform",
  "postId",
  "contentType",
  "availability",
  "hosting",
  "mediaOrigin",
  "singleVideo",
  "title",
  "description",
  "durationSeconds",
  "width",
  "height",
  "hasAudio"
]);

/** Stage 8.8A deliberately exposes no executable or live metadata provider. */
export const X_METADATA_EXECUTION_DECISION = "no-go" as const;
export const X_METADATA_PROVIDER_PRODUCTION_ENABLED = false as const;

export type XSafeContentType = "video-candidate" | "animated-gif-candidate";

export type XSafeMetadata = Readonly<{
  platform: "x";
  postId: string;
  contentType: XSafeContentType;
  title: string;
  description: string;
  durationSeconds: number;
  width: number;
  height: number;
  orientation: "portrait" | "landscape" | "square";
  aspectRatio: Readonly<{ width: number; height: number }>;
  hasAudio?: boolean;
  singleVideo: true;
}>;

function metadataError(code: ApiErrorCode = API_ERROR_CODES.EXTRACTOR_FAILED): AppError {
  return new AppError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonDepth(value: unknown, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) throw metadataError();
  if (Array.isArray(value)) {
    for (const item of value) assertJsonDepth(item, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) assertJsonDepth(item, depth + 1);
  }
}

function sanitizeText(value: unknown, maximum: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .normalize("NFC")
    .replace(CONTROL_OR_BIDI, " ")
    .replace(URL_LIKE_TEXT, " ")
    .replace(DOMAIN_LIKE_TEXT, " ")
    .replace(NAMED_SECRET, " ")
    .replace(AUTHORIZATION_VALUE, " ")
    .replace(JWT_LIKE_TEXT, " ")
    .replace(OPAQUE_TOKEN_LIKE_TEXT, " ")
    .replace(MENTION, "$1")
    .replace(DANGEROUS_FILENAME_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(normalized).slice(0, maximum).join("").trim() || fallback;
}

function positiveNumberField(record: Record<string, unknown>, key: string, maximum: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw metadataError();
  }
  return value;
}

function positiveIntegerField(record: Record<string, unknown>, key: string, maximum: number): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw metadataError();
  }
  return value as number;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function availabilityError(value: unknown): ApiErrorCode | undefined {
  switch (value) {
    case "public": return undefined;
    case "private":
    case "protected": return API_ERROR_CODES.PRIVATE_CONTENT;
    case "login_required": return API_ERROR_CODES.LOGIN_REQUIRED;
    case "removed":
    case "unavailable": return API_ERROR_CODES.CONTENT_UNAVAILABLE;
    case "age_restricted": return API_ERROR_CODES.AGE_RESTRICTED;
    case "region_restricted":
    case "withheld": return API_ERROR_CODES.REGION_RESTRICTED;
    case "rate_limited": return API_ERROR_CODES.RATE_LIMITED;
    case "challenge":
    case "captcha": return API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE;
    default: return API_ERROR_CODES.EXTRACTOR_FAILED;
  }
}

function contentType(value: unknown): XSafeContentType {
  if (value === "video") return "video-candidate";
  if (value === "animated_gif") return "animated-gif-candidate";
  if (value === "photo" || value === "image") throw metadataError(API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED);
  if (value === "mixed_media" || value === "multi_item" || value === "multi_video") {
    throw metadataError(API_ERROR_CODES.MULTI_ITEM_POST_NOT_SUPPORTED);
  }
  if (value === "external_media") throw metadataError(API_ERROR_CODES.EXTERNAL_MEDIA_NOT_SUPPORTED);
  if (value === "live" || value === "broadcast" || value === "space") {
    throw metadataError(API_ERROR_CODES.LIVE_NOT_SUPPORTED);
  }
  if (value === "text" || value === "no_media") throw metadataError(API_ERROR_CODES.POST_HAS_NO_VIDEO);
  throw metadataError();
}

function assertHosting(value: unknown): void {
  if (value === "x") return;
  if (value === "external") throw metadataError(API_ERROR_CODES.EXTERNAL_MEDIA_NOT_SUPPORTED);
  throw metadataError();
}

function assertMediaOrigin(value: unknown): void {
  if (value === "post") return;
  if (value === "quoted" || value === "reposted" || value === "external") {
    throw metadataError(API_ERROR_CODES.EXTERNAL_MEDIA_NOT_SUPPORTED);
  }
  throw metadataError();
}

/**
 * Normalizes repository-controlled synthetic fixtures only. Unknown keys are
 * rejected. This function performs no I/O and cannot invoke X/Twitter.
 */
export function normalizeSyntheticXMetadata(
  identity: CanonicalXPostIdentity,
  syntheticOutput: string
): XSafeMetadata {
  if (identity.platform !== "x" || identity.sourceKind !== "status-post-candidate") {
    throw new TypeError("A canonical X/Twitter status-post identity is required.");
  }
  if (Buffer.byteLength(syntheticOutput) > MAX_SYNTHETIC_OUTPUT_BYTES) throw metadataError();

  let parsed: unknown;
  try {
    parsed = JSON.parse(syntheticOutput);
  } catch {
    throw metadataError();
  }
  assertJsonDepth(parsed);
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => !ALLOWED_OUTPUT_KEYS.has(key))) {
    throw metadataError();
  }
  if (parsed.schemaVersion !== 1 || parsed.platform !== "x" || parsed.postId !== identity.postId) {
    throw metadataError();
  }

  const unavailable = availabilityError(parsed.availability);
  if (unavailable) throw metadataError(unavailable);
  const safeContentType = contentType(parsed.contentType);
  assertHosting(parsed.hosting);
  assertMediaOrigin(parsed.mediaOrigin);
  if (parsed.singleVideo !== true) throw metadataError(API_ERROR_CODES.MULTI_ITEM_POST_NOT_SUPPORTED);
  if (
    parsed.title !== undefined && typeof parsed.title !== "string" ||
    parsed.description !== undefined && typeof parsed.description !== "string"
  ) throw metadataError();

  const durationSeconds = positiveNumberField(parsed, "durationSeconds", MAX_DURATION_SECONDS);
  const width = positiveIntegerField(parsed, "width", MAX_DIMENSION);
  const height = positiveIntegerField(parsed, "height", MAX_DIMENSION);
  if (width * height > MAX_PIXELS) throw metadataError();
  if (parsed.hasAudio !== undefined && typeof parsed.hasAudio !== "boolean") throw metadataError();
  if (safeContentType === "animated-gif-candidate" && parsed.hasAudio === true) throw metadataError();

  const divisor = greatestCommonDivisor(width, height);
  return Object.freeze({
    platform: "x",
    postId: identity.postId,
    contentType: safeContentType,
    title: sanitizeText(
      parsed.title,
      TITLE_MAX_CODE_POINTS,
      safeContentType === "animated-gif-candidate" ? "X animated GIF" : "X video"
    ),
    description: sanitizeText(parsed.description, DESCRIPTION_MAX_CODE_POINTS),
    durationSeconds,
    width,
    height,
    orientation: width === height ? "square" : width > height ? "landscape" : "portrait",
    aspectRatio: Object.freeze({ width: width / divisor, height: height / divisor }),
    ...(typeof parsed.hasAudio === "boolean" ? { hasAudio: parsed.hasAudio } : {}),
    singleVideo: true
  });
}
