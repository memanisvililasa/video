import { NextRequest, NextResponse } from "next/server";
import { API_ERROR_CODES, API_ERROR_STATUS, createApiErrorResponse, createApiSuccessResponse } from "@/lib/errors";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { validateVideoUrl } from "@/lib/security/url-validation";
import type { ExtractRequest, ExtractResponse, VideoMetadata } from "@/lib/types";

const MAX_BODY_BYTES = 8 * 1024;
const EXTRACT_BODY_KEYS = ["url"] as const;

type BodyResult = { ok: true; body: ExtractRequest } | { ok: false; response: NextResponse };

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

function errorResponse(code: keyof typeof API_ERROR_CODES, message?: string, status = API_ERROR_STATUS[code]) {
  return NextResponse.json(createApiErrorResponse(API_ERROR_CODES[code], message), { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const receivedKeys = Object.keys(value);
  return receivedKeys.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validateExtractBody(value: unknown): BodyResult {
  if (!isRecord(value) || !hasExactKeys(value, EXTRACT_BODY_KEYS)) {
    return { ok: false, response: errorResponse("INVALID_URL", "Ожидается JSON-объект вида { url: string }.") };
  }

  if (typeof value.url !== "string") {
    return { ok: false, response: errorResponse("INVALID_URL", "Поле url должно быть строкой.") };
  }

  return { ok: true, body: { url: value.url } };
}

function safeStubOriginalUrl(url: URL): string {
  return url.origin;
}

async function readJsonBody(request: NextRequest): Promise<BodyResult> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return { ok: false, response: errorResponse("INVALID_URL", "Ожидается JSON-тело запроса.") };
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return { ok: false, response: errorResponse("FILE_TOO_LARGE", "Тело запроса слишком большое.", 413) };
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return { ok: false, response: errorResponse("FILE_TOO_LARGE", "Тело запроса слишком большое.", 413) };
  }

  try {
    return validateExtractBody(JSON.parse(raw) as unknown);
  } catch {
    return { ok: false, response: errorResponse("INVALID_URL", "JSON-тело запроса должно быть корректным объектом.") };
  }
}

export async function POST(request: NextRequest) {
  try {
    const rateLimit = checkRateLimit({ bucket: "extract", headers: request.headers });
    if (!rateLimit.ok) {
      return NextResponse.json(createApiErrorResponse(rateLimit.code, rateLimit.message, rateLimit.error.details), {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.retryAfterSeconds)
        }
      });
    }

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) return bodyResult.response;

    const validation = validateVideoUrl(bodyResult.body.url);
    if (!validation.ok) {
      return errorResponse(validation.code, validation.message);
    }

    // Real extractor layer will be connected in Stage 4.
    const metadata: VideoMetadata = {
      id: "stub-video",
      originalUrl: safeStubOriginalUrl(validation.url),
      title: "Публичное видео",
      platform: "stub",
      durationSeconds: 60,
      thumbnail: undefined,
      formats: [
        {
          id: "mp4-720p",
          label: "720p MP4",
          ext: "mp4",
          quality: "720p",
          width: 1280,
          height: 720,
          hasAudio: true,
          hasVideo: true
        },
        {
          id: "mp4-1080p",
          label: "1080p MP4",
          ext: "mp4",
          quality: "1080p",
          width: 1920,
          height: 1080,
          hasAudio: true,
          hasVideo: true
        }
      ]
    };

    const response: ExtractResponse = createApiSuccessResponse(metadata);
    return NextResponse.json(response, { status: 200 });
  } catch {
    return errorResponse("INTERNAL_ERROR");
  }
}
