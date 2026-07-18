import "server-only";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/config/env";
import { AppError } from "@/lib/errors";
import type { DownloadContext, DownloadedSource, Extractor, ExtractorContext } from "@/lib/extractors/types";
import { selectYouTubeFormats } from "@/lib/extractors/youtube-formats";
import { canonicalizeYouTubePageUrl, supportsYouTubePageUrl } from "@/lib/extractors/youtube-url";
import type { DirectMediaReference, PlatformFormatStrategy } from "@/lib/extractors/yt-dlp/format-contract";
import type { ParsedPlatformMetadata } from "@/lib/extractors/yt-dlp/parser";
import { createYtDlpMetadataRunner } from "@/lib/extractors/yt-dlp/runner";
import { mergeAudioVideo, type MergeAudioVideoOptions, type MergeAudioVideoResult } from "@/lib/ffmpeg/merge";
import { safeDownloadToFile, type SafeDownloadOptions, type SafeDownloadResult } from "@/lib/http/safe-fetch";
import { sanitizeFilename, sanitizeTitle } from "@/lib/security/sanitize";
import { API_ERROR_CODES, type VideoFormat, type VideoMetadata } from "@/lib/types";

const CONTENT_TYPES = Object.freeze({ mp4: "video/mp4", webm: "video/webm" });

export type YouTubeMetadataRunner = Readonly<{
  extract(platform: "youtube", pageUrl: URL, signal?: AbortSignal): Promise<ParsedPlatformMetadata>;
}>;
export type YouTubeDownloadToFile = (
  url: URL,
  destinationPath: string,
  options: SafeDownloadOptions
) => Promise<SafeDownloadResult>;
export type YouTubeMerge = (options: MergeAudioVideoOptions) => Promise<MergeAudioVideoResult>;
export type CreateYouTubeExtractorOptions = Readonly<{
  metadataRunner?: YouTubeMetadataRunner;
  downloadToFile?: YouTubeDownloadToFile;
  mergeSources?: YouTubeMerge;
  allowMediaHostname?: (hostname: string) => boolean;
}>;

function maximumBytes(context?: ExtractorContext): number {
  return context?.maxFileSizeBytes ?? env.maxFileSizeMb * 1024 * 1024;
}

function isGoogleVideoHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "googlevideo.com" || normalized.endsWith(".googlevideo.com");
}

function safeTitle(value: string): string {
  const title = sanitizeTitle(value, { fallback: "YouTube video", maxLength: 160 });
  return title.ok ? title.value : "YouTube video";
}

function safeFilename(title: string, extension: string): string {
  const filename = sanitizeFilename(title, { fallback: "youtube-video", maxLength: 120 });
  return `${filename.ok ? filename.value : "youtube-video"}.${extension}`;
}

function displayFormat(strategy: PlatformFormatStrategy): VideoFormat {
  const quality = `${strategy.qualityTier}p`;
  return Object.freeze({
    id: strategy.stableId,
    label: `${quality} ${strategy.container.toUpperCase()}`,
    quality,
    ext: strategy.container,
    width: strategy.width,
    height: strategy.height,
    filesizeBytes: strategy.filesizeBytes ?? strategy.filesizeEstimateBytes,
    hasAudio: true,
    hasVideo: true
  });
}

function assertContentType(container: "mp4" | "webm", value?: string): void {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  const allowed = container === "mp4"
    ? new Set(["video/mp4", "audio/mp4", "application/mp4", "application/octet-stream"])
    : new Set(["video/webm", "audio/webm", "application/octet-stream"]);
  if (normalized && !allowed.has(normalized)) throw new AppError(API_ERROR_CODES.OUTPUT_INVALID);
}

