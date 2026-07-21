import "server-only";
import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/config/env";
import { AppError } from "@/lib/errors";
import {
  parseTikTokMediaManifest,
  type TikTokInternalFormat,
  type TikTokResolvedMediaManifest
} from "@/lib/extractors/tiktok-media-manifest";
import {
  isTikTokMediaHostname,
  validateTikTokMediaLocator
} from "@/lib/extractors/tiktok-media-policy";
import { resolveTikTokShortLink } from "@/lib/extractors/tiktok-short-link";
import {
  canonicalizeTikTokVideoUrl,
  classifyTikTokUrl,
  type CanonicalTikTokVideoIdentity,
  type TikTokShortLinkIdentity
} from "@/lib/extractors/tiktok-url";
import type { DownloadContext, DownloadedSource, ExtractorContext } from "@/lib/extractors/types";
import {
  safeDownloadToFile,
  safeFetchBody,
  type SafeBodyFetchOptions,
  type SafeBodyFetchResult,
  type SafeDownloadOptions,
  type SafeDownloadResult
} from "@/lib/http/safe-fetch";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";

const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_METADATA_TIMEOUT_SECONDS = 10;
const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 120;
const PAGE_HOST = "www.tiktok.com";

export type TikTokMediaPageBodyFetcher = (
  url: URL,
  options: SafeBodyFetchOptions
) => Promise<SafeBodyFetchResult>;

export type TikTokMediaDownloadToFile = (
  url: URL,
  destinationPath: string,
  options: SafeDownloadOptions
) => Promise<SafeDownloadResult>;

export type TikTokMediaShortLinkResolution = (
  identity: TikTokShortLinkIdentity,
  request?: Readonly<{ signal?: AbortSignal }>
) => Promise<CanonicalTikTokVideoIdentity>;

export type TikTokInternalAnalysis = Readonly<{
  title: string;
  durationSeconds: number;
  width: number;
  height: number;
  orientation: "portrait" | "landscape" | "square";
  formats: readonly TikTokInternalFormat[];
}>;

export type TikTokDownloadedSource = DownloadedSource & Readonly<{
  format: TikTokInternalFormat;
}>;

export type TikTokMediaAdapter = Readonly<{
  analyze(url: URL, context?: ExtractorContext): Promise<TikTokInternalAnalysis>;
  download(url: URL, formatId: string, context: DownloadContext): Promise<TikTokDownloadedSource>;
}>;

export type CreateTikTokMediaAdapterOptions = Readonly<{
  fetchBody?: TikTokMediaPageBodyFetcher;
  resolveShortLink?: TikTokMediaShortLinkResolution;
  downloadToFile?: TikTokMediaDownloadToFile;
  now?: () => number;
}>;

function safeError(code: ApiErrorCode = API_ERROR_CODES.EXTRACTOR_FAILED): AppError {
  return new AppError(code);
}

function maximumBytes(context?: ExtractorContext): number {
  const value = context?.maxFileSizeBytes ?? Math.floor(env.maxFileSizeMb * 1024 * 1024);
  if (!Number.isSafeInteger(value) || value < 1 || value > 500 * 1024 * 1024) {
    throw new TypeError("TikTok media byte limit is invalid.");
  }
  return value;
}

function timeoutSeconds(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected <= 0 || selected > maximum) {
    throw new TypeError("TikTok media timeout is invalid.");
  }
  return selected;
}

function mapPageStatus(result: SafeBodyFetchResult): void {
  if (result.statusCode >= 200 && result.statusCode < 300) return;
  if (result.statusCode === 401) throw safeError(API_ERROR_CODES.LOGIN_REQUIRED);
  if (result.statusCode === 403) throw safeError(API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE);
  if (result.statusCode === 404 || result.statusCode === 410) throw safeError(API_ERROR_CODES.CONTENT_UNAVAILABLE);
  if (result.statusCode === 429) throw safeError(API_ERROR_CODES.RATE_LIMITED);
  if (result.statusCode === 451) throw safeError(API_ERROR_CODES.REGION_RESTRICTED);
  throw safeError();
}

