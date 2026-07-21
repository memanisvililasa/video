import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import * as metadataModule from "@/lib/extractors/tiktok-metadata";
import {
  normalizeSyntheticTikTokMetadata,
  TIKTOK_METADATA_EXECUTION_DECISION,
  TIKTOK_METADATA_PROVIDER_PRODUCTION_ENABLED
} from "@/lib/extractors/tiktok-metadata";
import { canonicalizeTikTokVideoUrl } from "@/lib/extractors/tiktok-url";
import { API_ERROR_CODES } from "@/lib/types";

const VIDEO_ID = "7000000000000000001";
const IDENTITY = canonicalizeTikTokVideoUrl(
  new URL(`https://www.tiktok.com/@synthetic/video/${VIDEO_ID}`)
);

function output(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    platform: "tiktok",
    videoId: VIDEO_ID,
    postType: "video",
    availability: "public",
    singleVideo: true,
    title: "Synthetic video",
    description: "Synthetic description",
    durationSeconds: 12,
    width: 1080,
    height: 1920,
    hasAudio: true,
    ...overrides
  });
}

function normalize(value = output()) {
  return normalizeSyntheticTikTokMetadata(IDENTITY, value);
}

describe("TikTok synthetic metadata normalization", () => {
  it("exposes the restricted parser while keeping production disabled", () => {
    expect(TIKTOK_METADATA_EXECUTION_DECISION).toBe("restricted-page");
    expect(TIKTOK_METADATA_PROVIDER_PRODUCTION_ENABLED).toBe(false);
    expect(Object.keys(metadataModule).sort()).toEqual([
      "TIKTOK_METADATA_EXECUTION_DECISION",
      "TIKTOK_METADATA_PROVIDER_PRODUCTION_ENABLED",
      "normalizeSyntheticTikTokMetadata",
      "parseTikTokHydrationMetadata"
    ]);
  });

  it("normalizes only bounded safe internal metadata without network access", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const metadata = normalize();
      expect(metadata).toEqual({
        platform: "tiktok",
        videoId: VIDEO_ID,
        title: "Synthetic video",
        description: "Synthetic description",
        durationSeconds: 12,
        width: 1080,
        height: 1920,
        orientation: "portrait",
        aspectRatio: { width: 9, height: 16 },
        hasAudio: true,
        singleVideo: true
      });
      expect(JSON.stringify(metadata)).not.toMatch(/https?:\/\/|cdn|cookie|header|stderr|path/i);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("normalizes Unicode, emoji, hashtags, controls and dangerous filename characters", () => {
    const metadata = normalize(output({
      title: "  Привет\u0000 / мир 😀 #тест  ",
      description: "line one\nline two\\name\u202e"
    }));
    expect(metadata.title).toBe("Привет мир 😀 #тест");
    expect(metadata.description).toBe("line one line two name");
  });

  it("redacts URLs and token-like text from output", () => {
    const metadata = normalize(output({
      title: "Watch https://cdn.example/video.mp4?token=secret now",
      description: "authorization=BearerSecret signed_token=verysecretvalue"
    }));
    expect(`${metadata.title} ${metadata.description}`).not.toMatch(/https?:|cdn\.example|authorization|secret/i);
  });

  it("truncates descriptions by Unicode code points and represents silent video", () => {
    const metadata = normalize(output({ description: "😀".repeat(600), hasAudio: false }));
    expect(Array.from(metadata.description)).toHaveLength(512);
    expect(metadata.hasAudio).toBe(false);
  });

  it.each([
    ["private", API_ERROR_CODES.PRIVATE_CONTENT],
    ["login_required", API_ERROR_CODES.LOGIN_REQUIRED],
    ["age_restricted", API_ERROR_CODES.AGE_RESTRICTED],
    ["region_restricted", API_ERROR_CODES.REGION_RESTRICTED],
    ["captcha", API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE],
    ["unavailable", API_ERROR_CODES.CONTENT_UNAVAILABLE]
  ])("maps %s availability without exposing raw output", (availability, code) => {
    expect(() => normalize(output({ availability }))).toThrowError(expect.objectContaining({ code }));
  });

  it.each([
    ["live", API_ERROR_CODES.LIVE_NOT_SUPPORTED],
    ["photo", API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED]
  ])("maps %s post semantics precisely", (postType, code) => {
    expect(() => normalize(output({ postType }))).toThrowError(expect.objectContaining({ code }));
  });

  it.each([
    ["malformed JSON", "{broken"],
    ["wrong identity", output({ videoId: "7000000000000000002" })],
    ["media URL", output({ mediaUrl: "https://cdn.example/signed?token=secret" })],
    ["raw stderr", output({ stderr: "login required at https://secret.example" })],
    ["non-video post", output({ postType: "story" })],
    ["oversized dimensions", output({ width: 16_384, height: 16_384 })]
  ])("fails closed for %s", (_label, syntheticOutput) => {
    try {
      normalize(syntheticOutput);
      throw new Error("Expected synthetic metadata failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: API_ERROR_CODES.EXTRACTOR_FAILED });
      expect((error as Error).message).not.toMatch(/https?:\/\/|cookie|stderr|secret|token/i);
    }
  });

  it("rejects oversized synthetic output", () => {
    expect(() => normalize("x".repeat(4 * 1024 * 1024 + 1))).toThrowError(expect.objectContaining({
      code: API_ERROR_CODES.EXTRACTOR_FAILED
    }));
  });
});