function mapDownloadError(error: unknown, signal?: AbortSignal): AppError {
  if (signal?.aborted) return new AppError(API_ERROR_CODES.JOB_CANCELLED);
  if (error instanceof AppError) {
    if (
      error.code === API_ERROR_CODES.FILE_TOO_LARGE ||
      error.code === API_ERROR_CODES.PRIVATE_OR_LOCAL_URL ||
      error.code === API_ERROR_CODES.OUTPUT_INVALID ||
      error.code === API_ERROR_CODES.JOB_CANCELLED ||
      error.code === API_ERROR_CODES.MERGE_FAILED ||
      error.code === API_ERROR_CODES.FFMPEG_NOT_AVAILABLE ||
      error.code === API_ERROR_CODES.PROCESSING_TIMEOUT ||
      error.code === API_ERROR_CODES.UNSUPPORTED_CODEC
    ) return error;
  }
  return new AppError(API_ERROR_CODES.DOWNLOAD_FAILED);
}

function assertFreshIdentity(metadata: ParsedPlatformMetadata, videoId: string, context?: ExtractorContext): void {
  if (metadata.sourceId !== videoId) throw new AppError(API_ERROR_CODES.EXTRACTOR_FAILED);
  if (
    metadata.durationSeconds !== undefined &&
    context?.maxDurationSeconds !== undefined &&
    metadata.durationSeconds > context.maxDurationSeconds
  ) throw new AppError(API_ERROR_CODES.VIDEO_TOO_LONG);
}

function sourceContainer(reference: DirectMediaReference): "mp4" | "webm" {
  return reference.container === "webm" ? "webm" : "mp4";
}

function selectedContainer(strategy: PlatformFormatStrategy): "mp4" | "webm" {
  if (strategy.container !== "mp4" && strategy.container !== "webm") {
    throw new AppError(API_ERROR_CODES.NO_SUPPORTED_FORMAT);
  }
  return strategy.container;
}

