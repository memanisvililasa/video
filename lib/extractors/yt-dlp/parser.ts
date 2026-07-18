import { AppError } from "@/lib/errors";
import { YT_DLP_EXTRACTOR_KEYS, type YtDlpMetadataPlatform } from "@/lib/extractors/yt-dlp/contract";
import {
  YOUTUBE_PUBLIC_ACCEPT,
  YOUTUBE_PUBLIC_ACCEPT_LANGUAGE,
  YOUTUBE_PUBLIC_SEC_FETCH_MODE,
  YOUTUBE_PUBLIC_USER_AGENT
} from "@/lib/extractors/yt-dlp/contract";
import {
  buildPlatformFormatStrategies,
  type DirectMediaReference,
  type PlatformFormatStrategy
} from "@/lib/extractors/yt-dlp/format-contract";
import { validateOutboundHostname } from "@/lib/security/ssrf";
import { API_ERROR_CODES } from "@/lib/types";

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_FORMATS = 1_000;
const ALLOWED_CONTAINERS = new Set(["mp4", "webm", "mov", "m4a"]);

type JsonRecord = Record<string, unknown>;

export type ParsedPlatformMetadata = Readonly<{
  platform: YtDlpMetadataPlatform;
  sourceId: string;
  title: string;
  durationSeconds?: number;
  extractorKey: string;
  strategies: readonly PlatformFormatStrategy[];
}>;

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum && !/[\u0000-\u001f\u007f]/.test(normalized) ? normalized : undefined;
}

function finiteNumber(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
}

function assertJsonDepth(value: string): void {
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
      if (depth > MAX_JSON_DEPTH) throw new AppError(API_ERROR_CODES.EXTRACTOR_FAILED);
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) throw new AppError(API_ERROR_CODES.EXTRACTOR_FAILED);
    }
  }
  if (inString || depth !== 0) throw new AppError(API_ERROR_CODES.EXTRACTOR_FAILED);
}

function mapAvailability(value: unknown, platform: YtDlpMetadataPlatform): void {
  if (value === "private") throw new AppError(API_ERROR_CODES.PRIVATE_CONTENT);
  if (value === "needs_auth") throw new AppError(API_ERROR_CODES.LOGIN_REQUIRED);
  if (value === "subscriber_only") {
    throw new AppError(platform === "youtube" ? API_ERROR_CODES.MEMBERS_ONLY : API_ERROR_CODES.LOGIN_REQUIRED);
  }
  if (value === "premium_only") {
    throw new AppError(platform === "youtube" ? API_ERROR_CODES.MEMBERS_ONLY : API_ERROR_CODES.PROTECTED_CONTENT);
  }
  if (value !== undefined && value !== null && value !== "public") throw new AppError(API_ERROR_CODES.CONTENT_UNAVAILABLE);
}

function parseDirectUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 8_192) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") return null;
  const safety = validateOutboundHostname(url.hostname);
  if (!safety.ok) return null;
  url.hostname = safety.hostname;
  url.hash = "";
  return url;
}

function parseYouTubeRequestProfile(value: unknown): "youtube-public-v1" | null {
  if (value === undefined) return "youtube-public-v1";
  if (!record(value)) return null;
  const expected = new Map([
    ["accept", YOUTUBE_PUBLIC_ACCEPT],
    ["accept-language", YOUTUBE_PUBLIC_ACCEPT_LANGUAGE],
    ["sec-fetch-mode", YOUTUBE_PUBLIC_SEC_FETCH_MODE],
    ["user-agent", YOUTUBE_PUBLIC_USER_AGENT]
  ]);
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.toLowerCase();
    if (!expected.has(key) || typeof rawValue !== "string") return null;
    const normalized = boundedString(rawValue, 1_024);
    if (!normalized || normalized.toLowerCase() !== expected.get(key)!.toLowerCase()) return null;
  }
  return "youtube-public-v1";
}

function parseDynamicRange(value: unknown, formatNote: string | undefined): "sdr" | "hdr" | "unknown" {
  const normalized = `${typeof value === "string" ? value : ""} ${formatNote ?? ""}`.toLowerCase();
  if (/\b(?:hdr|hlg|pq|dolby vision)\b/.test(normalized)) return "hdr";
  if (/\bsdr\b/.test(normalized)) return "sdr";
  return "unknown";
}

