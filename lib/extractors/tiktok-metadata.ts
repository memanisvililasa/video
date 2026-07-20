import { AppError } from "@/lib/errors";
import type { CanonicalTikTokVideoIdentity } from "@/lib/extractors/tiktok-url";
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
const ALLOWED_OUTPUT_KEYS = new Set([
  "schemaVersion",
  "platform",
  "videoId",
  "postType",
  "availability",
  "singleVideo",
  "title",
  "description",
  "durationSeconds",
  "width",
  "height",
  "hasAudio"
]);

/** Stage 8.5A deliberately exposes no executable or live metadata provider. */
export const TIKTOK_METADATA_EXECUTION_DECISION = "no-go" as const;
export const TIKTOK_METADATA_PROVIDER_PRODUCTION_ENABLED = false as const;

export type TikTokSafeMetadata = Readonly<{
  platform: "tiktok";
  videoId: string;
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
    case "private": return API_ERROR_CODES.PRIVATE_CONTENT;
    case "login_required": return API_ERROR_CODES.LOGIN_REQUIRED;
    case "age_restricted": return API_ERROR_CODES.AGE_RESTRICTED;
    case "region_restricted": return API_ERROR_CODES.REGION_RESTRICTED;
    case "captcha": return API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE;
    case "unavailable": return API_ERROR_CODES.CONTENT_UNAVAILABLE;
    default: return API_ERROR_CODES.EXTRACTOR_FAILED;
  }
}

/**
 * Normalizes repository-controlled synthetic fixtures only. This function is
 * intentionally not an adapter: it performs no I/O and cannot invoke TikTok.
 */
export function normalizeSyntheticTikTokMetadata(
  identity: CanonicalTikTokVideoIdentity,
  syntheticOutput: string
): TikTokSafeMetadata {
  if (identity.platform !== "tiktok" || identity.sourceKind !== "video-page") {
    throw new TypeError("A canonical TikTok video identity is required.");
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
  if (parsed.schemaVersion !== 1 || parsed.platform !== "tiktok" || parsed.videoId !== identity.videoId) {
    throw metadataError();
  }

  const unavailable = availabilityError(parsed.availability);
  if (unavailable) throw metadataError(unavailable);
  if (parsed.postType === "live") throw metadataError(API_ERROR_CODES.LIVE_NOT_SUPPORTED);
  if (parsed.postType === "photo") throw metadataError(API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED);
  if (parsed.postType !== "video" || parsed.singleVideo !== true) throw metadataError();

  const durationSeconds = integerField(parsed, "durationSeconds", MAX_DURATION_SECONDS);
  const width = integerField(parsed, "width", MAX_DIMENSION);
  const height = integerField(parsed, "height", MAX_DIMENSION);
  if (width * height > MAX_PIXELS) throw metadataError();
  if (parsed.hasAudio !== undefined && typeof parsed.hasAudio !== "boolean") throw metadataError();

  const divisor = greatestCommonDivisor(width, height);
  return Object.freeze({
    platform: "tiktok",
    videoId: identity.videoId,
    title: sanitizeText(parsed.title, TITLE_MAX_CODE_POINTS, "TikTok video"),
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
