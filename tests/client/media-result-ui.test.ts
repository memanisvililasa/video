import { describe, expect, it } from "vitest";
import type { MediaJobApiResult } from "@/lib/api/media-job-dto";
import {
  formatFileSize,
  getCanonicalDownloadUrl,
  getSafeResultSummary
} from "@/lib/client/media-result-ui";

function result(overrides: Partial<MediaJobApiResult> = {}): MediaJobApiResult {
  return {
    fileId: "file_0123456789abcdef",
    filename: "public-video.mp4",
    mimeType: "video/mp4",
    sizeBytes: 1_572_864,
    downloadUrl: "/api/file/file_0123456789abcdef",
    expiresAt: "2026-01-01T01:00:00.000Z",
    processingPreset: "compatible-mp4",
    media: {
      durationSeconds: 90,
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      hasVideo: true,
      hasAudio: true,
      width: 1920,
      height: 1080,
      videoCodec: "h264",
      audioCodec: "aac"
    },
    ...overrides
  };
}

describe("ready result UI helpers", () => {
  it.each([
    [0, "0 Б"],
    [512, "512 Б"],
    [1_024, "1 КБ"],
    [1_536, "1,5 КБ"],
    [1_048_576, "1 МБ"],
    [Number.NaN, "—"],
    [-1, "—"]
  ])("formats %s bytes as %s", (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });

  it("accepts only the canonical file route", () => {
    expect(getCanonicalDownloadUrl(result())).toBe("/api/file/file_0123456789abcdef");
    expect(getCanonicalDownloadUrl(result({ downloadUrl: "https://attacker.example/file.mp4" }))).toBeNull();
    expect(getCanonicalDownloadUrl(result({ downloadUrl: "/api/file/another-file" }))).toBeNull();
    expect(getCanonicalDownloadUrl(result({ downloadUrl: "" }))).toBeNull();
  });

  it("does not create a downloadable summary without a canonical URL", () => {
    expect(getSafeResultSummary(result({ downloadUrl: "https://attacker.example/file.mp4" }), "compatible-mp4")).toBeNull();
    expect(getSafeResultSummary(result({ downloadUrl: "" }), "compatible-mp4")).toBeNull();
  });

  it("describes a compatible MP4 using only safe result metadata", () => {
    expect(getSafeResultSummary(result(), "compatible-mp4")).toEqual({
      filename: "public-video.mp4",
      formatLabel: "MP4 · video/mp4",
      sizeLabel: "1,5 МБ",
      downloadUrl: "/api/file/file_0123456789abcdef",
      details: ["Длительность: 1:30", "Разрешение: 1920 × 1080", "Видео: H264", "Аудио: AAC"]
    });
  });

  it("describes audio-only as M4A without video processing details", () => {
    const audioResult = result({
      filename: "public-video.m4a",
      mimeType: "audio/mp4",
      processingPreset: "audio-only",
      media: {
        durationSeconds: 90,
        formatName: "mov,mp4,m4a,3gp,3g2,mj2",
        hasVideo: false,
        hasAudio: true,
        audioCodec: "aac"
      }
    });
    const summary = getSafeResultSummary(audioResult, "audio-only");
    expect(summary?.formatLabel).toBe("M4A · audio/mp4");
    expect(summary?.details).toEqual(["Длительность: 1:30", "Аудио: AAC"]);
    expect(JSON.stringify(summary)).not.toContain("Разрешение");
    expect(JSON.stringify(summary)).not.toContain("Видео:");
    expect(JSON.stringify(summary)).not.toContain("MP3");
  });
});
