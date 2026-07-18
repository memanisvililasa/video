import "server-only";
import { AppError } from "@/lib/errors";
import type { ExtractorContext } from "@/lib/extractors/types";
import { canonicalizeRedditPostUrl, type CanonicalRedditPost } from "@/lib/extractors/reddit-url";
import {
  safeFetchBody,
  type SafeBodyFetchOptions,
  type SafeBodyFetchResult
} from "@/lib/http/safe-fetch";
import { sanitizeTitle } from "@/lib/security/sanitize";
import { API_ERROR_CODES } from "@/lib/types";

const MAX_REDDIT_JSON_BYTES = 1024 * 1024;
const MAX_REDDIT_JSON_DEPTH = 64;
const DEFAULT_METADATA_TIMEOUT_SECONDS = 10;
const MAX_METADATA_TIMEOUT_SECONDS = 30;
const REDDIT_METADATA_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com"]);
const REDDIT_MEDIA_HOST = "v.redd.it";
const REDDIT_INTERNAL_LINK_HOSTS = new Set([
  ...REDDIT_METADATA_HOSTS,
  "redd.it",
  "v.redd.it",
  "i.redd.it",
  "preview.redd.it"
]);
const REDDIT_MEDIA_ID = /^[A-Za-z0-9]{5,64}$/;

type JsonRecord = Record<string, unknown>;

export type RedditProductMetadata = Readonly<{
  platform: "reddit";
  canonicalPostId: string;
  title: string;
  durationSeconds?: number;
  redditHostedVideo: true;
  hasAudio?: boolean;
  sourceKind: "direct" | "crosspost";
}>;

export type RedditBodyFetcher = (
  url: URL,
  options: SafeBodyFetchOptions
) => Promise<SafeBodyFetchResult>;

export type CreateRedditMetadataProviderOptions = Readonly<{
  fetchBody?: RedditBodyFetcher;
}>;

export type RedditMetadataProvider = Readonly<{
  fetch(url: URL, context?: ExtractorContext): Promise<RedditProductMetadata>;
}>;

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : undefined;
}

function finiteNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function error(code: keyof typeof API_ERROR_CODES): AppError {
  return new AppError(API_ERROR_CODES[code]);
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
      if (depth > MAX_REDDIT_JSON_DEPTH) throw error("EXTRACTOR_FAILED");
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) throw error("EXTRACTOR_FAILED");
    }
  }
  if (inString || depth !== 0) throw error("EXTRACTOR_FAILED");
}

function parseJson(body: Buffer): unknown {
  if (body.length === 0 || body.length > MAX_REDDIT_JSON_BYTES) throw error("EXTRACTOR_FAILED");
  const raw = body.toString("utf8");
  assertJsonDepth(raw);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw error("EXTRACTOR_FAILED");
  }
}

function metadataUrl(postId: string): URL {
  return new URL(`https://www.reddit.com/comments/${postId}/.json?raw_json=1&limit=1&depth=0`);
}

function allowMetadataHostname(hostname: string): boolean {
  return REDDIT_METADATA_HOSTS.has(hostname.toLowerCase().replace(/\.$/, ""));
}

function timeoutSeconds(context?: ExtractorContext): number {
  const value = context?.metadataTimeoutSeconds ?? DEFAULT_METADATA_TIMEOUT_SECONDS;
  if (!Number.isFinite(value) || value <= 0 || value > MAX_METADATA_TIMEOUT_SECONDS) {
    throw new TypeError("Reddit metadata timeout is invalid.");
  }
  return value;
}

function isJsonContentType(value: string | undefined): boolean {
  return value === "application/json" || Boolean(value?.endsWith("+json"));
}

function mapHttpStatus(result: SafeBodyFetchResult): void {
  if (result.statusCode >= 200 && result.statusCode < 300) return;
  if (result.statusCode === 401) throw error("LOGIN_REQUIRED");
  if (result.statusCode === 404 || result.statusCode === 410) throw error("CONTENT_UNAVAILABLE");
  if (result.statusCode === 429) throw error("RATE_LIMITED");
  if (result.statusCode === 403) {
    if (isJsonContentType(result.contentType)) {
      const payload = parseJson(result.body);
      if (record(payload)) {
        if (payload.reason === "private") throw error("PRIVATE_CONTENT");
        if (payload.reason === "quarantined") throw error("LOGIN_REQUIRED");
      }
    }
    throw error("LOGIN_REQUIRED");
  }
  throw error("EXTRACTOR_FAILED");
}

