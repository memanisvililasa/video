import { NextRequest, NextResponse } from "next/server";
import { API_ERROR_CODES, API_ERROR_STATUS, createApiErrorResponse, createApiSuccessResponse, getApiErrorStatus, toApiErrorResponse } from "@/lib/errors";
import { prepareDownload } from "@/lib/jobs/download-service";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { validateVideoUrl } from "@/lib/security/url-validation";
import type { ApiErrorCode, DownloadRequest, DownloadResponse } from "@/lib/types";

const MAX_BODY_BYTES = 8 * 1024;
const DOWNLOAD_BODY_KEYS = ["url", "formatId"] as const;

type BodyResult = { ok: true; body: DownloadRequest } | { ok: false; response: NextResponse };

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

function errorResponse(code: ApiErrorCode, message?: string, status = API_ERROR_STATUS[code]) {
  return NextResponse.json(createApiErrorResponse(code, message), { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const receivedKeys = Object.keys(value);
  return receivedKeys.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validateDownloadBody(value: unknown): BodyResult {
  if (!isRecord(value) || !hasExactKeys(value, DOWNLOAD_BODY_KEYS)) {
    return { ok: false, response: errorResponse(API_ERROR_CODES.INVALID_URL, "Ожидается JSON-объект вида { url: string; formatId: string }.") };
  }

  if (typeof value.url !== "string") {
    return { ok: false, response: errorResponse(API_ERROR_CODES.INVALID_URL, "Поле url должно быть строкой.") };
  }

  if (typeof value.formatId !== "string") {
    return { ok: false, response: errorResponse(API_ERROR_CODES.INVALID_URL, "Поле formatId должно быть строкой.") };
  }

  return { ok: true, body: { url: value.url, formatId: value.formatId } };
}

async function readJsonBody(request: NextRequest): Promise<BodyResult> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return { ok: false, response: errorResponse(API_ERROR_CODES.INVALID_URL, "Ожидается JSON-тело запроса.") };
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return { ok: false, response: errorResponse(API_ERROR_CODES.FILE_TOO_LARGE, "Тело запроса слишком большое.", 413) };
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return { ok: false, response: errorResponse(API_ERROR_CODES.FILE_TOO_LARGE, "Тело запроса слишком большое.", 413) };
  }

  try {
    return validateDownloadBody(JSON.parse(raw) as unknown);
  } catch {
    return { ok: false, response: errorResponse(API_ERROR_CODES.INVALID_URL, "JSON-тело запроса должно быть корректным объектом.") };
  }
}

function validateFormatId(value: unknown) {
  if (typeof value !== "string") return { ok: false as const, message: "Укажите formatId." };
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    return { ok: false as const, message: "Укажите корректный formatId." };
  }
  return { ok: true as const, value: trimmed };
}

export async function POST(request: NextRequest) {
  try {
    const rateLimit = checkRateLimit({ bucket: "download", headers: request.headers });
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

    const formatIdResult = validateFormatId(bodyResult.body.formatId);
    if (!formatIdResult.ok) {
      return errorResponse(API_ERROR_CODES.INVALID_URL, formatIdResult.message);
    }

    const prepared = await prepareDownload({
      url: bodyResult.body.url,
      formatId: formatIdResult.value
    });
    const response: DownloadResponse = createApiSuccessResponse(prepared);

    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    return NextResponse.json(toApiErrorResponse(error), { status: getApiErrorStatus(error) });
  }
}
