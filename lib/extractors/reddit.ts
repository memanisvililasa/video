import "server-only";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/config/env";
import { AppError } from "@/lib/errors";
import { normalizeRedditFormats, type RedditFormatStrategy } from "@/lib/extractors/reddit-formats";
import {
  createRedditManifestProvider,
  createRedditSilentFallbackManifest,
  isRedditMediaHostname,
  isRedditMediaUrl,
  type RedditManifestProvider
} from "@/lib/extractors/reddit-manifest";
import {
  createRedditMetadataProvider,
  type RedditMetadataProvider
} from "@/lib/extractors/reddit-metadata";
import { canonicalizeRedditPostUrl, supportsRedditPostUrl } from "@/lib/extractors/reddit-url";
import type { DownloadContext, DownloadedSource, Extractor, ExtractorContext } from "@/lib/extractors/types";
import { mergeAudioVideo, type MergeAudioVideoOptions, type MergeAudioVideoResult } from "@/lib/ffmpeg/merge";
import { safeDownloadToFile, type SafeDownloadOptions, type SafeDownloadResult } from "@/lib/http/safe-fetch";
import { sanitizeFilename, sanitizeTitle } from "@/lib/security/sanitize";
import { API_ERROR_CODES, type VideoFormat, type VideoMetadata } from "@/lib/types";

const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 120;

export type RedditDownloadToFile = (
  url: URL,
  destinationPath: string,
  options: SafeDownloadOptions
) => Promise<SafeDownloadResult>;

export type RedditMerge = (options: MergeAudioVideoOptions) => Promise<MergeAudioVideoResult>;

export type CreateRedditExtractorOptions = Readonly<{
  metadataProvider?: RedditMetadataProvider;
  manifestProvider?: RedditManifestProvider;
  downloadToFile?: RedditDownloadToFile;
  mergeSources?: RedditMerge;
  allowMediaHostname?: (hostname: string) => boolean;
  now?: () => number;
}>;

function maximumBytes(context?: ExtractorContext): number {
  const value = context?.maxFileSizeBytes ?? env.maxFileSizeMb * 1024 * 1024;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("Reddit maximum file size is invalid.");
  return value;
}

function safeTitle(value: string): string {
  const title = sanitizeTitle(value, { fallback: "Reddit video", maxLength: 160 });
  return title.ok ? title.value : "Reddit video";
}

function safeFilename(title: string): string {
  const filename = sanitizeFilename(title, { fallback: "reddit-video", maxLength: 120 });
  return `${filename.ok ? filename.value : "reddit-video"}.mp4`;
}

function displayFormat(strategy: RedditFormatStrategy): VideoFormat {
  const tier = Math.min(strategy.width, strategy.height);
  const quality = `${tier}p`;
  return Object.freeze({
    id: strategy.stableId,
    label: `${quality} MP4${strategy.topology === "silent" ? " · без аудио" : ""}`,
    quality,
    ext: "mp4",
    width: strategy.width,
    height: strategy.height,
    filesizeBytes: strategy.filesizeEstimateBytes,
    hasAudio: strategy.topology !== "silent",
    hasVideo: true
  });
}

function assertMediaContentType(kind: "progressive" | "video" | "audio", value?: string): void {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  const allowed = kind === "audio"
    ? new Set(["audio/mp4", "application/mp4", "application/octet-stream"])
    : new Set(["video/mp4", "application/mp4", "application/octet-stream"]);
  if (normalized && !allowed.has(normalized)) throw new AppError(API_ERROR_CODES.OUTPUT_INVALID);
}

function mapDownloadError(caught: unknown, signal?: AbortSignal): AppError {
  if (signal?.aborted) return new AppError(API_ERROR_CODES.JOB_CANCELLED);
  if (caught instanceof AppError) {
    if (
      caught.code === API_ERROR_CODES.FILE_TOO_LARGE ||
      caught.code === API_ERROR_CODES.PRIVATE_OR_LOCAL_URL ||
      caught.code === API_ERROR_CODES.OUTPUT_INVALID ||
      caught.code === API_ERROR_CODES.JOB_CANCELLED ||
      caught.code === API_ERROR_CODES.MERGE_FAILED ||
      caught.code === API_ERROR_CODES.FFMPEG_NOT_AVAILABLE ||
      caught.code === API_ERROR_CODES.PROCESSING_TIMEOUT ||
      caught.code === API_ERROR_CODES.UNSUPPORTED_CODEC ||
      caught.code === API_ERROR_CODES.SOURCE_HAS_NO_AUDIO
    ) return new AppError(caught.code);
  }
  return new AppError(API_ERROR_CODES.DOWNLOAD_FAILED);
}

