import { NextRequest, NextResponse } from "next/server";
import { API_ERROR_CODES, API_ERROR_STATUS, createApiErrorResponse, createApiSuccessResponse, getApiErrorStatus, toApiErrorResponse } from "@/lib/errors";
import { requireExtractor } from "@/lib/extractors/registry";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { validateVideoUrl } from "@/lib/security/url-validation";
import type { ApiErrorCode, ExtractRequest, ExtractResponse } from "@/lib/types";

const MAX_BODY_BYTES = 8 * 1024;
const EXTRACT_BODY_KEYS = ["url"] as const;

type BodyResult = { ok: true; body: ExtractRequest } | { ok: false; response: NextResponse };

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

function validateExtractBody(value: unknown): BodyResult {
  if (!isRecord(value) || !hasExactKeys(value, EXTRACT_BODY_KEYS)) {
    return { ok: false, response: errorResponse(API_ERROR_CODES.INVALID_URL, "Ожидается JSON-объект вида { url: string }.") };
  }

  if (typeof value.url !== "string") {
    return { ok: false, response: errorResponse(API_ERROR_CODES.INVALID_URL, "Поле url должно быть строкой.") };
  }

  return { ok: true, body: { url: value.url } };
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
    return validateExtractBody(JSON.parse(raw) as unknown);
  } catch {
    return { ok: false, response: errorResponse(API_ERROR_CODES.INVALID_URL, "JSON-тело запроса должно быть корректным объектом.") };
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

    const extractor = requireExtractor(validation.url);
    const metadata = await extractor.extract(validation.url);

    const response: ExtractResponse = createApiSuccessResponse(metadata);
    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    return NextResponse.json(toApiErrorResponse(error), { status: getApiErrorStatus(error) });
  }
}
