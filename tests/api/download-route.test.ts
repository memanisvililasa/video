import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDownloadPostHandler } from "@/app/api/download/handler";
import {
  PROCESSING_PRESETS,
  type CreateDownloadJobRequest,
  type ProcessingPreset
} from "@/lib/api/media-job-dto";
import { API_ERROR_MESSAGES, AppError } from "@/lib/errors";
import type { EnqueuedMediaJob, MediaJobSnapshot } from "@/lib/jobs/types";
import type { RateLimitAllowed, RateLimitRejected } from "@/lib/security/rate-limit";
import { API_ERROR_CODES } from "@/lib/types";

const API_URL = "http://localhost/api/download";
const CREATED_AT = "2026-01-01T00:00:00.000Z";

const RATE_LIMIT_ALLOWED: RateLimitAllowed = {
  ok: true,
  allowed: true,
  bucket: "download",
  key: "download:127.0.0.1",
  limit: 10,
  remaining: 9,
  resetAt: Date.UTC(2026, 0, 1, 0, 1),
  retryAfterSeconds: 0
};

const RATE_LIMIT_REJECTED: RateLimitRejected = {
  ok: false,
  allowed: false,
  bucket: "download",
  key: "download:127.0.0.1",
  limit: 10,
  remaining: 0,
  resetAt: Date.UTC(2026, 0, 1, 0, 1),
  retryAfterSeconds: 17,
  error: {
    code: API_ERROR_CODES.RATE_LIMITED,
    message: API_ERROR_MESSAGES.RATE_LIMITED,
    details: { bucket: "download", retryAfterSeconds: 17 }
  },
  code: API_ERROR_CODES.RATE_LIMITED,
  message: API_ERROR_MESSAGES.RATE_LIMITED
};

function validBody(processingPreset: ProcessingPreset = "original"): CreateDownloadJobRequest {
  return {
    url: "https://public.example/video.mp4",
    formatId: "direct-source",
    processingPreset,
    rightsConfirmed: true
  };
}

function queuedJob(processingPreset: ProcessingPreset = "original"): EnqueuedMediaJob {
  const snapshot: MediaJobSnapshot = Object.freeze({
    jobId: "job_0123456789abcdef",
    status: "queued",
    processingPreset,
    createdAt: CREATED_AT,
    progress: 0
  });
  return Object.freeze({ jobId: snapshot.jobId, snapshot });
}

function jsonRequest(
  body: unknown,
  options: { contentType?: string | null; contentLength?: string; raw?: string | Uint8Array } = {}
): NextRequest {
  const headers = new Headers();
  const contentType = options.contentType === undefined ? "application/json" : options.contentType;
  if (contentType !== null) headers.set("Content-Type", contentType);
  if (options.contentLength !== undefined) headers.set("Content-Length", options.contentLength);
  const raw = options.raw ?? JSON.stringify(body);
  return new NextRequest(API_URL, { method: "POST", headers, body: raw });
}

