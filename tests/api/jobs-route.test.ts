import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMediaJobRouteHandlers,
  type MediaJobRouteContext
} from "@/app/api/jobs/[id]/handler";
import { serializeMediaJobSnapshot } from "@/lib/api/media-job-serializer";
import { API_ERROR_MESSAGES, AppError } from "@/lib/errors";
import type { MediaJobResult, MediaJobSnapshot, MediaJobStatus } from "@/lib/jobs/types";
import {
  createRateLimitKey,
  getRateLimitConfig,
  type RateLimitAllowed,
  type RateLimitBucket,
  type RateLimitRejected
} from "@/lib/security/rate-limit";
import { API_ERROR_CODES } from "@/lib/types";

const JOB_ID = "job_0123456789abcdef";
const API_URL = `http://localhost/api/jobs/${JOB_ID}`;
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const EXPIRES_AT = "2026-01-01T01:00:00.000Z";

function safeResult(): MediaJobResult {
  return {
    fileId: "file_0123456789abcdef",
    filename: "public-video.mp4",
    sizeBytes: 1_024,
    mimeType: "video/mp4",
    downloadUrl: "https://attacker.example/output.mp4",
    expiresAt: EXPIRES_AT,
    processingPreset: "original",
    media: {
      durationSeconds: 12,
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      hasVideo: true,
      hasAudio: true,
      width: 1920,
      height: 1080,
      videoCodec: "h264",
      audioCodec: "aac"
    }
  };
}

function jobSnapshot(
  status: MediaJobStatus,
  overrides: Partial<MediaJobSnapshot> = {}
): MediaJobSnapshot {
  return Object.freeze({
    jobId: JOB_ID,
    status,
    processingPreset: "original",
    createdAt: CREATED_AT,
    progress: status === "ready" ? 100 : status === "running" ? 42 : 0,
    ...(status === "running" ? { startedAt: "2026-01-01T00:00:01.000Z" } : {}),
    ...(status === "ready"
      ? { completedAt: "2026-01-01T00:10:00.000Z", expiresAt: EXPIRES_AT, result: safeResult() }
      : {}),
    ...(status === "failed"
      ? {
          completedAt: "2026-01-01T00:10:00.000Z",
          expiresAt: EXPIRES_AT,
          error: { code: API_ERROR_CODES.PROCESSING_FAILED, message: "/private/secret stderr" }
        }
      : {}),
    ...(status === "cancelled"
      ? { completedAt: "2026-01-01T00:05:00.000Z", expiresAt: EXPIRES_AT }
      : {}),
    ...overrides
  });
}

function allowed(bucket: RateLimitBucket): RateLimitAllowed {
  return {
    ok: true,
    allowed: true,
    bucket,
    key: `${bucket}:127.0.0.1`,
    limit: 120,
    remaining: 119,
    resetAt: NOW + 60_000,
    retryAfterSeconds: 0
  };
}

function rejected(bucket: RateLimitBucket): RateLimitRejected {
  return {
    ok: false,
    allowed: false,
    bucket,
    key: `${bucket}:127.0.0.1`,
    limit: 120,
    remaining: 0,
    resetAt: NOW + 60_000,
    retryAfterSeconds: 19,
    error: {
      code: API_ERROR_CODES.RATE_LIMITED,
      message: API_ERROR_MESSAGES.RATE_LIMITED,
      details: { bucket, retryAfterSeconds: 19 }
    },
    code: API_ERROR_CODES.RATE_LIMITED,
    message: API_ERROR_MESSAGES.RATE_LIMITED
  };
}

function request(method: "GET" | "DELETE"): NextRequest {
  return new NextRequest(API_URL, { method, headers: { "x-real-ip": "127.0.0.1" } });
}

function context(id = JOB_ID): MediaJobRouteContext {
  return { params: Promise.resolve({ id }) };
}