function postData(payload: unknown, postId: string): JsonRecord {
  if (!Array.isArray(payload) || payload.length < 1 || payload.length > 2) throw error("EXTRACTOR_FAILED");
  const listing = payload[0];
  if (!record(listing) || listing.kind !== "Listing" || !record(listing.data)) throw error("EXTRACTOR_FAILED");
  const children = listing.data.children;
  if (!Array.isArray(children) || children.length !== 1) throw error("EXTRACTOR_FAILED");
  const child = children[0];
  if (!record(child) || child.kind !== "t3" || !record(child.data)) throw error("EXTRACTOR_FAILED");
  const id = boundedString(child.data.id, 12)?.toLowerCase();
  if (id !== postId) throw error("EXTRACTOR_FAILED");
  return child.data;
}

function isRemoved(data: JsonRecord): boolean {
  const title = boundedString(data.title, 512)?.toLowerCase();
  const removedBy = boundedString(data.removed_by_category, 64);
  return Boolean(removedBy || title === "[deleted]" || title === "[removed]");
}

function isGallery(data: JsonRecord): boolean {
  return data.is_gallery === true || data.post_hint === "gallery" || record(data.gallery_data);
}

function isLive(data: JsonRecord): boolean {
  return data.is_live === true || Boolean(boundedString(data.live_service, 64)) || data.post_hint === "live";
}

function nestedRedditVideo(data: JsonRecord): JsonRecord | undefined {
  if (!record(data.secure_media) || !record(data.secure_media.reddit_video)) return undefined;
  return data.secure_media.reddit_video;
}

function hostedVideoCandidate(data: JsonRecord): Readonly<{
  source: JsonRecord;
  video: JsonRecord;
  sourceKind: "direct" | "crosspost";
}> | undefined {
  const direct = nestedRedditVideo(data);
  if (direct) return Object.freeze({ source: data, video: direct, sourceKind: "direct" });
  const parents = data.crosspost_parent_list;
  if (!Array.isArray(parents) || parents.length !== 1 || !record(parents[0])) return undefined;
  const video = nestedRedditVideo(parents[0]);
  return video ? Object.freeze({ source: parents[0], video, sourceKind: "crosspost" }) : undefined;
}

function mediaRoot(value: unknown): string | undefined {
  const raw = boundedString(value, 8_192);
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase().replace(/\.$/, "") !== REDDIT_MEDIA_HOST ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) return undefined;
  const mediaId = /^\/([^/]+)\//.exec(url.pathname)?.[1];
  return mediaId && REDDIT_MEDIA_ID.test(mediaId) ? mediaId : undefined;
}

function assertHostedVideo(candidate: NonNullable<ReturnType<typeof hostedVideoCandidate>>): void {
  if (
    candidate.source.is_video !== true ||
    candidate.source.is_reddit_media_domain !== true ||
    boundedString(candidate.source.domain, 128)?.toLowerCase() !== REDDIT_MEDIA_HOST
  ) throw error("POST_HAS_NO_VIDEO");
  const root = mediaRoot(candidate.video.fallback_url);
  if (!root) throw error("EXTRACTOR_FAILED");
  for (const field of ["dash_url", "hls_url"] as const) {
    if (candidate.video[field] !== undefined && mediaRoot(candidate.video[field]) !== root) {
      throw error("EXTRACTOR_FAILED");
    }
  }
}

function isRedditHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return REDDIT_INTERNAL_LINK_HOSTS.has(normalized);
}

function hasExternalMedia(data: JsonRecord): boolean {
  const candidates: unknown[] = [data.url_overridden_by_dest, data.url];
  for (const container of [data.secure_media, data.media]) {
    if (record(container) && record(container.oembed)) candidates.push(container.oembed.provider_url, container.oembed.url);
  }
  for (const candidate of candidates) {
    const raw = boundedString(candidate, 8_192);
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if ((url.protocol === "https:" || url.protocol === "http:") && !isRedditHostname(url.hostname)) return true;
    } catch {
      // Malformed optional destination metadata is ignored unless it is the verified media source.
    }
  }
  return false;
}

