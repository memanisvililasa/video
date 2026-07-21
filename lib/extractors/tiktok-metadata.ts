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
const MAX_HYDRATION_SCRIPT_TAGS = 128;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const DANGEROUS_FILENAME_CHARACTERS = /[<>:"/\\|?*]/g;
const URL_LIKE_TEXT = /(?:https?:\/\/|www\.)[^\s]+/giu;
const DOMAIN_LIKE_TEXT = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/giu;
const NAMED_SECRET = /\b(?:access[_-]?token|signed[_-]?token|authorization|cookie|csrf|session|signature|signed|token)\s*[:=]\s*[^\s]+/giu;
const JWT_LIKE_TEXT = /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/gu;
const OPAQUE_TOKEN_LIKE_TEXT = /\b[A-Za-z0-9_-]{40,}\b/gu;
const HYDRATION_SCRIPT_IDS = new Set(["__UNIVERSAL_DATA_FOR_REHYDRATION__", "SIGI_STATE"]);
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

/** Stage 8.10A permits only the isolated, cookie-free page metadata adapter. */
export const TIKTOK_METADATA_EXECUTION_DECISION = "restricted-page" as const;
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
    case "private": return API_ERROR_CODES.PRIVATE_CONTENT;
    case "login_required": return API_ERROR_CODES.LOGIN_REQUIRED;
    case "age_restricted": return API_ERROR_CODES.AGE_RESTRICTED;
    case "region_restricted": return API_ERROR_CODES.REGION_RESTRICTED;
    case "challenge":
    case "captcha": return API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE;
    case "rate_limited": return API_ERROR_CODES.RATE_LIMITED;
    case "removed":
    case "unavailable": return API_ERROR_CODES.CONTENT_UNAVAILABLE;
    default: return API_ERROR_CODES.EXTRACTOR_FAILED;
  }
}

function normalizeMetadataRecord(
  identity: CanonicalTikTokVideoIdentity,
  parsed: Record<string, unknown>
): TikTokSafeMetadata {
  if (Object.keys(parsed).some((key) => !ALLOWED_OUTPUT_KEYS.has(key))) throw metadataError();
  if (parsed.schemaVersion !== 1 || parsed.platform !== "tiktok" || parsed.videoId !== identity.videoId) {
    throw metadataError();
  }

  const unavailable = availabilityError(parsed.availability);
  if (unavailable) throw metadataError(unavailable);
  if (parsed.postType === "live") throw metadataError(API_ERROR_CODES.LIVE_NOT_SUPPORTED);
  if (parsed.postType === "photo") throw metadataError(API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED);
  if (parsed.postType === "multi_item") throw metadataError(API_ERROR_CODES.MULTI_ITEM_POST_NOT_SUPPORTED);
  if (parsed.postType !== "video" || parsed.singleVideo !== true) throw metadataError();
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

function assertRawJsonDepth(value: string): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) throw metadataError();
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) throw metadataError();
    }
  }
  if (inString || depth !== 0) throw metadataError();
}

function quotedAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "iu").exec(attributes);
  return match?.[1] ?? match?.[2];
}

