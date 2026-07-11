import { NextRequest, NextResponse } from "next/server";
import type {
  ApiFailure,
  ApiSuccess,
  CreateDownloadJobData,
  CreateDownloadJobRequest
} from "@/lib/api/media-job-dto";
import { serializeCreateDownloadJobData } from "@/lib/api/media-job-serializer";
import { parseCreateDownloadJobRequest } from "@/lib/api/media-job-validation";
import { API_ERROR_MESSAGES, API_ERROR_STATUS, AppError } from "@/lib/errors";
import type { EnqueuedMediaJob } from "@/lib/jobs/types";
import type { RateLimitKeyInput, RateLimitResult } from "@/lib/security/rate-limit";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";

const MAX_BODY_BYTES = 8 * 1024;
const NO_STORE_HEADERS = Object.freeze({ "Cache-Control": "no-store" });

export type DownloadPostDependencies = Readonly<{
  enqueueDownloadJob: (request: CreateDownloadJobRequest) => EnqueuedMediaJob;
  checkRateLimit: (input: RateLimitKeyInput) => RateLimitResult;
}>;

function invalidRequest(): AppError {
  return new AppError(API_ERROR_CODES.INVALID_REQUEST);
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function assertBoundedContentLength(value: string | null): void {
  if (value === null) return;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) throw invalidRequest();
  const contentLength = Number(normalized);
  if (!Number.isSafeInteger(contentLength) || contentLength > MAX_BODY_BYTES) throw invalidRequest();
}

async function readBoundedBody(request: NextRequest): Promise<Uint8Array> {
  const body = request.body;
  if (!body) throw invalidRequest();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw invalidRequest();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) throw invalidRequest();
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function parseRequestBody(request: NextRequest): Promise<CreateDownloadJobRequest> {
  if (!isJsonContentType(request.headers.get("content-type"))) throw invalidRequest();
  assertBoundedContentLength(request.headers.get("content-length"));

  const bytes = await readBoundedBody(request);
  let value: unknown;
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(raw) as unknown;
  } catch {
    throw invalidRequest();
  }

  return parseCreateDownloadJobRequest(value);
}

function safeFailure(code: ApiErrorCode): ApiFailure {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message: API_ERROR_MESSAGES[code] })
  });
}

function errorResponse(error: unknown, headers?: HeadersInit): NextResponse<ApiFailure> {
  const code = error instanceof AppError ? error.code : API_ERROR_CODES.INTERNAL_ERROR;
  const responseHeaders = new Headers(NO_STORE_HEADERS);
  if (headers) {
    new Headers(headers).forEach((value, key) => responseHeaders.set(key, value));
  }
  return NextResponse.json(safeFailure(code), {
    status: API_ERROR_STATUS[code],
    headers: responseHeaders
  });
}

export function createDownloadPostHandler(dependencies: DownloadPostDependencies) {
  return async function POST(request: NextRequest): Promise<NextResponse> {
    try {
      const rateLimit = dependencies.checkRateLimit({ bucket: "download", headers: request.headers });
      if (!rateLimit.ok) {
        return errorResponse(new AppError(API_ERROR_CODES.RATE_LIMITED), {
          "Retry-After": String(rateLimit.retryAfterSeconds)
        });
      }

      const body = await parseRequestBody(request);
      const enqueued = dependencies.enqueueDownloadJob(body);
      const data = serializeCreateDownloadJobData(enqueued.snapshot);
      const response: ApiSuccess<CreateDownloadJobData> = Object.freeze({ ok: true, data });

      return NextResponse.json(response, {
        status: 202,
        headers: NO_STORE_HEADERS
      });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
