import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { env } from "@/lib/config/env";
import { safeDownloadToFile, safeGetMetadata, safeHead, type SafeResponseMetadata } from "@/lib/http/safe-fetch";
import { sanitizeFilename, sanitizeTitle } from "@/lib/security/sanitize";
import { API_ERROR_CODES, type VideoFormat, type VideoMetadata } from "@/lib/types";
import type { DownloadContext, DownloadedSource, Extractor, ExtractorContext } from "@/lib/extractors/types";

const DIRECT_MEDIA_FORMAT_ID = "direct-source";
const EXTENSIONS = ["mp4", "webm", "mov"] as const;
const MEDIA_TYPES: Record<(typeof EXTENSIONS)[number], readonly string[]> = {
  mp4: ["video/mp4", "application/mp4", "application/octet-stream"],
  webm: ["video/webm", "application/octet-stream"],
  mov: ["video/quicktime", "video/mp4", "application/octet-stream"]
};

function getExtension(url: URL): (typeof EXTENSIONS)[number] | null {
  const extension = path.extname(url.pathname).replace(".", "").toLowerCase();
  return EXTENSIONS.includes(extension as (typeof EXTENSIONS)[number]) ? extension as (typeof EXTENSIONS)[number] : null;
}

function parseFullSizeFromContentRange(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/\/(\d+)$/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function getSizeBytes(response: SafeResponseMetadata): number | undefined {
  return parseFullSizeFromContentRange(response.headers["content-range"]) ?? response.contentLength;
}

function maxFileSizeBytes(context?: ExtractorContext): number {
  return context?.maxFileSizeBytes ?? env.maxFileSizeMb * 1024 * 1024;
}

function assertAllowedContentType(extension: (typeof EXTENSIONS)[number], contentType?: string): void {
  if (!contentType) return;

  const normalized = contentType.split(";")[0]?.trim().toLowerCase();
  if (normalized && MEDIA_TYPES[extension].includes(normalized)) return;

  throw new AppError(API_ERROR_CODES.UNSUPPORTED_URL, "Ссылка не указывает на поддерживаемый публичный видеофайл.", 400);
}

function assertFileSizeAllowed(sizeBytes: number | undefined, context?: ExtractorContext): void {
  if (typeof sizeBytes === "number" && sizeBytes > maxFileSizeBytes(context)) {
    throw new AppError(API_ERROR_CODES.FILE_TOO_LARGE, "Файл превышает допустимый размер.", 413);
  }
}

function safeOriginalUrl(url: URL): string {
  return `${url.protocol}//${url.hostname}/`;
}

function safeBasename(url: URL, extension: string): string {
  try {
    return path.basename(decodeURIComponent(url.pathname), `.${extension}`) || "video";
  } catch {
    return path.basename(url.pathname, `.${extension}`) || "video";
  }
}

function getTitle(url: URL, extension: string): string {
  const basename = safeBasename(url, extension);
  const title = sanitizeTitle(basename, { fallback: "Public media file" });
  return title.ok ? title.value : "Public media file";
}

function getFilename(url: URL, extension: string): string {
  const basename = safeBasename(url, extension);
  const filename = sanitizeFilename(basename, { fallback: "video", maxLength: 120 });
  return `${filename.ok ? filename.value : "video"}.${extension}`;
}

async function fetchMetadata(url: URL, context?: ExtractorContext): Promise<SafeResponseMetadata> {
  try {
    const head = await safeHead(url, {
      signal: context?.signal,
      timeoutSeconds: context?.metadataTimeoutSeconds
    });

    if (!head.contentType && typeof head.contentLength !== "number") {
      return safeGetMetadata(url, {
        signal: context?.signal,
        timeoutSeconds: context?.metadataTimeoutSeconds
      });
    }

    return head;
  } catch (error) {
    if (error instanceof AppError && error.code === API_ERROR_CODES.EXTRACTION_FAILED) {
      const statusCode = typeof error.details?.statusCode === "number" ? error.details.statusCode : undefined;
      if (statusCode === 403 || statusCode === 405 || statusCode === 501) {
        return safeGetMetadata(url, {
          signal: context?.signal,
          timeoutSeconds: context?.metadataTimeoutSeconds
        });
      }
    }

    throw error;
  }
}

function buildFormat(extension: (typeof EXTENSIONS)[number], response: SafeResponseMetadata): VideoFormat {
  const filesizeBytes = getSizeBytes(response);
  return {
    id: DIRECT_MEDIA_FORMAT_ID,
    label: `${extension.toUpperCase()} source`,
    ext: extension,
    quality: "source",
    filesizeBytes,
    hasAudio: true,
    hasVideo: true
  };
}

export const genericDirectMediaExtractor: Extractor = {
  id: "generic-direct-media",
  name: "Direct public media file",

  supports(url: URL): boolean {
    return getExtension(url) !== null;
  },

  async extract(url: URL, context?: ExtractorContext): Promise<VideoMetadata> {
    const extension = getExtension(url);
    if (!extension) {
      throw new AppError(API_ERROR_CODES.UNSUPPORTED_URL, "Поддерживаются только прямые ссылки на .mp4, .webm или .mov.", 400);
    }

    const response = await fetchMetadata(url, context);
    assertAllowedContentType(extension, response.contentType);
    assertFileSizeAllowed(getSizeBytes(response), context);

    return {
      id: createHash("sha256").update(response.finalUrl.toString()).digest("hex").slice(0, 16),
      originalUrl: safeOriginalUrl(url),
      title: getTitle(response.finalUrl, extension),
      platform: "direct-media",
      formats: [buildFormat(extension, response)]
    };
  },

  async download(url: URL, formatId: string, context: DownloadContext): Promise<DownloadedSource> {
    const extension = getExtension(url);
    if (!extension || formatId !== DIRECT_MEDIA_FORMAT_ID) {
      throw new AppError(API_ERROR_CODES.UNSUPPORTED_URL, "Запрошенный формат недоступен для этой ссылки.", 400);
    }

    const metadata = await fetchMetadata(url, context);
    assertAllowedContentType(extension, metadata.contentType);
    assertFileSizeAllowed(getSizeBytes(metadata), context);

    const destinationPath = path.join(context.workDir, `source.${extension}`);
    const downloaded = await safeDownloadToFile(url, destinationPath, {
      maxBytes: maxFileSizeBytes(context),
      signal: context.signal,
      timeoutSeconds: context.downloadTimeoutSeconds,
      onProgress: context.onDownloadProgress
    });

    try {
      assertAllowedContentType(extension, downloaded.contentType);
      assertFileSizeAllowed(downloaded.sizeBytes, context);

      return {
        path: destinationPath,
        filename: getFilename(downloaded.finalUrl, extension),
        contentType: downloaded.contentType ?? MEDIA_TYPES[extension][0],
        sizeBytes: downloaded.sizeBytes
      };
    } catch (error) {
      await rm(destinationPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
};