function assertWorkDirectory(workDir: string): string {
  if (!path.isAbsolute(workDir) || /[\u0000\r\n]/.test(workDir)) {
    throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED);
  }
  return path.resolve(workDir);
}

/**
 * Internal-only Stage 8.4B extractor. It is intentionally not imported by the
 * production extractor registry until Stage 8.4C product integration.
 */
export function createRedditExtractor(options: CreateRedditExtractorOptions = {}): Extractor {
  const metadataProvider = options.metadataProvider ?? createRedditMetadataProvider();
  const manifestProvider = options.manifestProvider ?? createRedditManifestProvider();
  const downloadToFile = options.downloadToFile ?? safeDownloadToFile;
  const mergeSources = options.mergeSources ?? mergeAudioVideo;
  const allowMediaHostname = options.allowMediaHostname ?? isRedditMediaHostname;
  const now = options.now ?? Date.now;

  async function freshFormats(url: URL, context?: ExtractorContext) {
    const canonical = canonicalizeRedditPostUrl(url);
    const resolved = await metadataProvider.resolve(url, context);
    if (resolved.product.canonicalPostId !== canonical.postId || !resolved.product.redditHostedVideo) {
      throw new AppError(API_ERROR_CODES.EXTRACTOR_FAILED);
    }
    if (
      resolved.product.durationSeconds !== undefined &&
      context?.maxDurationSeconds !== undefined &&
      resolved.product.durationSeconds > context.maxDurationSeconds
    ) throw new AppError(API_ERROR_CODES.VIDEO_TOO_LONG);

    const manifest = resolved.locator.dashManifestUrl
      ? await manifestProvider.fetch(resolved.locator, context)
      : resolved.product.hasAudio === false && resolved.product.durationSeconds !== undefined
        ? createRedditSilentFallbackManifest(resolved.locator, resolved.product.durationSeconds)
        : undefined;
    if (!manifest || manifest.mediaId !== resolved.locator.mediaId) {
      throw new AppError(API_ERROR_CODES.NO_SUPPORTED_FORMAT);
    }
    if (resolved.product.durationSeconds !== undefined) {
      const tolerance = Math.max(1, resolved.product.durationSeconds * 0.02);
      if (Math.abs(manifest.durationSeconds - resolved.product.durationSeconds) > tolerance) {
        throw new AppError(API_ERROR_CODES.NO_SUPPORTED_FORMAT);
      }
    }
    const formats = normalizeRedditFormats({
      postId: canonical.postId,
      manifest,
      hasAudio: resolved.product.hasAudio,
      maxFileSizeBytes: maximumBytes(context),
      maxDurationSeconds: context?.maxDurationSeconds
    });
    if (formats.length === 0) throw new AppError(API_ERROR_CODES.NO_SUPPORTED_FORMAT);
    return Object.freeze({ canonical, resolved, formats });
  }

  async function downloadReference(
    selected: RedditFormatStrategy,
    source: NonNullable<RedditFormatStrategy["progressiveSource"]>,
    destinationPath: string,
    context: DownloadContext,
    maxBytes: number,
    timeoutSeconds: number,
    onProgress: (bytes: number) => void
  ): Promise<SafeDownloadResult> {
    if (
      !isRedditMediaUrl(source.url, selected.mediaId) ||
      !allowMediaHostname(source.url.hostname)
    ) throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED);
    const result = await downloadToFile(source.url, destinationPath, {
      maxBytes,
      timeoutSeconds,
      maxRedirects: 2,
      requireHttps: true,
      requestProfile: "reddit-media-v1",
      allowHostname: (hostname) => allowMediaHostname(hostname) && isRedditMediaHostname(hostname),
      signal: context.signal,
      onProgress(bytes) {
        onProgress(bytes);
      }
    });
    if (!isRedditMediaUrl(result.finalUrl, selected.mediaId)) throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED);
    assertMediaContentType(source.kind, result.contentType);
    return result;
  }

  return Object.freeze({
    id: "reddit-internal",
    name: "Reddit (internal)",
    supports: supportsRedditPostUrl,
    async extract(url: URL, context?: ExtractorContext): Promise<VideoMetadata> {
      const fresh = await freshFormats(url, context);
      return Object.freeze({
        id: createHash("sha256").update(`reddit\0${fresh.canonical.postId}`).digest("hex").slice(0, 16),
        originalUrl: "https://www.reddit.com/",
        title: safeTitle(fresh.resolved.product.title),
        durationSeconds: fresh.resolved.product.durationSeconds ?? fresh.formats[0].durationSeconds,
        platform: "Reddit",
        formats: fresh.formats.map(displayFormat)
      });
    },
    async download(url: URL, formatId: string, context: DownloadContext): Promise<DownloadedSource> {
      const fresh = await freshFormats(url, context);
      const selected = fresh.formats.find((format) => format.stableId === formatId);
      if (!selected) throw new AppError(API_ERROR_CODES.SOURCE_EXPIRED);
      if (context.processingPreset === "audio-only" && selected.topology === "silent") {
        throw new AppError(API_ERROR_CODES.SOURCE_HAS_NO_AUDIO);
      }
      const workDir = assertWorkDirectory(context.workDir);
      const destinationPath = path.join(workDir, "source.mp4");
      const temporaryPaths: string[] = [];
      const budgetBytes = maximumBytes(context);
      const budgetSeconds = context.downloadTimeoutSeconds ?? DEFAULT_DOWNLOAD_TIMEOUT_SECONDS;
      if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) throw new TypeError("Reddit download timeout is invalid.");
      const deadline = now() + budgetSeconds * 1_000;
      let reportedBytes = 0;
      const report = (bytes: number, total = selected.filesizeEstimateBytes) => {
        if (!Number.isFinite(bytes) || bytes < reportedBytes) return;
        reportedBytes = Math.min(budgetBytes, Math.floor(bytes));
        context.onDownloadProgress?.(reportedBytes, Math.min(budgetBytes, Math.max(1, total)));
      };
      const remainingSeconds = () => {
        const value = (deadline - now()) / 1_000;
        if (!Number.isFinite(value) || value <= 0) throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED);
        return value;
      };

      try {
        if (context.processingPreset === "audio-only") {
          const source = selected.topology === "progressive" ? selected.progressiveSource : selected.audioSource;
          if (!source) throw new AppError(API_ERROR_CODES.SOURCE_HAS_NO_AUDIO);
          const downloaded = await downloadReference(
            selected,
            source,
            destinationPath,
            context,
            budgetBytes,
            remainingSeconds(),
            report
          );
          return Object.freeze({
            path: destinationPath,
            filename: safeFilename(fresh.resolved.product.title),
            contentType: source.kind === "audio" ? "audio/mp4" : "video/mp4",
            sizeBytes: downloaded.sizeBytes
          });
        }

        if (selected.topology === "progressive" || selected.topology === "silent") {
          const source = selected.progressiveSource ?? selected.videoSource;
          if (!source) throw new AppError(API_ERROR_CODES.SOURCE_EXPIRED);
          const downloaded = await downloadReference(
            selected,
            source,
            destinationPath,
            context,
            budgetBytes,
            remainingSeconds(),
            report
          );
          return Object.freeze({
            path: destinationPath,
            filename: safeFilename(fresh.resolved.product.title),
            contentType: "video/mp4",
            sizeBytes: downloaded.sizeBytes
          });
        }

        const video = selected.videoSource;
        const audio = selected.audioSource;
        if (!video || !audio) throw new AppError(API_ERROR_CODES.SOURCE_EXPIRED);
        const videoPath = path.join(workDir, "reddit-video.mp4");
        const audioPath = path.join(workDir, "reddit-audio.m4a");
        temporaryPaths.push(videoPath, `${videoPath}.download`, audioPath, `${audioPath}.download`);
        const first = await downloadReference(
          selected,
          video,
          videoPath,
          context,
          budgetBytes,
          remainingSeconds(),
          (bytes) => report(bytes)
        );
        const remainingBytes = budgetBytes - first.sizeBytes;
        if (remainingBytes <= 0) throw new AppError(API_ERROR_CODES.FILE_TOO_LARGE);
        await downloadReference(
          selected,
          audio,
          audioPath,
          context,
          remainingBytes,
          remainingSeconds(),
          (bytes) => report(first.sizeBytes + bytes)
        );
        const merged = await mergeSources({
          videoPath,
          audioPath,
          outputPath: destinationPath,
          container: "mp4",
          signal: context.signal
        });
        return Object.freeze({
          path: destinationPath,
          filename: safeFilename(fresh.resolved.product.title),
          contentType: "video/mp4",
          sizeBytes: merged.sizeBytes
        });
      } catch (caught) {
        await Promise.all([
          rm(destinationPath, { force: true }),
          rm(`${destinationPath}.download`, { force: true }),
          ...temporaryPaths.map((candidate) => rm(candidate, { force: true }))
        ].map((operation) => operation.catch(() => undefined)));
        throw mapDownloadError(caught, context.signal);
      } finally {
        await Promise.all(temporaryPaths.map((candidate) => rm(candidate, { force: true }).catch(() => undefined)));
      }
    }
  });
}