function mapError(
  caught: unknown,
  signal: AbortSignal | undefined,
  fallback: ApiErrorCode
): AppError {
  if (signal?.aborted) return safeError(API_ERROR_CODES.JOB_CANCELLED);
  if (caught instanceof AppError) {
    const allowed: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
      API_ERROR_CODES.CONTENT_UNAVAILABLE,
      API_ERROR_CODES.LOGIN_REQUIRED,
      API_ERROR_CODES.PRIVATE_CONTENT,
      API_ERROR_CODES.RATE_LIMITED,
      API_ERROR_CODES.REGION_RESTRICTED,
      API_ERROR_CODES.AGE_RESTRICTED,
      API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE,
      API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED,
      API_ERROR_CODES.MULTI_ITEM_POST_NOT_SUPPORTED,
      API_ERROR_CODES.LIVE_NOT_SUPPORTED,
      API_ERROR_CODES.FILE_TOO_LARGE,
      API_ERROR_CODES.VIDEO_TOO_LONG,
      API_ERROR_CODES.NO_SUPPORTED_FORMAT,
      API_ERROR_CODES.SOURCE_EXPIRED,
      API_ERROR_CODES.SOURCE_HAS_NO_AUDIO,
      API_ERROR_CODES.JOB_CANCELLED,
      API_ERROR_CODES.DOWNLOAD_FAILED,
      API_ERROR_CODES.OUTPUT_INVALID,
      API_ERROR_CODES.EXTRACTOR_FAILED,
      API_ERROR_CODES.PRIVATE_OR_LOCAL_URL
    ]);
    if (allowed.has(caught.code)) return safeError(caught.code);
  }
  return safeError(fallback);
}

async function canonicalWorkDirectory(workDir: string): Promise<string> {
  if (!path.isAbsolute(workDir) || /[\u0000\r\n]/.test(workDir)) throw safeError(API_ERROR_CODES.DOWNLOAD_FAILED);
  try {
    const direct = await lstat(workDir);
    const canonical = await realpath(workDir);
    if (!direct.isDirectory() || direct.isSymbolicLink()) throw safeError(API_ERROR_CODES.DOWNLOAD_FAILED);
    return canonical;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw safeError(API_ERROR_CODES.DOWNLOAD_FAILED);
  }
}

function assertMediaContentType(value?: string): void {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (!normalized || !new Set(["video/mp4", "application/mp4", "application/octet-stream"]).has(normalized)) {
    throw safeError(API_ERROR_CODES.OUTPUT_INVALID);
  }
}

