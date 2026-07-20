import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import * as metadataModule from "@/lib/extractors/facebook-metadata";
import {
  FACEBOOK_METADATA_EXECUTION_DECISION,
  FACEBOOK_METADATA_PROVIDER_PRODUCTION_ENABLED,
  normalizeSyntheticFacebookMetadata
} from "@/lib/extractors/facebook-metadata";
import { canonicalizeFacebookContentUrl } from "@/lib/extractors/facebook-url";
import { API_ERROR_CODES } from "@/lib/types";

const CONTENT_ID = "700000000000001";
const VIDEO_IDENTITY = canonicalizeFacebookContentUrl(
  new URL(`https://www.facebook.com/watch/?v=${CONTENT_ID}`)
);
const REEL_IDENTITY = canonicalizeFacebookContentUrl(
  new URL(`https://www.facebook.com/reel/${CONTENT_ID}/`)
);

function output(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    platform: "facebook",
    contentId: CONTENT_ID,
    contentType: "video",
    availability: "public",
    singleVideo: true,
    hosting: "facebook",
    title: "Synthetic video",
    description: "Synthetic description #fixture",
    durationSeconds: 12,
    width: 1920,
    height: 1080,
    hasAudio: true,
    ...overrides
  });
}

function normalize(value = output()) {
  return normalizeSyntheticFacebookMetadata(VIDEO_IDENTITY, value);
}

describe("Facebook synthetic metadata normalization", () => {
  it("exposes only a pure, non-executable NO-GO surface", () => {
    expect(FACEBOOK_METADATA_EXECUTION_DECISION).toBe("no-go");
    expect(FACEBOOK_METADATA_PROVIDER_PRODUCTION_ENABLED).toBe(false);
    expect(Object.keys(metadataModule).sort()).toEqual([
      "FACEBOOK_METADATA_EXECUTION_DECISION",
      "FACEBOOK_METADATA_PROVIDER_PRODUCTION_ENABLED",
      "normalizeSyntheticFacebookMetadata"
    ]);
  });

  it("normalizes a bounded video candidate without network access", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      expect(normalize()).toEqual({
        platform: "facebook",
        contentId: CONTENT_ID,
        contentType: "video",
        title: "Synthetic video",
        description: "Synthetic description #fixture",
        durationSeconds: 12,
        width: 1920,
        height: 1080,
        orientation: "landscape",
        aspectRatio: { width: 16, height: 9 },
        hasAudio: true,
        singleVideo: true
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("normalizes a bounded Reel candidate", () => {
    const metadata = normalizeSyntheticFacebookMetadata(REEL_IDENTITY, output({
      contentType: "reel",
      width: 1080,
      height: 1920
    }));
    expect(metadata.contentType).toBe("reel");
    expect(metadata.orientation).toBe("portrait");
    expect(metadata.aspectRatio).toEqual({ width: 9, height: 16 });
  });

  it("preserves Unicode, emoji and hashtags while sanitizing controls and unsafe text", () => {
    const metadata = normalize(output({
      title: "  Привет\u0000 / мир 😀 #тест  ",
      description: "@fixture\nстрока https://cdn.example/media?token=secret mirror.example/path token=hidden\u202e"
    }));
    expect(metadata.title).toBe("Привет мир 😀 #тест");
    expect(metadata.description).toBe("@fixture строка");
    expect(JSON.stringify(metadata)).not.toMatch(/https?:\/\/|token=|hidden|cdn\.example|mirror\.example/i);
  });

  it("truncates descriptions by code points and represents silent square video", () => {
    const metadata = normalize(output({
      description: "😀".repeat(600),
      width: 1080,
      height: 1080,
      hasAudio: false
    }));
    expect(Array.from(metadata.description)).toHaveLength(512);
    expect(metadata.orientation).toBe("square");
    expect(metadata.aspectRatio).toEqual({ width: 1, height: 1 });
    expect(metadata.hasAudio).toBe(false);
  });

  it.each([
    ["private", API_ERROR_CODES.PRIVATE_CONTENT],
    ["friends_only", API_ERROR_CODES.PRIVATE_CONTENT],
    ["login_required", API_ERROR_CODES.LOGIN_REQUIRED],
    ["age_restricted", API_ERROR_CODES.AGE_RESTRICTED],
    ["region_restricted", API_ERROR_CODES.REGION_RESTRICTED],
    ["checkpoint", API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE],
    ["challenge", API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE],
    ["captcha", API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE],
    ["removed", API_ERROR_CODES.CONTENT_UNAVAILABLE],
    ["unavailable", API_ERROR_CODES.CONTENT_UNAVAILABLE]
  ])("maps %s availability without exposing synthetic input", (availability, code) => {
    expect(() => normalize(output({ availability }))).toThrowError(expect.objectContaining({ code }));
  });

  it.each([
    ["image", API_ERROR_CODES.IMAGE_POST_NOT_SUPPORTED],
    ["story", API_ERROR_CODES.STORY_NOT_SUPPORTED],
    ["live", API_ERROR_CODES.LIVE_NOT_SUPPORTED],
    ["group", API_ERROR_CODES.GROUP_CONTENT_NOT_SUPPORTED],
    ["multi_item", API_ERROR_CODES.MULTI_ITEM_POST_NOT_SUPPORTED],
    ["external", API_ERROR_CODES.EXTERNAL_MEDIA_NOT_SUPPORTED]
  ])("maps %s content semantics precisely", (contentType, code) => {
    expect(() => normalize(output({ contentType }))).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects non-single and externally hosted results precisely", () => {
    expect(() => normalize(output({ singleVideo: false }))).toThrowError(expect.objectContaining({
      code: API_ERROR_CODES.MULTI_ITEM_POST_NOT_SUPPORTED
    }));
    expect(() => normalize(output({ hosting: "external" }))).toThrowError(expect.objectContaining({
      code: API_ERROR_CODES.EXTERNAL_MEDIA_NOT_SUPPORTED
    }));
  });

  it.each([
    ["malformed JSON", "{broken"],
    ["wrong identity", output({ contentId: "700000000000002" })],
    ["route/content mismatch", output({ contentType: "reel" })],
    ["media URL", output({ mediaUrl: "https://cdn.example/signed?token=secret" })],
    ["raw diagnostics", output({ diagnostics: { stderr: "private path" } })],
    ["raw GraphQL", output({ graphql: { token: "hidden" } })],
    ["unknown shape", JSON.stringify([output()])],
    ["oversized dimensions", output({ width: 16_384, height: 16_384 })],
    ["unknown availability", output({ availability: "other" })],
    ["unknown content type", output({ contentType: "unknown" })],
    ["unknown hosting", output({ hosting: "other" })],
    ["invalid text shape", output({ description: { raw: "hidden" } })]
  ])("fails closed for %s", (_label, syntheticOutput) => {
    try {
      normalize(syntheticOutput);
      throw new Error("Expected synthetic metadata failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: API_ERROR_CODES.EXTRACTOR_FAILED });
      expect((error as Error).message).not.toMatch(/https?:\/\/|cookie|stderr|secret|token|700000000000001/i);
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