function missingHydrationError(html: string): AppError {
  if (/(?:captcha|verify[-_ ]?center|bot challenge|security check|unusual traffic)/iu.test(html)) {
    return metadataError(API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE);
  }
  if (/(?:login[-_ ]?required|login modal|log in to tiktok|sign in to tiktok)/iu.test(html)) {
    return metadataError(API_ERROR_CODES.LOGIN_REQUIRED);
  }
  if (/(?:video (?:is )?(?:unavailable|removed)|couldn't find this video|page not available)/iu.test(html)) {
    return metadataError(API_ERROR_CODES.CONTENT_UNAVAILABLE);
  }
  return metadataError();
}

function hydrationJson(html: string): Readonly<{ id: string; value: string }> {
  const open = /<script\b([^>]*)>/giu;
  const lower = html.toLowerCase();
  let scripts = 0;
  let found: Readonly<{ id: string; value: string }> | undefined;
  for (let match = open.exec(html); match; match = open.exec(html)) {
    scripts += 1;
    if (scripts > MAX_HYDRATION_SCRIPT_TAGS) throw metadataError();
    const attributes = match[1] ?? "";
    const closing = lower.indexOf("</script>", open.lastIndex);
    if (closing < 0) throw metadataError();
    const id = quotedAttribute(attributes, "id");
    if (id && HYDRATION_SCRIPT_IDS.has(id)) {
      const type = quotedAttribute(attributes, "type")?.toLowerCase();
      if (type !== "application/json" || found) throw metadataError();
      const value = html.slice(open.lastIndex, closing).trim();
      if (!value) throw metadataError();
      found = Object.freeze({ id, value });
    }
    open.lastIndex = closing + "</script>".length;
  }
  if (!found) throw missingHydrationError(html);
  return found;
}

function record(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function statusError(statusCode: unknown, statusMessage: unknown): AppError | undefined {
  if (statusCode === 0) return undefined;
  const message = typeof statusMessage === "string" && statusMessage.length <= 512
    ? statusMessage.toLowerCase()
    : "";
  if (/private|privacy/.test(message)) return metadataError(API_ERROR_CODES.PRIVATE_CONTENT);
  if (/login|log in|sign in/.test(message)) return metadataError(API_ERROR_CODES.LOGIN_REQUIRED);
  if (/captcha|challenge|verify|bot/.test(message)) return metadataError(API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE);
  if (/rate|too many/.test(message)) return metadataError(API_ERROR_CODES.RATE_LIMITED);
  if (/region|country|geo/.test(message)) return metadataError(API_ERROR_CODES.REGION_RESTRICTED);
  if (/age/.test(message)) return metadataError(API_ERROR_CODES.AGE_RESTRICTED);
  if (/removed|unavailable|not found|doesn't exist/.test(message)) return metadataError(API_ERROR_CODES.CONTENT_UNAVAILABLE);
  return metadataError();
}

function universalItem(root: Record<string, unknown>): Record<string, unknown> {
  const scope = root.__DEFAULT_SCOPE__;
  if (!record(scope)) throw metadataError();
  const detail = scope["webapp.video-detail"];
  if (!record(detail)) throw metadataError();
  const unavailable = statusError(detail.statusCode, detail.statusMsg ?? detail.statusMessage);
  if (unavailable) throw unavailable;
  if (!record(detail.itemInfo) || !record(detail.itemInfo.itemStruct)) throw metadataError();
  return detail.itemInfo.itemStruct;
}

function sigiItem(root: Record<string, unknown>, videoId: string): Record<string, unknown> {
  if (
    !record(root.ItemModule) ||
    Object.keys(root.ItemModule).length !== 1 ||
    !record(root.ItemModule[videoId])
  ) throw metadataError();
  return root.ItemModule[videoId];
}

function classifyItem(item: Record<string, unknown>): void {
  if (item.availability !== undefined) {
    const unavailable = availabilityError(item.availability);
    if (unavailable) throw metadataError(unavailable);
  }
  if (item.privateItem === true || item.secret === true) throw metadataError(API_ERROR_CODES.PRIVATE_CONTENT);
  if (item.loginRequired === true) throw metadataError(API_ERROR_CODES.LOGIN_REQUIRED);
  if (item.challengeRequired === true) throw metadataError(API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE);
  if (item.rateLimited === true) throw metadataError(API_ERROR_CODES.RATE_LIMITED);
  if (item.regionRestricted === true) throw metadataError(API_ERROR_CODES.REGION_RESTRICTED);
  if (item.ageRestricted === true) throw metadataError(API_ERROR_CODES.AGE_RESTRICTED);
  if (item.removed === true) throw metadataError(API_ERROR_CODES.CONTENT_UNAVAILABLE);
  const kind = typeof item.contentType === "string"
    ? item.contentType.toLowerCase()
    : typeof item.postType === "string"
      ? item.postType.toLowerCase()
      : "video";
  if (item.isLive === true || ["live", "live_video"].includes(kind)) throw metadataError(API_ERROR_CODES.LIVE_NOT_SUPPORTED);
  if (record(item.imagePost) || record(item.imagePostInfo) || ["photo", "photo_mode", "image", "slideshow"].includes(kind)) {
    throw metadataError(API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED);
  }
  if (item.isMultiItem === true || ["multi", "multi_item", "multi-item", "carousel"].includes(kind)) {
    throw metadataError(API_ERROR_CODES.MULTI_ITEM_POST_NOT_SUPPORTED);
  }
  if (kind !== "video") throw metadataError();
}

/** Parses only a bounded application/json hydration script from a TikTok page. */
export function parseTikTokHydrationMetadata(
  identity: CanonicalTikTokVideoIdentity,
  pageBody: Buffer
): TikTokSafeMetadata {
  if (identity.platform !== "tiktok" || identity.sourceKind !== "video-page") {
    throw new TypeError("A canonical TikTok video identity is required.");
  }
  if (pageBody.length === 0 || pageBody.length > MAX_SYNTHETIC_OUTPUT_BYTES) throw metadataError();
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(pageBody);
  } catch {
    throw metadataError();
  }
  const hydration = hydrationJson(html);
  assertRawJsonDepth(hydration.value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(hydration.value) as unknown;
  } catch {
    throw metadataError();
  }
  if (!record(parsed)) throw metadataError();
  const item = hydration.id === "SIGI_STATE"
    ? sigiItem(parsed, identity.videoId)
    : universalItem(parsed);
  classifyItem(item);
  if (item.id !== identity.videoId || !record(item.video)) throw metadataError();
  const description = item.desc ?? item.description ?? "";
  return normalizeMetadataRecord(identity, {
    schemaVersion: 1,
    platform: "tiktok",
    videoId: item.id,
    postType: "video",
    availability: "public",
    singleVideo: true,
    title: item.title ?? description,
    description,
    durationSeconds: item.video.duration,
    width: item.video.width,
    height: item.video.height,
    ...(typeof item.video.hasAudio === "boolean" ? { hasAudio: item.video.hasAudio } : {})
  });
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
  if (!isRecord(parsed)) throw metadataError();
  return normalizeMetadataRecord(identity, parsed);
}
