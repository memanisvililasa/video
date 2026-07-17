import { describe, expect, it } from "vitest";
import { parseYtDlpMetadataJson } from "@/lib/extractors/yt-dlp/parser";
import { API_ERROR_CODES } from "@/lib/types";

function metadata(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    _type: "video",
    extractor_key: "Vimeo",
    id: "fixture-video",
    title: "Public fixture",
    availability: "public",
    duration: 12,
    formats: [
      {
        format_id: "progressive-720",
        protocol: "https",
        url: "https://media.example/video.mp4",
        ext: "mp4",
        vcodec: "h264",
        acodec: "aac",
        width: 1280,
        height: 720,
        filesize: 1024
      },
      {
        format_id: "video-1080",
        protocol: "https",
        url: "https://media.example/video-only.mp4",
        ext: "mp4",
        vcodec: "h264",
        acodec: "none",
        width: 1920,
        height: 1080
      },
      {
        format_id: "audio-main",
        protocol: "https",
        url: "https://media.example/audio.m4a",
        ext: "m4a",
        vcodec: "none",
        acodec: "aac",
        abr: 128
      }
    ],
    ...overrides
  });
}

describe("strict yt-dlp metadata parser", () => {
  it("normalizes progressive and separate direct strategies without exposing URLs in IDs", () => {
    const parsed = parseYtDlpMetadataJson(metadata(), "vimeo");
    expect(parsed.strategies).toHaveLength(2);
    expect(parsed.strategies.map((strategy) => strategy.transport)).toEqual([
      "separate-direct",
      "progressive-direct"
    ]);
    for (const strategy of parsed.strategies) {
      expect(strategy.stableId).toMatch(/^pf_[A-Za-z0-9_-]{43}$/);
      expect(strategy.stableId).not.toContain("media.example");
    }
  });

  it.each([
    [{ availability: "private" }, API_ERROR_CODES.PRIVATE_CONTENT],
    [{ availability: "needs_auth" }, API_ERROR_CODES.LOGIN_REQUIRED],
    [{ age_limit: 18 }, API_ERROR_CODES.AGE_RESTRICTED],
    [{ has_drm: true }, API_ERROR_CODES.DRM_PROTECTED],
    [{ is_live: true }, API_ERROR_CODES.UNSUPPORTED_URL],
    [{ _type: "playlist", entries: [] }, API_ERROR_CODES.UNSUPPORTED_URL],
    [{ extractor_key: "Generic" }, API_ERROR_CODES.EXTRACTOR_FAILED]
  ])("fails closed for restricted metadata %#", (overrides, code) => {
    expect(() => parseYtDlpMetadataJson(metadata(overrides), "vimeo")).toThrowError(
      expect.objectContaining({ code })
    );
  });

  it("rejects manifest, fragment and private-target formats", () => {
    const value = metadata({ formats: [
      { format_id: "hls", protocol: "m3u8_native", url: "https://media.example/list.m3u8", ext: "mp4", vcodec: "h264", acodec: "aac" },
      { format_id: "fragments", protocol: "https", url: "https://media.example/segment", ext: "mp4", vcodec: "h264", acodec: "aac", fragments: [{}] },
      { format_id: "private", protocol: "https", url: "https://127.0.0.1/video.mp4", ext: "mp4", vcodec: "h264", acodec: "aac" }
    ] });
    expect(() => parseYtDlpMetadataJson(value, "vimeo")).toThrowError(
      expect.objectContaining({ code: API_ERROR_CODES.NO_SUPPORTED_FORMAT })
    );
  });

  it("filters DRM, custom-header, cookie, video-only, and audio-only choices when no progressive source remains", () => {
    const value = metadata({ formats: [
      { format_id: "drm", protocol: "https", url: "https://media.example/drm.mp4", ext: "mp4", vcodec: "h264", acodec: "aac", has_drm: true },
      { format_id: "headers", protocol: "https", url: "https://media.example/headers.mp4", ext: "mp4", vcodec: "h264", acodec: "aac", http_headers: { Authorization: "secret" } },
      { format_id: "cookies", protocol: "https", url: "https://media.example/cookies.mp4", ext: "mp4", vcodec: "h264", acodec: "aac", cookies: "secret" },
      { format_id: "video", protocol: "https", url: "https://media.example/video.mp4", ext: "mp4", vcodec: "h264", acodec: "none" },
      { format_id: "audio", protocol: "https", url: "https://media.example/audio.webm", ext: "webm", vcodec: "none", acodec: "opus" }
    ] });
    expect(() => parseYtDlpMetadataJson(value, "vimeo")).toThrowError(
      expect.objectContaining({ code: API_ERROR_CODES.NO_SUPPORTED_FORMAT })
    );
  });

  it.each([
    [{ title: null }, API_ERROR_CODES.EXTRACTOR_FAILED],
    [{ duration: -1 }, undefined],
    [{ formats: [] }, API_ERROR_CODES.NO_SUPPORTED_FORMAT]
  ])("handles invalid bounded metadata %#", (overrides, expectedCode) => {
    if (expectedCode) {
      expect(() => parseYtDlpMetadataJson(metadata(overrides), "vimeo")).toThrowError(
        expect.objectContaining({ code: expectedCode })
      );
      return;
    }
    expect(parseYtDlpMetadataJson(metadata(overrides), "vimeo").durationSeconds).toBeUndefined();
  });

  it("rejects malformed and oversized JSON", () => {
    expect(() => parseYtDlpMetadataJson("{broken", "vimeo")).toThrowError(
      expect.objectContaining({ code: API_ERROR_CODES.EXTRACTOR_FAILED })
    );
    expect(() => parseYtDlpMetadataJson(`{"padding":"${"x".repeat(8 * 1024 * 1024)}"}`, "vimeo"))
      .toThrowError(expect.objectContaining({ code: API_ERROR_CODES.EXTRACTOR_FAILED }));
  });

  it("rejects excessive nesting before parsing", () => {
    const value = `${"[".repeat(65)}0${"]".repeat(65)}`;
    expect(() => parseYtDlpMetadataJson(value, "vimeo")).toThrowError(
      expect.objectContaining({ code: API_ERROR_CODES.EXTRACTOR_FAILED })
    );
  });
});
