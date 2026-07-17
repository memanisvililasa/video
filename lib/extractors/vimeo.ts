import "server-only";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/config/env";
import { AppError } from "@/lib/errors";
import type { DownloadContext, DownloadedSource, Extractor, ExtractorContext } from "@/lib/extractors/types";
import { canonicalizeVimeoPageUrl, supportsVimeoPageUrl } from "@/lib/extractors/vimeo-url";
import type { PlatformFormatStrategy } from "@/lib/extractors/yt-dlp/format-contract";
import type { ParsedPlatformMetadata } from "@/lib/extractors/yt-dlp/parser";
import { createYtDlpMetadataRunner } from "@/lib/extractors/yt-dlp/runner";
import { safeDownloadToFile, type SafeDownloadOptions, type SafeDownloadResult } from "@/lib/http/safe-fetch";
import { sanitizeFilename, sanitizeTitle } from "@/lib/security/sanitize";
import { validateOutboundHostname } from "@/lib/security/ssrf";
import { API_ERROR_CODES, type VideoFormat, type VideoMetadata } from "@/lib/types";

const MAX_VIMEO_FORMATS = 8;
const MAX_DIMENSION = 3_840;
const MAX_PIXELS = 8_294_400;
const MAX_FPS = 120;
const ALLOWED_VIDEO_CODECS = Object.freeze({
  mp4: /^(?:avc1|h264|hev1|hvc1|hevc|av01|mpeg4)(?:[._-]|$)/i,
  mov: /^(?:avc1|h264|hev1|hvc1|hevc|av01|mpeg4)(?:[._-]|$)/i,
  webm: /^(?:vp8|vp9|vp0[89]|av01)(?:[._-]|$)/i
});
const ALLOWED_AUDIO_CODECS = Object.freeze({
  mp4: /^(?:mp4a|aac|ac-?3|ec-?3|mp3)(?:[._-]|$)/i,
  mov: /^(?:mp4a|aac|ac-?3|ec-?3|mp3)(?:[._-]|$)/i,
  webm: /^(?:opus|vorbis)(?:[._-]|$)/i
});
const CONTENT_TYPES = Object.freeze({
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm"
});

export type VimeoMetadataRunner = Readonly<{
  extract(platform: "vimeo", pageUrl: URL, signal?: AbortSignal): Promise<ParsedPlatformMetadata>;
}>;

export type VimeoDownloadToFile = (
  url: URL,
  destinationPath: string,
  options: SafeDownloadOptions
) => Promise<SafeDownloadResult>;

export type CreateVimeoExtractorOptions = Readonly<{
  metadataRunner?: VimeoMetadataRunner;
  downloadToFile?: VimeoDownloadToFile;
}>;

function maximumBytes(context?: ExtractorContext): number {
  return context?.maxFileSizeBytes ?? env.maxFileSizeMb * 1024 * 1024;
}

function hasAllowedCodecs(strategy: PlatformFormatStrategy): boolean {
  const container = strategy.container;
  const videoCodec = strategy.videoCodec;
  const audioCodec = strategy.audioCodec;
  return Boolean(
    videoCodec &&
    audioCodec &&
    ALLOWED_VIDEO_CODECS[container].test(videoCodec) &&
    ALLOWED_AUDIO_CODECS[container].test(audioCodec)
  );
}

function semanticFormatKey(strategy: PlatformFormatStrategy): string {
  return [
    strategy.container,
    strategy.videoCodec?.toLowerCase() ?? "",
    strategy.audioCodec?.toLowerCase() ?? "",
    strategy.width ?? 0,
    strategy.height ?? 0,
    strategy.fps ?? 0,
    strategy.bitrate ?? 0
  ].join("|");
}

export function selectVimeoProgressiveFormats(
  metadata: ParsedPlatformMetadata,
  maxFileSizeBytes: number
): readonly PlatformFormatStrategy[] {
  if (!Number.isSafeInteger(maxFileSizeBytes) || maxFileSizeBytes <= 0) {
    throw new TypeError("Vimeo maximum file size is invalid.");
  }
  const candidates = metadata.strategies.filter((strategy) => {
    if (
      strategy.platform !== "vimeo" ||
      strategy.transport !== "progressive-direct" ||
      strategy.selectedDownloadStrategy !== "single-file" ||
      !strategy.progressiveSource ||
      !strategy.hasAudio ||
      !hasAllowedCodecs(strategy) ||
      !Number.isSafeInteger(strategy.width) ||
      !Number.isSafeInteger(strategy.height) ||
      (strategy.width as number) < 1 ||
      (strategy.height as number) < 1 ||
      (strategy.width as number) > MAX_DIMENSION ||
      (strategy.height as number) > MAX_DIMENSION ||
      (strategy.width as number) * (strategy.height as number) > MAX_PIXELS ||
      (strategy.fps !== undefined && (!Number.isFinite(strategy.fps) || strategy.fps <= 0 || strategy.fps > MAX_FPS))
    ) {
      return false;
    }
    const size = strategy.filesizeBytes ?? strategy.filesizeEstimateBytes;
    return Number.isSafeInteger(size) && (size as number) > 0 && (size as number) <= maxFileSizeBytes;
  }).sort((left, right) => {
    const height = (right.height ?? 0) - (left.height ?? 0);
    if (height !== 0) return height;
    const mp4 = Number(right.container === "mp4") - Number(left.container === "mp4");
    if (mp4 !== 0) return mp4;
    const fps = (right.fps ?? 0) - (left.fps ?? 0);
    if (fps !== 0) return fps;
    return left.stableId.localeCompare(right.stableId, "en");
  });

  const unique = new Map<string, PlatformFormatStrategy>();
  for (const strategy of candidates) {
    const key = semanticFormatKey(strategy);
    if (!unique.has(key)) unique.set(key, strategy);
  }
  return Object.freeze([...unique.values()].slice(0, MAX_VIMEO_FORMATS));
}

