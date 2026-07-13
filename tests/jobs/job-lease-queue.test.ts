import { describe, expect, it } from "vitest";
import {
  createJobWorkerId,
  DURABLE_JOB_PAYLOAD_LIMITS,
  isSafeJobWorkerId,
  sanitizeMediaJobWorkItem
} from "@/lib/jobs/job-lease-queue";

describe("durable media job payload", () => {
  it("normalizes and freezes the minimum execution payload", () => {
    const payload = sanitizeMediaJobWorkItem({
      sourceUrl: " HTTPS://Example.com/watch?v=42#fragment ",
      formatId: "video.1080p-audio",
      processingPreset: "compatible-mp4"
    });
    expect(payload).toEqual({
      sourceUrl: "https://example.com/watch?v=42",
      formatId: "video.1080p-audio",
      processingPreset: "compatible-mp4"
    });
    expect(Object.isFrozen(payload)).toBe(true);
  });

  it("drops every runtime-only or credential-bearing extra field", () => {
    const payload = sanitizeMediaJobWorkItem({
      sourceUrl: "https://example.com/video",
      formatId: "best",
      processingPreset: "original",
      cookies: "session=secret",
      token: "secret",
      executable: "/bin/tool",
      outputPath: "/tmp/output",
      ffmpegArgs: ["-filter_complex", "unsafe"]
    });
    expect(Object.keys(payload)).toEqual(["sourceUrl", "formatId", "processingPreset"]);
    expect(JSON.stringify(payload)).not.toContain("secret");
    expect(JSON.stringify(payload)).not.toContain("/tmp");
  });

  it.each([
    ["credentials", "https://user:password@example.com/video"],
    ["token", "https://example.com/video?access_token=secret"],
    ["signature", "https://example.com/video?signature=secret"],
    ["prefixed credential", "https://example.com/video?X-Amz-Credential=secret"],
    ["local target", "http://127.0.0.1/video"],
    ["unsupported scheme", "file:///tmp/video.mp4"]
  ])("rejects %s in a durable URL", (_name, sourceUrl) => {
    expect(() =>
      sanitizeMediaJobWorkItem({ sourceUrl, formatId: "best", processingPreset: "original" })
    ).toThrow();
  });

  it("rejects malformed identifiers and oversized data", () => {
    expect(() =>
      sanitizeMediaJobWorkItem({
        sourceUrl: "https://example.com/video",
        formatId: "best; DROP TABLE media_jobs",
        processingPreset: "original"
      })
    ).toThrow("invalid");
    expect(() =>
      sanitizeMediaJobWorkItem({
        sourceUrl: `https://example.com/${"x".repeat(DURABLE_JOB_PAYLOAD_LIMITS.sourceUrlCharacters)}`,
        formatId: "best",
        processingPreset: "original"
      })
    ).toThrow();
  });

  it("generates internal bounded worker IDs", () => {
    const workerId = createJobWorkerId();
    expect(workerId).toMatch(/^worker_[a-f0-9]{32}$/);
    expect(isSafeJobWorkerId(workerId)).toBe(true);
    expect(isSafeJobWorkerId("public-worker")).toBe(false);
  });
});
