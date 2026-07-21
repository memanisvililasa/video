import "server-only";
import { AppError } from "@/lib/errors";
import type { ExtractorContext } from "@/lib/extractors/types";
import { parseTikTokHydrationMetadata, type TikTokSafeMetadata } from "@/lib/extractors/tiktok-metadata";
import { resolveTikTokShortLink } from "@/lib/extractors/tiktok-short-link";
import {
  canonicalizeTikTokVideoUrl,
  classifyTikTokUrl,
  type CanonicalTikTokVideoIdentity,
  type TikTokShortLinkIdentity
} from "@/lib/extractors/tiktok-url";
import {
  safeFetchBody,
  type SafeBodyFetchOptions,
  type SafeBodyFetchResult
} from "@/lib/http/safe-fetch";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";

const MAX_TIKTOK_PAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_METADATA_TIMEOUT_SECONDS = 10;
const MAX_METADATA_TIMEOUT_SECONDS = 10;
const TIKTOK_PAGE_HOST = "www.tiktok.com";

export type TikTokPageBodyFetcher = (
  url: URL,
  options: SafeBodyFetchOptions
) => Promise<SafeBodyFetchResult>;

export type TikTokShortLinkResolution = (
  identity: TikTokShortLinkIdentity,
  request?: Readonly<{ signal?: AbortSignal }>
) => Promise<CanonicalTikTokVideoIdentity>;

export type CreateTikTokPageMetadataProviderOptions = Readonly<{
  fetchBody?: TikTokPageBodyFetcher;
  resolveShortLink?: TikTokShortLinkResolution;
}>;

export type TikTokPageMetadataProvider = Readonly<{
  fetch(url: URL, context?: ExtractorContext): Promise<TikTokSafeMetadata>;
}>;

function error(code: ApiErrorCode = API_ERROR_CODES.EXTRACTOR_FAILED): AppError {
  return new AppError(code);
}

function timeoutSeconds(context?: ExtractorContext): number {
  const value = context?.metadataTimeoutSeconds ?? DEFAULT_METADATA_TIMEOUT_SECONDS;
  if (!Number.isFinite(value) || value <= 0 || value > MAX_METADATA_TIMEOUT_SECONDS) {
    throw new TypeError("TikTok metadata timeout is invalid.");
  }
  return value;
}

function allowPageHostname(hostname: string): boolean {
  return hostname.toLowerCase().replace(/\.$/, "") === TIKTOK_PAGE_HOST;
}

function mapHttpStatus(result: SafeBodyFetchResult): void {
  if (result.statusCode >= 200 && result.statusCode < 300) return;
  if (result.statusCode === 401) throw error(API_ERROR_CODES.LOGIN_REQUIRED);
  if (result.statusCode === 403) throw error(API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE);
  if (result.statusCode === 404 || result.statusCode === 410) throw error(API_ERROR_CODES.CONTENT_UNAVAILABLE);
  if (result.statusCode === 429) throw error(API_ERROR_CODES.RATE_LIMITED);
  if (result.statusCode === 451) throw error(API_ERROR_CODES.REGION_RESTRICTED);
  throw error();
}

function isHtmlContentType(value: string | undefined): boolean {
  return value === "text/html" || value === "application/xhtml+xml";
}

function mapProviderError(caught: unknown, signal: AbortSignal | undefined): AppError {
  if (signal?.aborted) return error(API_ERROR_CODES.JOB_CANCELLED);
  if (caught instanceof AppError) {
    if (caught.status === 504) return error(API_ERROR_CODES.EXTRACTOR_TIMEOUT);
    switch (caught.code) {
      case API_ERROR_CODES.UNSUPPORTED_URL:
      case API_ERROR_CODES.PRIVATE_OR_LOCAL_URL:
      case API_ERROR_CODES.CONTENT_UNAVAILABLE:
      case API_ERROR_CODES.LOGIN_REQUIRED:
      case API_ERROR_CODES.PRIVATE_CONTENT:
      case API_ERROR_CODES.RATE_LIMITED:
      case API_ERROR_CODES.REGION_RESTRICTED:
      case API_ERROR_CODES.AGE_RESTRICTED:
      case API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE:
      case API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED:
      case API_ERROR_CODES.MULTI_ITEM_POST_NOT_SUPPORTED:
      case API_ERROR_CODES.LIVE_NOT_SUPPORTED:
      case API_ERROR_CODES.EXTRACTOR_TIMEOUT:
      case API_ERROR_CODES.JOB_CANCELLED:
      case API_ERROR_CODES.EXTRACTOR_FAILED:
        return error(caught.code);
      default:
        break;
    }
  }
  return error();
}

export function createTikTokPageMetadataProvider(
  options: CreateTikTokPageMetadataProviderOptions = {}
): TikTokPageMetadataProvider {
  const fetchBody = options.fetchBody ?? safeFetchBody;
  const resolveShortLink = options.resolveShortLink ?? resolveTikTokShortLink;
  return Object.freeze({
    async fetch(url: URL, context?: ExtractorContext): Promise<TikTokSafeMetadata> {
      const boundedTimeoutSeconds = timeoutSeconds(context);
      try {
        const classified = classifyTikTokUrl(url);
        const identity = classified.sourceKind === "short-link"
          ? await resolveShortLink(classified, { signal: context?.signal })
          : classified;
        const canonical = canonicalizeTikTokVideoUrl(identity.canonicalUrl);
        const result = await fetchBody(canonical.canonicalUrl, {
          maxBytes: MAX_TIKTOK_PAGE_BYTES,
          timeoutSeconds: boundedTimeoutSeconds,
          maxRedirects: 1,
          requireHttps: true,
          requestProfile: "tiktok-public-page-v1",
          allowHostname: allowPageHostname,
          signal: context?.signal
        });
        mapHttpStatus(result);
        if (
          !isHtmlContentType(result.contentType) ||
          !allowPageHostname(result.finalUrl.hostname) ||
          result.sizeBytes !== result.body.length ||
          result.sizeBytes < 1 ||
          result.sizeBytes > MAX_TIKTOK_PAGE_BYTES
        ) throw error();
        const finalIdentity = canonicalizeTikTokVideoUrl(result.finalUrl);
        if (finalIdentity.videoId !== canonical.videoId) throw error();
        return parseTikTokHydrationMetadata(canonical, result.body);
      } catch (caught) {
        throw mapProviderError(caught, context?.signal);
      }
    }
  });
}

/** Isolated executable surface; production enablement is intentionally deferred to Stage 8.10C. */
export const tiktokPageMetadataProvider = createTikTokPageMetadataProvider();