export function createTikTokMediaAdapter(options: CreateTikTokMediaAdapterOptions = {}): TikTokMediaAdapter {
  const fetchBody = options.fetchBody ?? safeFetchBody;
  const resolveShort = options.resolveShortLink ?? resolveTikTokShortLink;
  const downloadToFile = options.downloadToFile ?? safeDownloadToFile;
  const now = options.now ?? Date.now;

  async function fresh(url: URL, context?: ExtractorContext): Promise<TikTokResolvedMediaManifest> {
    try {
      const classified = classifyTikTokUrl(url);
      const identity = classified.sourceKind === "short-link"
        ? await resolveShort(classified, { signal: context?.signal })
        : classified;
      const canonical = canonicalizeTikTokVideoUrl(identity.canonicalUrl);
      const page = await fetchBody(canonical.canonicalUrl, {
        maxBytes: MAX_PAGE_BYTES,
        timeoutSeconds: timeoutSeconds(context?.metadataTimeoutSeconds, DEFAULT_METADATA_TIMEOUT_SECONDS, 10),
        maxRedirects: 1,
        requireHttps: true,
        requestProfile: "tiktok-public-page-v1",
        allowHostname: (hostname) => hostname.toLowerCase().replace(/\.$/, "") === PAGE_HOST,
        signal: context?.signal
      });
      mapPageStatus(page);
      if (
        (page.contentType !== "text/html" && page.contentType !== "application/xhtml+xml") ||
        page.sizeBytes !== page.body.length ||
        page.sizeBytes < 1 ||
        page.sizeBytes > MAX_PAGE_BYTES
      ) throw safeError();
      const finalIdentity = canonicalizeTikTokVideoUrl(page.finalUrl);
      if (finalIdentity.videoId !== canonical.videoId) throw safeError();
      const manifest = parseTikTokMediaManifest(canonical, page.body, {
        nowMs: now(),
        maxFileSizeBytes: maximumBytes(context)
      });
      if (
        context?.maxDurationSeconds !== undefined &&
        manifest.metadata.durationSeconds > context.maxDurationSeconds
      ) throw safeError(API_ERROR_CODES.VIDEO_TOO_LONG);
      return manifest;
    } catch (error) {
      throw mapError(error, context?.signal, API_ERROR_CODES.EXTRACTOR_FAILED);
    }
  }

  return Object.freeze({
    async analyze(url: URL, context?: ExtractorContext): Promise<TikTokInternalAnalysis> {
      const resolved = await fresh(url, context);
      return Object.freeze({
        title: resolved.metadata.title,
        durationSeconds: resolved.metadata.durationSeconds,
        width: resolved.metadata.width,
        height: resolved.metadata.height,
        orientation: resolved.metadata.orientation,
        formats: Object.freeze(resolved.formats.map((format) => format.descriptor))
      });
    },
    async download(url: URL, formatId: string, context: DownloadContext): Promise<TikTokDownloadedSource> {
      const workDir = await canonicalWorkDirectory(context.workDir);
      const destinationPath = path.join(workDir, "source.mp4");
      try {
        if (context.processingPreset === "audio-only") throw safeError(API_ERROR_CODES.SOURCE_HAS_NO_AUDIO);
        if (context.processingPreset && context.processingPreset !== "original" && context.processingPreset !== "compatible-mp4") {
          throw safeError(API_ERROR_CODES.NO_SUPPORTED_FORMAT);
        }
        const resolved = await fresh(url, context);
        const selected = resolved.formats.find((format) => format.descriptor.id === formatId);
        if (!selected) throw safeError(API_ERROR_CODES.SOURCE_EXPIRED);
        const reference = selected.locatorReferences[0];
        if (!reference) throw safeError(API_ERROR_CODES.SOURCE_EXPIRED);
        const locator = validateTikTokMediaLocator(reference.locator, now());
        const result = await downloadToFile(locator.url, destinationPath, {
          maxBytes: maximumBytes(context),
          timeoutSeconds: timeoutSeconds(context.downloadTimeoutSeconds, DEFAULT_DOWNLOAD_TIMEOUT_SECONDS, 120),
          maxRedirects: 0,
          requireHttps: true,
          requestProfile: "tiktok-media-v1",
          allowHostname: isTikTokMediaHostname,
          signal: context.signal,
          onProgress: context.onDownloadProgress
        });
        validateTikTokMediaLocator(result.finalUrl, now());
        assertMediaContentType(result.contentType);
        return Object.freeze({
          path: destinationPath,
          filename: "tiktok-video.mp4",
          contentType: "video/mp4",
          sizeBytes: result.sizeBytes,
          format: selected.descriptor
        });
      } catch (error) {
        await Promise.all([
          rm(destinationPath, { force: true }),
          rm(`${destinationPath}.download`, { force: true })
        ].map((operation) => operation.catch(() => undefined)));
        throw mapError(error, context.signal, API_ERROR_CODES.DOWNLOAD_FAILED);
      }
    }
  });
}

export const tiktokMediaAdapter = createTikTokMediaAdapter();