export function createYouTubeExtractor(options: CreateYouTubeExtractorOptions = {}): Extractor {
  let runner = options.metadataRunner;
  const downloadToFile = options.downloadToFile ?? safeDownloadToFile;
  const mergeSources = options.mergeSources ?? mergeAudioVideo;
  const allowMediaHostname = options.allowMediaHostname ?? isGoogleVideoHostname;

  function metadataRunner(): YouTubeMetadataRunner {
    runner ??= createYtDlpMetadataRunner();
    return runner;
  }

  async function freshMetadata(url: URL, context?: ExtractorContext) {
    const canonical = canonicalizeYouTubePageUrl(url);
    const metadata = await metadataRunner().extract("youtube", canonical.url, context?.signal);
    assertFreshIdentity(metadata, canonical.videoId, context);
    const formats = selectYouTubeFormats(metadata, maximumBytes(context));
    if (formats.length === 0) throw new AppError(API_ERROR_CODES.NO_SUPPORTED_FORMAT);
    return Object.freeze({ canonical, metadata, formats });
  }

  async function downloadReference(
    reference: DirectMediaReference,
    destinationPath: string,
    context: DownloadContext,
    maxBytes: number,
    onProgress?: (downloadedBytes: number, totalBytes?: number) => void
  ): Promise<SafeDownloadResult> {
    if (reference.requestProfile !== "youtube-public-v1" || !allowMediaHostname(reference.url.hostname)) {
      throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED);
    }
    const result = await downloadToFile(reference.url, destinationPath, {
      maxBytes,
      signal: context.signal,
      timeoutSeconds: context.downloadTimeoutSeconds,
      requireHttps: true,
      requestProfile: "youtube-public-v1",
      allowHostname: allowMediaHostname,
      onProgress
    });
    assertContentType(sourceContainer(reference), result.contentType);
    return result;
  }

  return Object.freeze({
    id: "youtube",
    name: "YouTube",
    supports: supportsYouTubePageUrl,
    async extract(url: URL, context?: ExtractorContext): Promise<VideoMetadata> {
      const fresh = await freshMetadata(url, context);
      return Object.freeze({
        id: createHash("sha256").update(`youtube\0${fresh.canonical.videoId}`).digest("hex").slice(0, 16),
        originalUrl: "https://www.youtube.com/",
        title: safeTitle(fresh.metadata.title),
        durationSeconds: fresh.metadata.durationSeconds,
        platform: "YouTube",
        formats: fresh.formats.map(displayFormat)
      });
    },
    async download(url: URL, formatId: string, context: DownloadContext): Promise<DownloadedSource> {
      const fresh = await freshMetadata(url, context);
      const selected = fresh.formats.find((format) => format.stableId === formatId);
      if (!selected) throw new AppError(API_ERROR_CODES.SOURCE_EXPIRED);
      const container = selectedContainer(selected);
      const destinationPath = path.join(context.workDir, `source.${container}`);
      const temporaryPaths: string[] = [];
      try {
        if (context.processingPreset === "audio-only") {
          const audio = selected.audioOnlySource;
          if (!audio) throw new AppError(API_ERROR_CODES.SOURCE_EXPIRED);
          const downloaded = await downloadReference(audio, destinationPath, context, maximumBytes(context), context.onDownloadProgress);
          return Object.freeze({
            path: destinationPath,
            filename: safeFilename(fresh.metadata.title, container),
            contentType: container === "mp4" ? "audio/mp4" : "audio/webm",
            sizeBytes: downloaded.sizeBytes
          });
        }

        if (selected.transport === "progressive-direct") {
          const source = selected.progressiveSource;
          if (!source) throw new AppError(API_ERROR_CODES.SOURCE_EXPIRED);
          const downloaded = await downloadReference(source, destinationPath, context, maximumBytes(context), context.onDownloadProgress);
          return Object.freeze({
            path: destinationPath,
            filename: safeFilename(fresh.metadata.title, container),
            contentType: CONTENT_TYPES[container],
            sizeBytes: downloaded.sizeBytes
          });
        }

        const video = selected.videoSource;
        const audio = selected.audioSource;
        if (!video || !audio) throw new AppError(API_ERROR_CODES.SOURCE_EXPIRED);
        const videoPath = path.join(context.workDir, `youtube-video.${sourceContainer(video)}`);
        const audioPath = path.join(context.workDir, `youtube-audio.${sourceContainer(audio)}`);
        temporaryPaths.push(videoPath, `${videoPath}.download`, audioPath, `${audioPath}.download`);
        const estimatedVideo = video.filesizeBytes ?? video.filesizeEstimateBytes;
        const estimatedAudio = audio.filesizeBytes ?? audio.filesizeEstimateBytes;
        const expectedTotal = estimatedVideo && estimatedAudio ? estimatedVideo + estimatedAudio : undefined;
        const first = await downloadReference(video, videoPath, context, maximumBytes(context), (bytes) => {
          context.onDownloadProgress?.(bytes, expectedTotal);
        });
        const remaining = maximumBytes(context) - first.sizeBytes;
        if (remaining <= 0) throw new AppError(API_ERROR_CODES.FILE_TOO_LARGE);
        await downloadReference(audio, audioPath, context, remaining, (bytes) => {
          context.onDownloadProgress?.(first.sizeBytes + bytes, expectedTotal);
        });
        const merged = await mergeSources({
          videoPath,
          audioPath,
          outputPath: destinationPath,
          container,
          signal: context.signal
        });
        return Object.freeze({
          path: destinationPath,
          filename: safeFilename(fresh.metadata.title, container),
          contentType: CONTENT_TYPES[container],
          sizeBytes: merged.sizeBytes
        });
      } catch (error) {
        await Promise.all([
          rm(destinationPath, { force: true }),
          rm(`${destinationPath}.download`, { force: true }),
          ...temporaryPaths.map((candidate) => rm(candidate, { force: true }))
        ].map((operation) => operation.catch(() => undefined)));
        throw mapDownloadError(error, context.signal);
      } finally {
        await Promise.all(temporaryPaths.map((candidate) => rm(candidate, { force: true }).catch(() => undefined)));
      }
    }
  });
}

export const youtubeExtractor = createYouTubeExtractor();