function createHarness(options: {
  rateLimit?: RateLimitAllowed | RateLimitRejected;
  enqueue?: (request: CreateDownloadJobRequest) => EnqueuedMediaJob;
} = {}) {
  const checkRateLimit = vi.fn(() => options.rateLimit ?? RATE_LIMIT_ALLOWED);
  const enqueueDownloadJob = vi.fn(options.enqueue ?? ((request) => queuedJob(request.processingPreset)));
  const handler = createDownloadPostHandler({ checkRateLimit, enqueueDownloadJob });
  return { handler, checkRateLimit, enqueueDownloadJob };
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/download async contract", () => {
  it.each(PROCESSING_PRESETS)("enqueues %s and returns a safe queued response with HTTP 202", async (preset) => {
    const harness = createHarness();
    const response = await harness.handler(jsonRequest(validBody(preset)));
    const payload = await responseJson(response);

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload).toEqual({
      ok: true,
      data: {
        jobId: "job_0123456789abcdef",
        status: "queued",
        progress: 0,
        processingPreset: preset,
        createdAt: CREATED_AT,
        expiresAt: null,
        statusUrl: "/api/jobs/job_0123456789abcdef",
        cancelUrl: "/api/jobs/job_0123456789abcdef"
      }
    });
    expect(harness.enqueueDownloadJob).toHaveBeenCalledTimes(1);
    expect(harness.enqueueDownloadJob).toHaveBeenCalledWith(validBody(preset));
    expect(harness.checkRateLimit).toHaveBeenCalledWith({
      bucket: "download",
      headers: expect.any(Headers)
    });
  });

  it("accepts application/json with a charset parameter", async () => {
    const harness = createHarness();
    const response = await harness.handler(jsonRequest(validBody(), {
      contentType: "application/json; charset=utf-8"
    }));
    expect(response.status).toBe(202);
    expect(harness.enqueueDownloadJob).toHaveBeenCalledTimes(1);
  });

  it("does not wait for unrelated asynchronous job completion", async () => {
    let jobCompleted = false;
    const neverCompletes = new Promise<void>(() => undefined);
    const harness = createHarness({
      enqueue(request) {
        void neverCompletes.then(() => { jobCompleted = true; });
        return queuedJob(request.processingPreset);
      }
    });

    const response = await harness.handler(jsonRequest(validBody("compatible-mp4")));
    expect(response.status).toBe(202);
    expect(jobCompleted).toBe(false);
  });

  it("does not expose source or internal queue fields", async () => {
    const harness = createHarness({
      enqueue() {
        const internal = {
          ...queuedJob().snapshot,
          sourceUrl: "https://private.example/source.mp4",
          path: "/private/tmp/source.mp4",
          sourceFileId: "source_secret",
          partialFileId: "partial_secret",
          stderr: "secret stderr",
          stack: "secret stack",
          args: ["-map", "0:v"],
          controller: new AbortController(),
          handler: () => undefined,
          registry: { path: "/private/registry" }
        } as unknown as MediaJobSnapshot;
        return { jobId: internal.jobId, snapshot: internal };
      }
    });

    const response = await harness.handler(jsonRequest(validBody()));
    const payload = JSON.stringify(await responseJson(response));
    expect(response.status).toBe(202);
    for (const secret of [
      "private.example",
      "/private/",
      "source_secret",
      "partial_secret",
      "stderr",
      "stack",
      "-map",
      "controller",
      "handler",
      "registry"
    ]) {
      expect(payload).not.toContain(secret);
    }
  });
});

describe("POST /api/download request validation", () => {
  it.each([
    ["missing Content-Type", jsonRequest(validBody(), {
      contentType: null,
      raw: new TextEncoder().encode(JSON.stringify(validBody()))
    })],
    ["text/plain", jsonRequest(validBody(), { contentType: "text/plain" })],
    ["form-urlencoded", jsonRequest(validBody(), { contentType: "application/x-www-form-urlencoded" })],
    ["multipart", jsonRequest(validBody(), { contentType: "multipart/form-data; boundary=x" })],
    ["JSON suffix", jsonRequest(validBody(), { contentType: "application/problem+json" })]
  ])("rejects %s", async (_name, request) => {
    const harness = createHarness();
    const response = await harness.handler(request);
    expect(response.status).toBe(400);
    expect(await responseJson(response)).toEqual({
      ok: false,
      error: {
        code: API_ERROR_CODES.INVALID_REQUEST,
        message: API_ERROR_MESSAGES.INVALID_REQUEST
      }
    });
    expect(harness.enqueueDownloadJob).not.toHaveBeenCalled();
  });

  it.each([
    ["empty body", ""],
    ["malformed JSON", "{"],
    ["null", "null"],
    ["array", "[]"],
    ["primitive", "42"]
  ])("rejects %s as INVALID_REQUEST", async (_name, raw) => {
    const harness = createHarness();
    const response = await harness.handler(jsonRequest(null, { raw }));
    expect(response.status).toBe(400);
    expect(await responseJson(response)).toMatchObject({
      ok: false,
      error: { code: API_ERROR_CODES.INVALID_REQUEST }
    });
    expect(harness.enqueueDownloadJob).not.toHaveBeenCalled();
  });

  it.each([
    ["missing URL", (() => { const body = { ...validBody() } as Record<string, unknown>; delete body.url; return body; })(), API_ERROR_CODES.INVALID_REQUEST, 400],
    ["empty URL", { ...validBody(), url: " " }, API_ERROR_CODES.INVALID_REQUEST, 400],
    ["missing format", (() => { const body = { ...validBody() } as Record<string, unknown>; delete body.formatId; return body; })(), API_ERROR_CODES.INVALID_FORMAT, 422],
    ["invalid format", { ...validBody(), formatId: "../../secret" }, API_ERROR_CODES.INVALID_FORMAT, 422],
    ["missing rights", (() => { const body = { ...validBody() } as Record<string, unknown>; delete body.rightsConfirmed; return body; })(), API_ERROR_CODES.RIGHTS_NOT_CONFIRMED, 403],
    ["false rights", { ...validBody(), rightsConfirmed: false }, API_ERROR_CODES.RIGHTS_NOT_CONFIRMED, 403],
    ["invalid preset", { ...validBody(), processingPreset: "enhance-4k" }, API_ERROR_CODES.UNSUPPORTED_PRESET, 422],
    ["unexpected field", { ...validBody(), outputPath: "/private/output.mp4" }, API_ERROR_CODES.INVALID_REQUEST, 400]
  ] as const)("rejects %s with %s", async (_name, body, code, status) => {
    const harness = createHarness();
    const response = await harness.handler(jsonRequest(body));
    expect(response.status).toBe(status);
    expect(await responseJson(response)).toEqual({
      ok: false,
      error: { code, message: API_ERROR_MESSAGES[code] }
    });
    expect(harness.enqueueDownloadJob).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized body without reading or enqueueing", async () => {
    const harness = createHarness();
    const response = await harness.handler(jsonRequest(validBody(), { contentLength: "8193" }));
    expect(response.status).toBe(400);
    expect(await responseJson(response)).toMatchObject({
      error: { code: API_ERROR_CODES.INVALID_REQUEST }
    });
    expect(harness.enqueueDownloadJob).not.toHaveBeenCalled();
  });

  it("rejects an actually oversized streamed body even with a smaller Content-Length", async () => {
    const harness = createHarness();
    const response = await harness.handler(jsonRequest(null, {
      contentLength: "1",
      raw: JSON.stringify({ ...validBody(), padding: "a".repeat(9_000) })
    }));
    expect(response.status).toBe(400);
    expect(await responseJson(response)).toMatchObject({
      error: { code: API_ERROR_CODES.INVALID_REQUEST }
    });
    expect(harness.enqueueDownloadJob).not.toHaveBeenCalled();
  });
});