function createHarness(options: {
  get?: (jobId: string) => MediaJobSnapshot;
  cancel?: (jobId: string) => Promise<MediaJobSnapshot>;
  rateLimit?: (bucket: RateLimitBucket) => RateLimitAllowed | RateLimitRejected;
  now?: number;
} = {}) {
  const getDownloadJob = vi.fn(options.get ?? (() => jobSnapshot("queued")));
  const cancelDownloadJob = vi.fn(options.cancel ?? (async () => jobSnapshot("cancelled")));
  const serializer = vi.fn(serializeMediaJobSnapshot);
  const checkRateLimit = vi.fn((input: { bucket?: RateLimitBucket }) =>
    (options.rateLimit ?? allowed)(input.bucket ?? "default")
  );
  const handlers = createMediaJobRouteHandlers({
    getDownloadJob,
    cancelDownloadJob,
    serializeMediaJobSnapshot: serializer,
    checkRateLimit,
    now: () => options.now ?? NOW
  });
  return { handlers, getDownloadJob, cancelDownloadJob, serializer, checkRateLimit };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/jobs/[id]", () => {
  it.each([
    ["queued", jobSnapshot("queued")],
    ["running", jobSnapshot("running")],
    ["cancelled", jobSnapshot("cancelled")]
  ] as const)("returns a safe %s snapshot", async (status, snapshot) => {
    const harness = createHarness({ get: () => snapshot });
    const response = await harness.handlers.GET(request("GET"), context());
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload).toMatchObject({ ok: true, data: { jobId: JOB_ID, status } });
    expect((payload.data as Record<string, unknown>)).not.toHaveProperty("result");
    expect((payload.data as Record<string, unknown>)).not.toHaveProperty("error");
    expect(harness.getDownloadJob).toHaveBeenCalledOnce();
    expect(harness.getDownloadJob).toHaveBeenCalledWith(JOB_ID);
    expect(harness.serializer).toHaveBeenCalledOnce();
    expect(harness.serializer).toHaveBeenCalledWith(snapshot);
    expect(harness.checkRateLimit).toHaveBeenCalledWith({
      bucket: "job-status",
      headers: expect.any(Headers)
    });
  });

  it("returns only the final ready result and rebuilds its download URL", async () => {
    const snapshot = jobSnapshot("ready", {
      result: {
        ...safeResult(),
        downloadUrl: "file:///private/tmp/final.mp4",
        sourceUrl: "https://private.example/source.mp4",
        sourceFileId: "source_secret",
        partialFileId: "partial_secret",
        path: "/private/tmp/final.mp4"
      } as unknown as MediaJobResult
    });
    const harness = createHarness({ get: () => snapshot });
    const response = await harness.handlers.GET(request("GET"), context());
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      data: {
        status: "ready",
        result: {
          fileId: "file_0123456789abcdef",
          downloadUrl: "/api/file/file_0123456789abcdef",
          filename: "public-video.mp4",
          mimeType: "video/mp4",
          sizeBytes: 1_024,
          processingPreset: "original"
        }
      }
    });
    const output = JSON.stringify(payload);
    for (const secret of ["private.example", "/private/", "source_secret", "partial_secret", "file://"]) {
      expect(output).not.toContain(secret);
    }
  });

  it("returns a failed snapshot with a canonical public error", async () => {
    const harness = createHarness({ get: () => jobSnapshot("failed") });
    const response = await harness.handlers.GET(request("GET"), context());
    const payload = await json(response);
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      data: {
        status: "failed",
        error: {
          code: API_ERROR_CODES.PROCESSING_FAILED,
          message: API_ERROR_MESSAGES.PROCESSING_FAILED
        }
      }
    });
    expect(JSON.stringify(payload)).not.toContain("/private/secret");
    expect(JSON.stringify(payload)).not.toContain("stderr");
  });

  it.each([
    ["explicit expired", jobSnapshot("expired")],
    ["stale terminal", jobSnapshot("ready", { expiresAt: "2025-12-31T23:59:59.000Z" })]
  ] as const)("maps %s snapshots to JOB_NOT_FOUND", async (_name, snapshot) => {
    const harness = createHarness({ get: () => snapshot });
    const response = await harness.handlers.GET(request("GET"), context());
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      ok: false,
      error: {
        code: API_ERROR_CODES.JOB_NOT_FOUND,
        message: API_ERROR_MESSAGES.JOB_NOT_FOUND
      }
    });
    expect(harness.serializer).not.toHaveBeenCalled();
  });

  it("maps an unknown valid jobId to JOB_NOT_FOUND", async () => {
    const harness = createHarness({
      get() {
        throw new AppError(API_ERROR_CODES.JOB_NOT_FOUND, "/private/job registry");
      }
    });
    const response = await harness.handlers.GET(request("GET"), context("job_unknown"));
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      ok: false,
      error: { code: API_ERROR_CODES.JOB_NOT_FOUND, message: API_ERROR_MESSAGES.JOB_NOT_FOUND }
    });
  });

  it.each([
    "",
    "job_",
    "job_one/two",
    "job_one\\two",
    "job_../secret",
    `job_${"a".repeat(125)}`,
    "job_bad\u0000id"
  ])("rejects invalid jobId %j before reading the service", async (jobId) => {
    const harness = createHarness();
    const response = await harness.handlers.GET(request("GET"), context(jobId));
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: API_ERROR_CODES.INVALID_REQUEST }
    });
    expect(harness.getDownloadJob).not.toHaveBeenCalled();
    expect(harness.serializer).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After without reading job state", async () => {
    const harness = createHarness({ rateLimit: rejected });
    const response = await harness.handlers.GET(request("GET"), context());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("19");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: API_ERROR_CODES.RATE_LIMITED }
    });
    expect(harness.getDownloadJob).not.toHaveBeenCalled();
  });

  it("returns one immutable snapshot when state advances during GET", async () => {
    const ready = jobSnapshot("ready");
    const harness = createHarness({ get: () => ready });
    const response = await harness.handlers.GET(request("GET"), context());
    const payload = await json(response);
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, data: { status: "ready", progress: 100 } });
    expect(harness.getDownloadJob).toHaveBeenCalledOnce();
    expect(harness.serializer).toHaveBeenCalledOnce();
  });

  it("does not expose injected internal fields", async () => {
    const internal = {
      ...jobSnapshot("running"),
      sourceUrl: "https://secret.example/source",
      path: "/private/tmp/source.mp4",
      stderr: "secret stderr",
      stack: "secret stack",
      cause: { token: "secret-token" },
      controller: new AbortController(),
      handler: () => undefined,
      args: ["-map", "0:v"]
    } as unknown as MediaJobSnapshot;
    const harness = createHarness({ get: () => internal });
    const response = await harness.handlers.GET(request("GET"), context());
    const output = JSON.stringify(await json(response));
    expect(response.status).toBe(200);
    for (const secret of ["secret.example", "/private/", "stderr", "stack", "secret-token", "controller", "handler", "-map"]) {
      expect(output).not.toContain(secret);
    }
  });
});