function displayFormat(strategy: PlatformFormatStrategy): VideoFormat {
  const quality = `${strategy.height}p`;
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

function safeTitle(value: string): string {
  const title = sanitizeTitle(value, { fallback: "Vimeo video", maxLength: 160 });
  return title.ok ? title.value : "Vimeo video";
}

function safeFilename(title: string, extension: string): string {
  const filename = sanitizeFilename(title, { fallback: "vimeo-video", maxLength: 120 });
  return `${filename.ok ? filename.value : "vimeo-video"}.${extension}`;
}

function assertDownloadedContentType(container: "mp4" | "webm" | "mov", value?: string): void {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (!normalized || normalized === CONTENT_TYPES[container] || normalized === "application/octet-stream") return;
  throw new AppError(API_ERROR_CODES.OUTPUT_INVALID);
}

function mapDownloadError(error: unknown, signal?: AbortSignal): AppError {
  if (signal?.aborted) return new AppError(API_ERROR_CODES.JOB_CANCELLED);
  if (error instanceof AppError) {
    if (
      error.code === API_ERROR_CODES.FILE_TOO_LARGE ||
      error.code === API_ERROR_CODES.PRIVATE_OR_LOCAL_URL ||
      error.code === API_ERROR_CODES.OUTPUT_INVALID ||
      error.code === API_ERROR_CODES.JOB_CANCELLED
    ) return error;
  }
  return new AppError(API_ERROR_CODES.DOWNLOAD_FAILED);
}

export function createVimeoExtractor(options: CreateVimeoExtractorOptions = {}): Extractor {
  let runner = options.metadataRunner;
  const downloadToFile = options.downloadToFile ?? safeDownloadToFile;

  function metadataRunner(): VimeoMetadataRunner {
    runner ??= createYtDlpMetadataRunner();
    return runner;
  }

  async function freshMetadata(url: URL, context?: ExtractorContext) {
    const canonical = canonicalizeVimeoPageUrl(url);
    const metadata = await metadataRunner().extract("vimeo", canonical.url, context?.signal);
    const formats = selectVimeoProgressiveFormats(metadata, maximumBytes(context));
    if (formats.length === 0) throw new AppError(API_ERROR_CODES.NO_SUPPORTED_FORMAT);
    return Object.freeze({ canonical, metadata, formats });
  }

  return Object.freeze({
    id: "vimeo",
    name: "Vimeo",
    supports: supportsVimeoPageUrl,
    async extract(url: URL, context?: ExtractorContext): Promise<VideoMetadata> {
      const fresh = await freshMetadata(url, context);
      return Object.freeze({
        id: createHash("sha256").update(`vimeo\0${fresh.canonical.videoId}`).digest("hex").slice(0, 16),
        originalUrl: "https://vimeo.com/",
        title: safeTitle(fresh.metadata.title),
        durationSeconds: fresh.metadata.durationSeconds,
        platform: "Vimeo",
        formats: fresh.formats.map(displayFormat)
      });
    },
    async download(url: URL, formatId: string, context: DownloadContext): Promise<DownloadedSource> {
      const fresh = await freshMetadata(url, context);
      const selected = fresh.formats.find((format) => format.stableId === formatId);
      const source = selected?.progressiveSource;
      if (!selected || !source) throw new AppError(API_ERROR_CODES.SOURCE_EXPIRED);
      const safety = validateOutboundHostname(source.url.hostname);
      if (!safety.ok) throw new AppError(safety.code);

      const destinationPath = path.join(context.workDir, `source.${selected.container}`);
      try {
        const downloaded = await downloadToFile(source.url, destinationPath, {
          maxBytes: maximumBytes(context),
          signal: context.signal,
          timeoutSeconds: context.downloadTimeoutSeconds,
          requireHttps: true,
          onProgress: context.onDownloadProgress
        });
        assertDownloadedContentType(selected.container, downloaded.contentType);
        return Object.freeze({
          path: destinationPath,
          filename: safeFilename(fresh.metadata.title, selected.container),
          contentType: CONTENT_TYPES[selected.container],
          sizeBytes: downloaded.sizeBytes
        });
      } catch (error) {
        await rm(destinationPath, { force: true }).catch(() => undefined);
        await rm(`${destinationPath}.download`, { force: true }).catch(() => undefined);
        throw mapDownloadError(error, context.signal);
      }
    }
  });
}

export const vimeoExtractor = createVimeoExtractor();
