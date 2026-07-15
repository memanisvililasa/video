import { NextRequest, NextResponse } from "next/server";
import type { ApiFailure, ApiSuccess, MediaJobApiSnapshot } from "@/lib/api/media-job-dto";
import { parseJobId } from "@/lib/api/media-job-validation";
import { API_ERROR_MESSAGES, API_ERROR_STATUS, AppError } from "@/lib/errors";
import type { MediaJobSnapshot } from "@/lib/jobs/types";
import type { RateLimitKeyInput, RateLimitResult } from "@/lib/security/rate-limit";
import {
  NOOP_HTTP_OBSERVABILITY,
  type HttpObservability
} from "@/lib/observability/http-observer";
import { safeReasonFromError } from "@/lib/observability/logger";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";

const NO_STORE_HEADERS = Object.freeze({ "Cache-Control": "no-store" });
const TERMINAL_STATUSES = new Set<MediaJobSnapshot["status"]>(["ready", "failed", "cancelled"]);

export type MediaJobRouteContext = Readonly<{
  params: Promise<{ id: string }>;
}>;

export type MediaJobRouteDependencies = Readonly<{
  getDownloadJob: (jobId: string) => MediaJobSnapshot | Promise<MediaJobSnapshot>;
  cancelDownloadJob: (jobId: string) => Promise<MediaJobSnapshot>;
  serializeMediaJobSnapshot: (snapshot: MediaJobSnapshot) => MediaJobApiSnapshot;
  checkRateLimit: (input: RateLimitKeyInput) => RateLimitResult;
  observability?: HttpObservability;
  now?: () => number;
}>;

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

function successResponse(data: MediaJobApiSnapshot): NextResponse<ApiSuccess<MediaJobApiSnapshot>> {
  const response: ApiSuccess<MediaJobApiSnapshot> = Object.freeze({ ok: true, data });
  return NextResponse.json(response, { status: 200, headers: NO_STORE_HEADERS });
}

function rateLimitResponse(result: Extract<RateLimitResult, { ok: false }>): NextResponse<ApiFailure> {
  return errorResponse(new AppError(API_ERROR_CODES.RATE_LIMITED), {
    "Retry-After": String(result.retryAfterSeconds)
  });
}

function assertJobIsAvailable(snapshot: MediaJobSnapshot, nowMs: number): void {
  if (snapshot.status === "expired") throw new AppError(API_ERROR_CODES.JOB_NOT_FOUND);
  if (!TERMINAL_STATUSES.has(snapshot.status) || typeof snapshot.expiresAt !== "string") return;
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs) {
    throw new AppError(API_ERROR_CODES.JOB_NOT_FOUND);
  }
}

async function getJobId(context: MediaJobRouteContext): Promise<string> {
  const { id } = await context.params;
  return parseJobId(id);
}

export function createMediaJobRouteHandlers(dependencies: MediaJobRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const observability = dependencies.observability ?? NOOP_HTTP_OBSERVABILITY;

  async function GET(request: NextRequest, context: MediaJobRouteContext): Promise<NextResponse> {
    return observability.run(request, "job_status", "GET", async (observation) => {
      try {
        const rateLimit = dependencies.checkRateLimit({ bucket: "job-status", headers: request.headers });
        if (!rateLimit.ok) return rateLimitResponse(rateLimit);

        const jobId = await getJobId(context);
        const snapshot = await dependencies.getDownloadJob(jobId);
        assertJobIsAvailable(snapshot, now());
        observation.withPublicJobId(jobId, () => {
          observation.log("debug", "job.status.read", {
            outcome: "success",
            reasonCode: "none"
          });
        });
        return successResponse(dependencies.serializeMediaJobSnapshot(snapshot));
      } catch (error) {
        const classified = safeReasonFromError(error);
        observation.log("debug", "job.status.read", {
          outcome: classified.errorCategory === "internal" ? "failure" : "rejected",
          reasonCode: classified.reasonCode,
          errorCategory: classified.errorCategory
        });
        return errorResponse(error);
      }
    });
  }

  async function DELETE(request: NextRequest, context: MediaJobRouteContext): Promise<NextResponse> {
    return observability.run(request, "job_cancel", "DELETE", async (observation) => {
      try {
        const rateLimit = dependencies.checkRateLimit({ bucket: "job-cancel", headers: request.headers });
        if (!rateLimit.ok) return rateLimitResponse(rateLimit);

        const jobId = await getJobId(context);
        const snapshot = await dependencies.cancelDownloadJob(jobId);
        assertJobIsAvailable(snapshot, now());
        observation.withPublicJobId(jobId, () => {
          observation.log("info", "job.cancel.requested", {
            outcome: "success",
            reasonCode: "none"
          });
        });
        return successResponse(dependencies.serializeMediaJobSnapshot(snapshot));
      } catch (error) {
        const classified = safeReasonFromError(error);
        observation.log(classified.errorCategory === "internal" ? "warn" : "info", "job.cancel.requested", {
          outcome: classified.errorCategory === "internal" ? "failure" : "rejected",
          reasonCode: classified.reasonCode,
          errorCategory: classified.errorCategory
        });
        return errorResponse(error);
      }
    });
  }

  return Object.freeze({ GET, DELETE });
}
