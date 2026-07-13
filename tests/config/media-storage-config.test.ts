import { describe, expect, it } from "vitest";
import { parseMediaStorageConfig } from "@/lib/config/env";

describe("explicit media storage configuration", () => {
  it("keeps local storage as the default without requiring a root", () => {
    expect(parseMediaStorageConfig({})).toMatchObject({ backend: "local", root: null });
  });

  it("parses a bounded explicit durable-volume configuration", () => {
    expect(parseMediaStorageConfig({
      MEDIA_STORAGE_BACKEND: "durable-volume",
      MEDIA_STORAGE_ROOT: "/srv/videosave-media",
      MEDIA_STORAGE_MAX_OUTPUT_BYTES: "1048576",
      MEDIA_STORAGE_MAX_JOB_BYTES: "2097152",
      MEDIA_FINAL_TTL_SECONDS: "60",
      MEDIA_STORAGE_LOW_DISK_BYTES: "1048576",
      MEDIA_CLEANUP_BATCH_SIZE: "1"
    })).toEqual({
      backend: "durable-volume",
      root: "/srv/videosave-media",
      maxOutputBytes: 1_048_576,
      maxJobBytes: 2_097_152,
      finalTtlSeconds: 60,
      lowDiskBytes: 1_048_576,
      cleanupBatchSize: 1
    });
  });

  it.each([
    [{ MEDIA_STORAGE_BACKEND: "s3" }],
    [{ MEDIA_STORAGE_BACKEND: "durable-volume" }],
    [{ MEDIA_STORAGE_BACKEND: "durable-volume", MEDIA_STORAGE_ROOT: "relative/path" }],
    [{ MEDIA_STORAGE_MAX_OUTPUT_BYTES: "0" }],
    [{ MEDIA_STORAGE_MAX_JOB_BYTES: "2097152", MEDIA_STORAGE_MAX_OUTPUT_BYTES: "3145728" }],
    [{ MEDIA_CLEANUP_BATCH_SIZE: "1001" }]
  ])("rejects malformed or unsafe storage config %#", (source) => {
    expect(() => parseMediaStorageConfig(source)).toThrow(TypeError);
  });
});