describe("DELETE /api/jobs/[id]", () => {
  it.each([
    ["queued", jobSnapshot("cancelled")],
    ["running", jobSnapshot("cancelled", { progress: 42 })]
  ] as const)("returns the service's cancelled snapshot for a %s job", async (_state, cancelled) => {
    const harness = createHarness({ cancel: async () => cancelled });
    const response = await harness.handlers.DELETE(request("DELETE"), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await json(response)).toMatchObject({ ok: true, data: { status: "cancelled" } });
    expect(harness.cancelDownloadJob).toHaveBeenCalledOnce();
    expect(harness.cancelDownloadJob).toHaveBeenCalledWith(JOB_ID);
    expect(harness.serializer).toHaveBeenCalledWith(cancelled);
    expect(harness.checkRateLimit).toHaveBeenCalledWith({
      bucket: "job-cancel",
      headers: expect.any(Headers)
    });
  });

  it.each([
    ["ready", jobSnapshot("ready")],
    ["failed", jobSnapshot("failed")],
    ["cancelled", jobSnapshot("cancelled")]
  ] as const)("preserves terminal %s snapshots idempotently", async (status, terminal) => {
    const harness = createHarness({ cancel: async () => terminal });
    const response = await harness.handlers.DELETE(request("DELETE"), context());
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ ok: true, data: { status } });
    expect(harness.cancelDownloadJob).toHaveBeenCalledOnce();
  });

  it("handles a double DELETE through two idempotent service calls", async () => {
    const cancelled = jobSnapshot("cancelled");
    const harness = createHarness({ cancel: async () => cancelled });
    const first = await harness.handlers.DELETE(request("DELETE"), context());
    const second = await harness.handlers.DELETE(request("DELETE"), context());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await json(first)).toEqual(await json(second));
    expect(harness.cancelDownloadJob).toHaveBeenCalledTimes(2);
  });

  it("keeps cancellation authoritative when completion races", async () => {
    const cancelled = jobSnapshot("cancelled", { progress: 90, result: undefined });
    const harness = createHarness({
      cancel: async () => {
        await Promise.resolve();
        return cancelled;
      }
    });
    const response = await harness.handlers.DELETE(request("DELETE"), context());
    const payload = await json(response);
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, data: { status: "cancelled", progress: 90 } });
    expect((payload.data as Record<string, unknown>)).not.toHaveProperty("result");
    expect(harness.cancelDownloadJob).toHaveBeenCalledOnce();
  });

  it("maps unknown jobs to JOB_NOT_FOUND", async () => {
    const harness = createHarness({
      cancel: async () => { throw new AppError(API_ERROR_CODES.JOB_NOT_FOUND); }
    });
    const response = await harness.handlers.DELETE(request("DELETE"), context("job_unknown"));
    expect(response.status).toBe(404);
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: API_ERROR_CODES.JOB_NOT_FOUND }
    });
  });

  it("rejects invalid job IDs before cancellation", async () => {
    const harness = createHarness();
    const response = await harness.handlers.DELETE(request("DELETE"), context("../../secret"));
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: { code: API_ERROR_CODES.INVALID_REQUEST } });
    expect(harness.cancelDownloadJob).not.toHaveBeenCalled();
  });

  it("maps INVALID_JOB_STATE to HTTP 409 with a canonical message", async () => {
    const harness = createHarness({
      cancel: async () => {
        throw new AppError(API_ERROR_CODES.INVALID_JOB_STATE, "/private/state stack");
      }
    });
    const response = await harness.handlers.DELETE(request("DELETE"), context());
    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({
      ok: false,
      error: {
        code: API_ERROR_CODES.INVALID_JOB_STATE,
        message: API_ERROR_MESSAGES.INVALID_JOB_STATE
      }
    });
  });

  it("returns 429 without calling cancellation", async () => {
    const harness = createHarness({ rateLimit: rejected });
    const response = await harness.handlers.DELETE(request("DELETE"), context());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("19");
    expect(harness.cancelDownloadJob).not.toHaveBeenCalled();
  });

  it("sanitizes cancellation AppErrors", async () => {
    const harness = createHarness({
      cancel: async () => {
        throw new AppError(API_ERROR_CODES.JOB_CANCELLED, "https://secret.example /private/path stderr");
      }
    });
    const response = await harness.handlers.DELETE(request("DELETE"), context());
    const payload = await json(response);
    expect(response.status).toBe(409);
    expect(payload).toEqual({
      ok: false,
      error: {
        code: API_ERROR_CODES.JOB_CANCELLED,
        message: API_ERROR_MESSAGES.JOB_CANCELLED
      }
    });
    expect(JSON.stringify(payload)).not.toContain("secret.example");
    expect(JSON.stringify(payload)).not.toContain("/private/");
  });

  it("maps unknown exceptions to INTERNAL_ERROR without leaking internals", async () => {
    const harness = createHarness({
      cancel: async () => {
        const error = new Error("/private/file.mp4 stderr stack");
        (error as Error & { cause?: unknown }).cause = { token: "secret-token" };
        throw error;
      }
    });
    const response = await harness.handlers.DELETE(request("DELETE"), context());
    const payload = await json(response);
    expect(response.status).toBe(500);
    expect(payload).toEqual({
      ok: false,
      error: { code: API_ERROR_CODES.INTERNAL_ERROR, message: API_ERROR_MESSAGES.INTERNAL_ERROR }
    });
    const output = JSON.stringify(payload);
    for (const secret of ["/private/", "stderr", "stack", "secret-token", "cause"]) {
      expect(output).not.toContain(secret);
    }
  });

  it("does not expose internal fields from a successful cancellation snapshot", async () => {
    const internal = {
      ...jobSnapshot("cancelled"),
      sourceUrl: "https://secret.example/source.mp4",
      path: "/private/tmp/source.mp4",
      stderr: "secret stderr",
      stack: "secret stack",
      controller: new AbortController(),
      handler: () => undefined,
      args: ["-map", "0:v"]
    } as unknown as MediaJobSnapshot;
    const harness = createHarness({ cancel: async () => internal });
    const response = await harness.handlers.DELETE(request("DELETE"), context());
    const output = JSON.stringify(await json(response));
    expect(response.status).toBe(200);
    for (const secret of ["secret.example", "/private/", "stderr", "stack", "controller", "handler", "-map"]) {
      expect(output).not.toContain(secret);
    }
  });

  it("maps expired cancellation snapshots to JOB_NOT_FOUND", async () => {
    const harness = createHarness({ cancel: async () => jobSnapshot("expired") });
    const response = await harness.handlers.DELETE(request("DELETE"), context());
    expect(response.status).toBe(404);
    expect(await json(response)).toMatchObject({ error: { code: API_ERROR_CODES.JOB_NOT_FOUND } });
    expect(harness.serializer).not.toHaveBeenCalled();
  });

  it("does not perform network or direct file operations", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const harness = createHarness();
    const response = await harness.handlers.DELETE(request("DELETE"), context());
    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(harness.cancelDownloadJob).toHaveBeenCalledOnce();
    expect(harness.getDownloadJob).not.toHaveBeenCalled();
  });
});

describe("media job rate-limit buckets", () => {
  it("keeps status polling softer than cancellation and enqueue", () => {
    const status = getRateLimitConfig("job-status");
    const cancel = getRateLimitConfig("job-cancel");
    const download = getRateLimitConfig("download");
    if (status.maxRequests !== 0) expect(status.maxRequests).toBeGreaterThanOrEqual(120);
    if (cancel.maxRequests !== 0) expect(cancel.maxRequests).toBeLessThanOrEqual(20);
    if (status.maxRequests !== 0 && cancel.maxRequests !== 0) {
      expect(status.maxRequests).toBeGreaterThanOrEqual(cancel.maxRequests);
    }
    if (cancel.maxRequests !== 0 && download.maxRequests !== 0) {
      expect(cancel.maxRequests).toBeGreaterThanOrEqual(download.maxRequests);
    }
  });

  it("uses distinct keys for status and cancellation", () => {
    expect(createRateLimitKey({ bucket: "job-status", identifier: "client" })).toBe("job-status:client");
    expect(createRateLimitKey({ bucket: "job-cancel", identifier: "client" })).toBe("job-cancel:client");
  });
});
