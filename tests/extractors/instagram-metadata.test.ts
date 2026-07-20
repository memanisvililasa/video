import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import * as metadataModule from "@/lib/extractors/instagram-metadata";
import {
  INSTAGRAM_METADATA_EXECUTION_DECISION,
  INSTAGRAM_METADATA_PROVIDER_PRODUCTION_ENABLED,
  normalizeSyntheticInstagramMetadata
} from "@/lib/extractors/instagram-metadata";
import { canonicalizeInstagramContentUrl } from "@/lib/extractors/instagram-url";
import { API_ERROR_CODES } from "@/lib/types";

const SHORTCODE = "Synth_01";
const REEL_IDENTITY = canonicalizeInstagramContentUrl(
  new URL(`https://www.instagram.com/reel/${SHORTCODE}/`)
);
const POST_IDENTITY = canonicalizeInstagramContentUrl(
  new URL(`https://www.instagram.com/p/${SHORTCODE}/`)
);

function output(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    platform: "instagram",
    shortcode: SHORTCODE,
    contentType: "reel",
    availability: "public",
    singleContent: true,
    title: "Synthetic Reel",
    caption: "Synthetic caption #fixture",
    durationSeconds: 12,
    width: 1080,
    height: 1920,
    hasAudio: true,
    ...overrides
  });
}

function normalize(value = output()) {
  return normalizeSyntheticInstagramMetadata(REEL_IDENTITY, value);
}

describe("Instagram synthetic metadata normalization", () => {
  it("exposes only a pure, non-executable NO-GO surface", () => {
    expect(INSTAGRAM_METADATA_EXECUTION_DECISION).toBe("no-go");
    expect(INSTAGRAM_METADATA_PROVIDER_PRODUCTION_ENABLED).toBe(false);
    expect(Object.keys(metadataModule).sort()).toEqual([
      "INSTAGRAM_METADATA_EXECUTION_DECISION",
      "INSTAGRAM_METADATA_PROVIDER_PRODUCTION_ENABLED",
      "normalizeSyntheticInstagramMetadata"
    ]);
  });

  it("normalizes a bounded Reel candidate without network access", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      expect(normalize()).toEqual({
        platform: "instagram",
        shortcode: SHORTCODE,
        contentType: "reel",
        title: "Synthetic Reel",
        caption: "Synthetic caption #fixture",
        durationSeconds: 12,
        width: 1080,
        height: 1920,
        orientation: "portrait",
        aspectRatio: { width: 9, height: 16 },
        hasAudio: true,
        singleContent: true
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("normalizes a bounded video-post candidate", () => {
    const metadata = normalizeSyntheticInstagramMetadata(POST_IDENTITY, output({ contentType: "video_post" }));
    expect(metadata.contentType).toBe("video-post");
    expect(metadata.shortcode).toBe(SHORTCODE);
    expect(metadata.singleContent).toBe(true);
  });

  it("preserves Unicode, emoji, hashtags and mentions while sanitizing controls and unsafe text", () => {
    const metadata = normalize(output({
      title: "  Привет\u0000 / мир 😀 #тест  ",
      caption: "@fixture\nстрока https://cdn.example/media?token=secret mirror.example/path token=hidden\u202e"
    }));
    expect(metadata.title).toBe("Привет мир 😀 #тест");
    expect(metadata.caption).toBe("@fixture строка");
    expect(JSON.stringify(metadata)).not.toMatch(/https?:\/\/|token=|hidden|cdn\.example|mirror\.example/i);
  });

  it("truncates captions by Unicode code points and represents silent square video", () => {
    const metadata = normalize(output({
      caption: "😀".repeat(600),
      width: 1080,
      height: 1080,
      hasAudio: false
    }));
    expect(Array.from(metadata.caption)).toHaveLength(512);
    expect(metadata.orientation).toBe("square");
    expect(metadata.aspectRatio).toEqual({ width: 1, height: 1 });
    expect(metadata.hasAudio).toBe(false);
  });

  it.each([
    ["private", API_ERROR_CODES.PRIVATE_CONTENT],
    ["login_required", API_ERROR_CODES.LOGIN_REQUIRED],
    ["age_restricted", API_ERROR_CODES.AGE_RESTRICTED],
    ["region_restricted", API_ERROR_CODES.REGION_RESTRICTED],
    ["challenge", API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE],
    ["captcha", API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE],
    ["removed", API_ERROR_CODES.CONTENT_UNAVAILABLE],
    ["unavailable", API_ERROR_CODES.CONTENT_UNAVAILABLE]
  ])("maps %s availability without exposing synthetic input", (availability, code) => {
    expect(() => normalize(output({ availability }))).toThrowError(expect.objectContaining({ code }));
  });

  it.each([
    ["image", API_ERROR_CODES.IMAGE_POST_NOT_SUPPORTED],
    ["carousel", API_ERROR_CODES.CAROUSEL_NOT_SUPPORTED],
    ["mixed_carousel", API_ERROR_CODES.CAROUSEL_NOT_SUPPORTED],
    ["story", API_ERROR_CODES.STORY_NOT_SUPPORTED],
    ["live", API_ERROR_CODES.LIVE_NOT_SUPPORTED]
  ])("maps %s content semantics precisely", (contentType, code) => {
    expect(() => normalize(output({ contentType }))).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects a non-single result as a carousel", () => {
    expect(() => normalize(output({ singleContent: false }))).toThrowError(expect.objectContaining({
      code: API_ERROR_CODES.CAROUSEL_NOT_SUPPORTED
    }));
  });

  it.each([
    ["malformed JSON", "{broken"],
    ["wrong identity", output({ shortcode: "Synth_02" })],
    ["route/content mismatch", output({ contentType: "video_post" })],
    ["media URL", output({ mediaUrl: "https://cdn.example/signed?token=secret" })],
    ["raw diagnostics", output({ diagnostics: { stderr: "private path" } })],
    ["unknown shape", JSON.stringify([output()])],
    ["oversized dimensions", output({ width: 16_384, height: 16_384 })],
    ["unknown availability", output({ availability: "other" })],
    ["unknown content type", output({ contentType: "unknown" })]
  ])("fails closed for %s", (_label, syntheticOutput) => {
    try {
      normalize(syntheticOutput);
      throw new Error("Expected synthetic metadata failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: API_ERROR_CODES.EXTRACTOR_FAILED });
      expect((error as Error).message).not.toMatch(/https?:\/\/|cookie|stderr|secret|token|shortcode/i);
    }
  });

  it("rejects oversized and excessively nested synthetic output", () => {
    expect(() => normalize("x".repeat(4 * 1024 * 1024 + 1))).toThrowError(expect.objectContaining({
      code: API_ERROR_CODES.EXTRACTOR_FAILED
    }));

    let nested: unknown = "leaf";
    for (let index = 0; index < 66; index += 1) nested = { nested };
    expect(() => normalize(JSON.stringify(nested))).toThrowError(expect.objectContaining({
      code: API_ERROR_CODES.EXTRACTOR_FAILED
    }));
  });
});