function safeTitle(value: unknown): string {
  const title = sanitizeTitle(typeof value === "string" ? value : "", { fallback: "Reddit video", maxLength: 160 });
  return title.ok ? title.value : "Reddit video";
}

function parseProductMetadata(payload: unknown, canonical: CanonicalRedditPost): RedditProductMetadata {
  const data = postData(payload, canonical.postId);
  if (isRemoved(data)) throw error("CONTENT_UNAVAILABLE");
  if (data.subreddit_type === "private") throw error("PRIVATE_CONTENT");
  if (data.quarantine === true) throw error("LOGIN_REQUIRED");
  if (data.over_18 === true) throw error("AGE_RESTRICTED");
  if (isGallery(data)) throw error("GALLERY_NOT_SUPPORTED");
  if (isLive(data)) throw error("LIVE_NOT_SUPPORTED");

  const candidate = hostedVideoCandidate(data);
  if (!candidate) {
    if (hasExternalMedia(data)) throw error("EXTERNAL_MEDIA_NOT_SUPPORTED");
    throw error("POST_HAS_NO_VIDEO");
  }
  assertHostedVideo(candidate);
  const durationSeconds = finiteNumber(candidate.video.duration, 0, 7 * 24 * 60 * 60);
  const hasAudio = typeof candidate.video.has_audio === "boolean" ? candidate.video.has_audio : undefined;
  return Object.freeze({
    platform: "reddit",
    canonicalPostId: canonical.postId,
    title: safeTitle(data.title),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    redditHostedVideo: true,
    ...(hasAudio !== undefined ? { hasAudio } : {}),
    sourceKind: candidate.sourceKind
  });
}

function mapProviderError(value: unknown): AppError {
  if (value instanceof AppError) {
    if (value.status === 504) return error("EXTRACTOR_TIMEOUT");
    switch (value.code) {
      case API_ERROR_CODES.CONTENT_UNAVAILABLE:
      case API_ERROR_CODES.PRIVATE_CONTENT:
      case API_ERROR_CODES.LOGIN_REQUIRED:
      case API_ERROR_CODES.AGE_RESTRICTED:
      case API_ERROR_CODES.EXTERNAL_MEDIA_NOT_SUPPORTED:
      case API_ERROR_CODES.POST_HAS_NO_VIDEO:
      case API_ERROR_CODES.GALLERY_NOT_SUPPORTED:
      case API_ERROR_CODES.LIVE_NOT_SUPPORTED:
      case API_ERROR_CODES.RATE_LIMITED:
      case API_ERROR_CODES.PRIVATE_OR_LOCAL_URL:
      case API_ERROR_CODES.EXTRACTOR_TIMEOUT:
      case API_ERROR_CODES.EXTRACTOR_FAILED:
        return error(value.code as keyof typeof API_ERROR_CODES);
      default:
        break;
    }
  }
  return error("EXTRACTOR_FAILED");
}

export function createRedditMetadataProvider(
  options: CreateRedditMetadataProviderOptions = {}
): RedditMetadataProvider {
  const fetchBody = options.fetchBody ?? safeFetchBody;
  return Object.freeze({
    async fetch(url: URL, context?: ExtractorContext): Promise<RedditProductMetadata> {
      try {
        const canonical = canonicalizeRedditPostUrl(url);
        const result = await fetchBody(metadataUrl(canonical.postId), {
          maxBytes: MAX_REDDIT_JSON_BYTES,
          timeoutSeconds: timeoutSeconds(context),
          maxRedirects: 2,
          requireHttps: true,
          requestProfile: "reddit-public-v1",
          allowHostname: allowMetadataHostname,
          signal: context?.signal
        });
        mapHttpStatus(result);
        if (!isJsonContentType(result.contentType)) throw error("EXTRACTOR_FAILED");
        return parseProductMetadata(parseJson(result.body), canonical);
      } catch (caught) {
        throw mapProviderError(caught);
      }
    }
  });
}

export const redditMetadataProvider = createRedditMetadataProvider();
