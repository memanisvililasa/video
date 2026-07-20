import { AppError } from "@/lib/errors";
import type {
  CanonicalFacebookContentIdentity,
  FacebookContentKind
} from "@/lib/extractors/facebook-url";
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
const NAMED_SECRET = /\b(?:access[_-]?token|authorization|cookie|csrf|session|signature|signed|token)\s*[:=]\s*[^\s]+/giu;
const JWT_LIKE_TEXT = /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/gu;
const OPAQUE_TOKEN_LIKE_TEXT = /\b[A-Za-z0-9_-]{40,}\b/gu;
const ALLOWED_OUTPUT_KEYS = new Set([
  "schemaVersion",
  "platform",
  "contentId",
  "contentType",
  "availability",
  "singleVideo",
  "hosting",
  "title",
  "description",
  "durationSeconds",
  "width",
  "height",
  "hasAudio"
]);

/** Stage 8.7A deliberately exposes no executable or live metadata provider. */
export const FACEBOOK_METADATA_EXECUTION_DECISION = "no-go" as const;
export const FACEBOOK_METADATA_PROVIDER_PRODUCTION_ENABLED = false as const;

export type FacebookSafeMetadata = Readonly<{
  platform: "facebook";
  contentId: string;
  contentType: FacebookContentKind;
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
    .replace(JWT_LIKE_TEXT, " ")
    .replace(OPAQUE_TOKEN_LIKE_TEXT, " ")
    .replace(DANGEROUS_FILENAME_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(normalized).slice(0, maximum).join("").trim() || fallback;
}

function integerField(record: Record<string, unknown>, key: string, maximum: number): number {
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
    case "friends_only": return API_ERROR_CODES.PRIVATE_CONTENT;
    case "login_required": return API_ERROR_CODES.LOGIN_REQUIRED;
    case "age_restricted": return API_ERROR_CODES.AGE_RESTRICTED;
    case "region_restricted": return API_ERROR_CODES.REGION_RESTRICTED;
    case "checkpoint":
    case "challenge":
    case "captcha": return API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE;
    case "removed":
    case "unavailable": return API_ERROR_CODES.CONTENT_UNAVAILABLE;
    default: return API_ERROR_CODES.EXTRACTOR_FAILED;
  }
}

function assertContentType(identity: CanonicalFacebookContentIdentity, value: unknown): void {
  if (value === "image") throw metadataError(API_ERROR_CODES.IMAGE_POST_NOT_SUPPORTED);
  if (value === "story") throw metadataError(API_ERROR_CODES.STORY_NOT_SUPPORTED);
  if (value === "live") throw metadataError(API_ERROR_CODES.LIVE_NOT_SUPPORTED);
  if (value === "group") throw metadataError(API_ERROR_CODES.GROUP_CONTENT_NOT_SUPPORTED);
  if (value === "multi_item") throw metadataError(API_ERROR_CODES.MULTI_ITEM_POST_NOT_SUPPORTED);
  if (value === "external") throw metadataError(API_ERROR_CODES.EXTERNAL_MEDIA_NOT_SUPPORTED);
  if (value !== identity.sourceKind) throw metadataError();
}

/**
 * Normalizes repository-controlled synthetic fixtures only. This function is
 * intentionally not an adapter: it performs no I/O and cannot invoke Facebook.
 */
export function normalizeSyntheticFacebookMetadata(
  identity: CanonicalFacebookContentIdentity,
  syntheticOutput: string
): FacebookSafeMetadata {
  if (identity.platform !== "facebook" || (identity.sourceKind !== "video" && identity.sourceKind !== "reel")) {
    throw new TypeError("A canonical Facebook content identity is required.");
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
  if (
    parsed.schemaVersion !== 1 ||
    parsed.platform !== "facebook" ||
    parsed.contentId !== identity.contentId
  ) throw metadataError();

  const unavailable = availabilityError(parsed.availability);
  if (unavailable) throw metadataError(unavailable);
  assertContentType(identity, parsed.contentType);
  if (parsed.hosting !== "facebook") {
    if (parsed.hosting === "external") throw metadataError(API_ERROR_CODES.EXTERNAL_MEDIA_NOT_SUPPORTED);
    throw metadataError();
  }
  if (parsed.singleVideo !== true) throw metadataError(API_ERROR_CODES.MULTI_ITEM_POST_NOT_SUPPORTED);
  if (
    parsed.title !== undefined && typeof parsed.title !== "string" ||
    parsed.description !== undefined && typeof parsed.description !== "string"
  ) throw metadataError();

  const durationSeconds = integerField(parsed, "durationSeconds", MAX_DURATION_SECONDS);
  const width = integerField(parsed, "width", MAX_DIMENSION);
  const height = integerField(parsed, "height", MAX_DIMENSION);
  if (width * height > MAX_PIXELS) throw metadataError();
  if (parsed.hasAudio !== undefined && typeof parsed.hasAudio !== "boolean") throw metadataError();

  const divisor = greatestCommonDivisor(width, height);
  return Object.freeze({
    platform: "facebook",
    contentId: identity.contentId,
    contentType: identity.sourceKind,
    title: sanitizeText(parsed.title, TITLE_MAX_CODE_POINTS, identity.sourceKind === "reel" ? "Facebook Reel" : "Facebook video"),
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