function parseFormat(value: unknown, platform: YtDlpMetadataPlatform): DirectMediaReference | null {
  if (!record(value)) return null;
  if (Array.isArray(value.fragments) && value.fragments.length > 0) return null;
  if (value.has_drm === true || value.cookies !== undefined) return null;
  const requestProfile = platform === "youtube"
    ? parseYouTubeRequestProfile(value.http_headers)
    : record(value.http_headers) && Object.keys(value.http_headers).length > 0
      ? null
      : undefined;
  if (requestProfile === null) return null;
  const protocol = boundedString(value.protocol, 32);
  if (protocol !== "https") return null;
  const url = parseDirectUrl(value.url);
  const formatId = boundedString(value.format_id, 128);
  const container = boundedString(value.ext, 16)?.toLowerCase();
  if (!url || !formatId || !container || !ALLOWED_CONTAINERS.has(container)) return null;
  const videoCodec = boundedString(value.vcodec, 128);
  const audioCodec = boundedString(value.acodec, 128);
  const hasVideo = Boolean(videoCodec && videoCodec !== "none");
  const hasAudio = Boolean(audioCodec && audioCodec !== "none");
  if (!hasVideo && !hasAudio) return null;
  const formatNote = boundedString(value.format_note, 256);
  return Object.freeze({
    url,
    formatId,
    container,
    videoCodec: hasVideo ? videoCodec : undefined,
    audioCodec: hasAudio ? audioCodec : undefined,
    width: finiteNumber(value.width, 1, 16_384),
    height: finiteNumber(value.height, 1, 16_384),
    fps: finiteNumber(value.fps, 1, 1_000),
    bitrate: finiteNumber(value.tbr, 0, 10_000_000),
    filesizeBytes: finiteNumber(value.filesize, 0),
    filesizeEstimateBytes: finiteNumber(value.filesize_approx, 0),
    hasVideo,
    hasAudio,
    requestProfile,
    dynamicRange: parseDynamicRange(value.dynamic_range, formatNote),
    languagePreference: finiteNumber(value.language_preference, -1_000, 1_000),
    audioChannels: finiteNumber(value.audio_channels, 1, 32),
    drc: /(?:^|[-, ])drc(?:$|[-, ])/i.test(`${formatId} ${formatNote ?? ""}`)
  });
}

export function parseYtDlpMetadataJson(
  value: string,
  platform: YtDlpMetadataPlatform
): ParsedPlatformMetadata {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_JSON_BYTES) {
    throw new AppError(API_ERROR_CODES.EXTRACTOR_FAILED);
  }
  assertJsonDepth(value);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new AppError(API_ERROR_CODES.EXTRACTOR_FAILED); }
  if (!record(parsed) || parsed._type === "playlist" || Array.isArray(parsed.entries)) {
    throw new AppError(platform === "youtube" ? API_ERROR_CODES.PLAYLIST_NOT_SUPPORTED : API_ERROR_CODES.UNSUPPORTED_URL);
  }
  if (parsed.is_live === true || parsed.live_status && parsed.live_status !== "not_live") {
    throw new AppError(platform === "youtube" ? API_ERROR_CODES.LIVE_NOT_SUPPORTED : API_ERROR_CODES.UNSUPPORTED_URL);
  }
  if (parsed.has_drm === true) throw new AppError(API_ERROR_CODES.DRM_PROTECTED);
  if ((finiteNumber(parsed.age_limit, 0, 1_000) ?? 0) > 0) throw new AppError(API_ERROR_CODES.AGE_RESTRICTED);
  mapAvailability(parsed.availability, platform);

  const extractorKey = boundedString(parsed.extractor_key, 128);
  if (!extractorKey || !YT_DLP_EXTRACTOR_KEYS[platform].includes(extractorKey)) {
    throw new AppError(API_ERROR_CODES.EXTRACTOR_FAILED);
  }
  const sourceId = boundedString(parsed.id, 256);
  const title = boundedString(parsed.title, 512);
  if (!sourceId || !title) throw new AppError(API_ERROR_CODES.EXTRACTOR_FAILED);
  if (!Array.isArray(parsed.formats) || parsed.formats.length > MAX_FORMATS) {
    throw new AppError(API_ERROR_CODES.EXTRACTOR_FAILED);
  }
  const references = parsed.formats.map((format) => parseFormat(format, platform)).filter((format): format is DirectMediaReference => format !== null);
  const strategies = buildPlatformFormatStrategies(platform, references);
  if (strategies.length === 0) throw new AppError(API_ERROR_CODES.NO_SUPPORTED_FORMAT);
  return Object.freeze({
    platform,
    sourceId,
    title,
    durationSeconds: finiteNumber(parsed.duration, 0, 7 * 24 * 60 * 60),
    extractorKey,
    strategies
  });
}
