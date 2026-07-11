import { describe, expect, it } from "vitest";
import {
  serializeCreateDownloadJobData,
  serializeMediaJobSnapshot
} from "@/lib/api/media-job-serializer";
import { API_ERROR_MESSAGES } from "@/lib/errors";
import type { MediaJobResult, MediaJobSnapshot } from "@/lib/jobs/types";
import { API_ERROR_CODES } from "@/lib/types";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

function safeResult(): MediaJobResult {
  return {
    fileId: "file_0123456789abcdef",
    filename: "public-video.mp4",
    sizeBytes: 1_024,
    mimeType: "video/mp4",
    downloadUrl: "https://attacker.example/secret",
    expiresAt: "2026-01-01T01:00:00Z",
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

function snapshot(
  status: MediaJobSnapshot["status"],
  overrides: Partial<MediaJobSnapshot> = {}
): MediaJobSnapshot {
  return {
    jobId: "job_0123456789abcdef",
    status,
    processingPreset: "original",
    createdAt: CREATED_AT,
    progress: status === "ready" ? 100 : 0,
    ...(status === "ready" ? { result: safeResult() } : {}),
    ...(status === "failed"
      ? { error: { code: API_ERROR_CODES.PROCESSING_FAILED, message: "/private/secret stderr" } }
      : {}),
    ...overrides
  };
}

describe("serializeMediaJobSnapshot", () => {
  it("serializes a queued snapshot with only public fields", () => {
    const internal = {
      ...snapshot("queued"),
      sourceUrl: "https://private.example/source",
      path: "/private/tmp/source.mp4",
      stderr: "secret stderr",
      stack: "secret stack",
      controller: new AbortController(),
      handler: () => undefined,
      registry: { path: "/private/registry" }
    } as unknown as MediaJobSnapshot;

    const serialized = serializeMediaJobSnapshot(internal);
    expect(serialized).toEqual({
      jobId: "job_0123456789abcdef",
      status: "queued",
      progress: 0,
      processingPreset: "original",
      createdAt: CREATED_AT,
      startedAt: null,
      completedAt: null,
      expiresAt: null
    });
    const json = JSON.stringify(serialized);
    for (const secret of ["private.example", "/private/", "stderr", "stack", "controller", "handler", "registry"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("serializes running timestamps as canonical ISO strings", () => {
    const serialized = serializeMediaJobSnapshot(snapshot("running", {
      progress: 42.5,
      createdAt: "2026-01-01T03:00:00+03:00",
      startedAt: "2026-01-01T00:00:01Z"
    }));

    expect(serialized).toMatchObject({
      status: "running",
      progress: 42.5,
      createdAt: CREATED_AT,
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: null,
      expiresAt: null
    });
  });

  it("serializes ready output and rebuilds its download URL from the safe fileId", () => {
    const internal = snapshot("ready", {
      completedAt: "2026-01-01T00:10:00Z",
      expiresAt: "2026-01-01T01:10:00Z",
      result: {
        ...safeResult(),
        downloadUrl: "file:///private/tmp/output.mp4",
        sourceUrl: "https://private.example/source",
        sourceFileId: "source_secret",
        partialFileId: "partial_secret",
        path: "/private/tmp/output.mp4",
        stderr: "secret stderr",
        stack: "secret stack",
        args: ["-map", "0:v"]
      } as unknown as MediaJobResult
    });

    const serialized = serializeMediaJobSnapshot(internal);
    expect(serialized.status).toBe("ready");
    if (serialized.status !== "ready") throw new Error("Expected ready snapshot.");
    expect(serialized.result).toEqual({
      fileId: "file_0123456789abcdef",
      filename: "public-video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1_024,
      downloadUrl: "/api/file/file_0123456789abcdef",
      expiresAt: "2026-01-01T01:00:00.000Z",
      processingPreset: "original",
      media: safeResult().media
    });
    const json = JSON.stringify(serialized);
    for (const secret of ["private.example", "/private/tmp", "source_secret", "partial_secret", "stderr", "stack", "-map"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("serializes failed jobs with canonical safe messages", () => {
    const serialized = serializeMediaJobSnapshot(snapshot("failed"));
    expect(serialized).toMatchObject({
      status: "failed",
      error: {
        code: API_ERROR_CODES.PROCESSING_FAILED,
        message: API_ERROR_MESSAGES.PROCESSING_FAILED
      }
    });
    expect(JSON.stringify(serialized)).not.toContain("/private/secret");
    expect(JSON.stringify(serialized)).not.toContain("stderr");
  });

  it("maps an unknown internal error code to INTERNAL_ERROR", () => {
    const serialized = serializeMediaJobSnapshot(snapshot("failed", {
      error: { code: "SECRET_INTERNAL_CODE", message: "secret stack" } as never
    }));
    expect(serialized).toMatchObject({
      status: "failed",
      error: {
        code: API_ERROR_CODES.INTERNAL_ERROR,
        message: API_ERROR_MESSAGES.INTERNAL_ERROR
      }
    });
  });

  it("omits result and error for cancelled jobs", () => {
    const internal = snapshot("cancelled", {
      result: safeResult(),
      error: { code: API_ERROR_CODES.JOB_CANCELLED, message: "secret cause" }
    });
    const serialized = serializeMediaJobSnapshot(internal);
    expect(serialized.status).toBe("cancelled");
    expect(serialized).not.toHaveProperty("result");
    expect(serialized).not.toHaveProperty("error");
  });

  it("never exposes a result before ready", () => {
    for (const status of ["queued", "running"] as const) {
      const serialized = serializeMediaJobSnapshot(snapshot(status, { result: safeResult() }));
      expect(serialized).not.toHaveProperty("result");
    }
  });

  it.each([
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [-10, 0],
    [150, 100],
    [25.5, 25.5]
  ])("normalizes progress %s to %s", (progress, expected) => {
    expect(serializeMediaJobSnapshot(snapshot("running", { progress })).progress).toBe(expected);
  });

  it("returns frozen copies without mutating the internal snapshot", () => {
    const internal = snapshot("ready");
    const before = structuredClone(internal);
    const serialized = serializeMediaJobSnapshot(internal);

    expect(internal).toEqual(before);
    expect(Object.isFrozen(serialized)).toBe(true);
    if (serialized.status !== "ready") throw new Error("Expected ready snapshot.");
    expect(Object.isFrozen(serialized.result)).toBe(true);
    expect(Object.isFrozen(serialized.result.media)).toBe(true);
    expect(serialized.result).not.toBe(internal.result);
    expect(serialized.result.media).not.toBe(internal.result?.media);
  });

  it("does not expose an invalid final fileId", () => {
    const serialized = serializeMediaJobSnapshot(snapshot("ready", {
      result: { ...safeResult(), fileId: "../../secret" }
    }));
    expect(serialized).toMatchObject({
      status: "failed",
      error: {
        code: API_ERROR_CODES.INTERNAL_ERROR,
        message: API_ERROR_MESSAGES.INTERNAL_ERROR
      }
    });
    expect(serialized).not.toHaveProperty("result");
    expect(JSON.stringify(serialized)).not.toContain("secret");
  });

  it("does not expose a path-shaped media format name", () => {
    const serialized = serializeMediaJobSnapshot(snapshot("ready", {
      result: {
        ...safeResult(),
        media: { ...safeResult().media, formatName: "/private/tmp/probe-output" }
      }
    }));
    expect(serialized).toMatchObject({
      status: "failed",
      error: { code: API_ERROR_CODES.INTERNAL_ERROR }
    });
    expect(JSON.stringify(serialized)).not.toContain("/private/tmp");
  });

  it("serializes create-job data only from a queued snapshot", () => {
    expect(serializeCreateDownloadJobData(snapshot("queued"))).toEqual({
      jobId: "job_0123456789abcdef",
      status: "queued",
      progress: 0,
      processingPreset: "original",
      createdAt: CREATED_AT,
      expiresAt: null,
      statusUrl: "/api/jobs/job_0123456789abcdef",
      cancelUrl: "/api/jobs/job_0123456789abcdef"
    });
  });
});