describe("POST /api/download operational errors", () => {
  it("returns 429 with Retry-After and never enqueues when rate limited", async () => {
    const harness = createHarness({ rateLimit: RATE_LIMIT_REJECTED });
    const response = await harness.handler(jsonRequest(validBody()));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await responseJson(response)).toEqual({
      ok: false,
      error: {
        code: API_ERROR_CODES.RATE_LIMITED,
        message: API_ERROR_MESSAGES.RATE_LIMITED
      }
    });
    expect(harness.enqueueDownloadJob).not.toHaveBeenCalled();
  });

  it("maps QUEUE_FULL to a safe HTTP 503 response", async () => {
    const harness = createHarness({
      enqueue() {
        throw new AppError(API_ERROR_CODES.QUEUE_FULL, "/private/queue config");
      }
    });
    const response = await harness.handler(jsonRequest(validBody()));
    expect(response.status).toBe(503);
    expect(await responseJson(response)).toEqual({
      ok: false,
      error: {
        code: API_ERROR_CODES.QUEUE_FULL,
        message: API_ERROR_MESSAGES.QUEUE_FULL
      }
    });
  });

  it("uses canonical messages for known orchestration AppErrors", async () => {
    const harness = createHarness({
      enqueue() {
        throw new AppError(API_ERROR_CODES.FFMPEG_NOT_AVAILABLE, "ffmpeg /private/bin stack");
      }
    });
    const response = await harness.handler(jsonRequest(validBody()));
    const payload = await responseJson(response);
    expect(response.status).toBe(503);
    expect(payload).toEqual({
      ok: false,
      error: {
        code: API_ERROR_CODES.FFMPEG_NOT_AVAILABLE,
        message: API_ERROR_MESSAGES.FFMPEG_NOT_AVAILABLE
      }
    });
    expect(JSON.stringify(payload)).not.toContain("/private/bin");
  });

  it("maps unknown exceptions to INTERNAL_ERROR without leaking internals", async () => {
    const harness = createHarness({
      enqueue() {
        const error = new Error("https://secret.example /private/output.mp4 stderr -map 0:v");
        (error as Error & { cause?: unknown }).cause = { token: "secret-token" };
        throw error;
      }
    });
    const response = await harness.handler(jsonRequest(validBody()));
    const payload = await responseJson(response);
    expect(response.status).toBe(500);
    expect(payload).toEqual({
      ok: false,
      error: {
        code: API_ERROR_CODES.INTERNAL_ERROR,
        message: API_ERROR_MESSAGES.INTERNAL_ERROR
      }
    });
    const json = JSON.stringify(payload);
    for (const secret of ["secret.example", "/private/", "stderr", "-map", "secret-token", "stack", "cause"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("does not perform network requests from the route handler", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const harness = createHarness();
    const response = await harness.handler(jsonRequest(validBody()));
    expect(response.status).toBe(202);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
