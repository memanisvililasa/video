import { Readable } from "node:stream";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { createDownloadPostHandler } from "@/app/api/download/handler";
import { createFileDeliveryRouteHandler } from "@/app/api/file/[id]/handler";
import { createMediaJobRouteHandlers } from "@/app/api/jobs/[id]/handler";
import { serializeMediaJobSnapshot } from "@/lib/api/media-job-serializer";
import type { HttpObservability } from "@/lib/observability/http-observer";
import type { OperationalEvent, OperationalLogLevel } from "@/lib/observability/contract";
import type { OperationalLogFields } from "@/lib/observability/logger";
import type { RateLimitAllowed } from "@/lib/security/rate-limit";

const JOB_ID = "job_0123456789abcdef";
const allowed: RateLimitAllowed = Object.freeze({
  ok: true,
  allowed: true,
  bucket: "download",
  key: "download:test",
  limit: 10,
  remaining: 9,
  resetAt: 1,
  retryAfterSeconds: 0
});

function observerHarness() {
  const events: Array<{ level: OperationalLogLevel; event: OperationalEvent; fields?: OperationalLogFields }> = [];
  const routes: string[] = [];
  const observability: HttpObservability = Object.freeze({
    async run(_request, route, _method, operation) {
      routes.push(route);
      return operation(Object.freeze({
        requestId: "a".repeat(32),
        log(level, event, fields) { events.push({ level, event, fields }); },
        withPublicJobId<T>(_publicJobId: string, nested: () => T): T { return nested(); }
      }));
    }
  });
  return { observability, events, routes };
}

describe("base API operational events", () => {
  it("logs POST accepted/rejected outcomes without source payload", async () => {
    const observed = observerHarness();
    const handler = createDownloadPostHandler({
      observability: observed.observability,
      checkRateLimit: () => allowed,
      enqueueDownloadJob: (body) => ({
        jobId: JOB_ID,
        snapshot: {
          jobId: JOB_ID,
          status: "queued",
          progress: 0,
          processingPreset: body.processingPreset,
          createdAt: "2026-07-15T00:00:00.000Z"
        }
      })
    });
    const validBody = {
      url: "https://private.example/video.mp4?token=secret",
      formatId: "direct-source",
      processingPreset: "original",
      rightsConfirmed: true
    };
    const accepted = await handler(new NextRequest("http://localhost/api/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody)
    }));
    expect(accepted.status).toBe(202);
    expect(observed.events).toContainEqual(expect.objectContaining({ event: "job.submit.accepted" }));
    expect(JSON.stringify(observed.events)).not.toContain("private.example");
    expect(JSON.stringify(observed.events)).not.toContain("token=secret");

    const rejected = await handler(new NextRequest("http://localhost/api/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }));
    expect(rejected.status).toBe(403);
    expect(observed.events).toContainEqual(expect.objectContaining({ event: "job.submit.rejected" }));
    expect(observed.routes).toEqual(["job_submit", "job_submit"]);
  });

  it("uses debug policy for status and an info cancellation request event", async () => {
    const observed = observerHarness();
    const snapshot = Object.freeze({
      jobId: JOB_ID,
      status: "queued" as const,
      progress: 0,
      processingPreset: "original" as const,
      createdAt: "2026-07-15T00:00:00.000Z"
    });
    const handlers = createMediaJobRouteHandlers({
      observability: observed.observability,
      getDownloadJob: () => snapshot,
      cancelDownloadJob: async () => ({ ...snapshot, status: "cancelled" as const, completedAt: "2026-07-15T00:01:00.000Z", expiresAt: "2026-07-15T01:00:00.000Z" }),
      serializeMediaJobSnapshot,
      checkRateLimit: () => allowed
    });
    await handlers.GET(new NextRequest(`http://localhost/api/jobs/${JOB_ID}`), { params: Promise.resolve({ id: JOB_ID }) });
    await handlers.DELETE(new NextRequest(`http://localhost/api/jobs/${JOB_ID}`, { method: "DELETE" }), { params: Promise.resolve({ id: JOB_ID }) });
    expect(observed.events).toContainEqual(expect.objectContaining({ level: "debug", event: "job.status.read" }));
    expect(observed.events).toContainEqual(expect.objectContaining({ level: "info", event: "job.cancel.requested" }));
  });

  it("logs file accepted/rejected without filename or storage path", async () => {
    const observed = observerHarness();
    const getFile = vi.fn(async () => ({
      fileId: "file_0123456789",
      filename: "private-name.mp4",
      contentType: "video/mp4",
      sizeBytes: 4,
      expiresAt: "2026-07-15T01:00:00.000Z",
      stream: Readable.from(Buffer.from("test")),
      async close() {}
    }));
    const handler = createFileDeliveryRouteHandler({
      observability: observed.observability,
      getFile,
      checkRateLimit: () => allowed
    });
    const response = await handler(
      new NextRequest("http://localhost/api/file/file_0123456789"),
      { params: Promise.resolve({ id: "file_0123456789" }) }
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(observed.events).toContainEqual(expect.objectContaining({ event: "job.file.requested" }));
    expect(JSON.stringify(observed.events)).not.toContain("private-name.mp4");

    const rejected = await handler(
      new NextRequest("http://localhost/api/file/bad"),
      { params: Promise.resolve({ id: "bad" }) }
    );
    expect(rejected.status).toBe(400);
    expect(observed.events).toContainEqual(expect.objectContaining({ event: "job.file.rejected" }));
  });

  it("delivers a Unicode #shorts filename through an ASCII-safe Content-Disposition", async () => {
    const filename = "Синтетический YouTube #shorts.mp4";
    const handler = createFileDeliveryRouteHandler({
      getFile: async () => ({
        fileId: "file_0123456789",
        filename,
        contentType: "video/mp4",
        sizeBytes: 4,
        expiresAt: "2026-07-15T01:00:00.000Z",
        stream: Readable.from(Buffer.from("test")),
        async close() {}
      }),
      checkRateLimit: () => allowed
    });

    const response = await handler(
      new NextRequest("http://localhost/api/file/file_0123456789"),
      { params: Promise.resolve({ id: "file_0123456789" }) }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe("4");
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    expect(disposition).toContain("#shorts.mp4");
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1] ?? "")).toBe(filename);
    expect(await response.text()).toBe("test");
  });
});
