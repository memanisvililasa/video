import { describe, expect, it } from "vitest";
import { normalizeSyntheticXMetadata } from "@/lib/extractors/x-metadata";
import { canonicalizeXStatusUrl } from "@/lib/extractors/x-url";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";

const POST_ID = "700000000000000001";
const IDENTITY = canonicalizeXStatusUrl(
  new URL(`https://x.com/synthetic_user/status/${POST_ID}`)
);

function metadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    platform: "x",
    postId: POST_ID,
    contentType: "video",
    availability: "public",
    hosting: "x",
    mediaOrigin: "post",
    singleVideo: true,
    title: "Synthetic video",
    description: "Synthetic description",
    durationSeconds: 12.5,
    width: 1920,
    height: 1080,
    hasAudio: true,
    ...overrides
  });
}

function expectCode(overrides: Record<string, unknown>, code: ApiErrorCode): void {
  expect(() => normalizeSyntheticXMetadata(IDENTITY, metadata(overrides)))
    .toThrowError(expect.objectContaining({ code }));
}

describe("synthetic-only X/Twitter metadata normalization", () => {
  it("normalizes a single public video candidate without source locators", () => {
    const result = normalizeSyntheticXMetadata(IDENTITY, metadata());
    expect(result).toEqual({
      platform: "x",
      postId: POST_ID,
      contentType: "video-candidate",
      title: "Synthetic video",
      description: "Synthetic description",
      durationSeconds: 12.5,
      width: 1920,
      height: 1080,
      orientation: "landscape",
      aspectRatio: { width: 16, height: 9 },
      hasAudio: true,
      singleVideo: true
    });
    expect(JSON.stringify(result)).not.toMatch(/https?:\/\/|cdn|signed|cookie|token|authorization/i);
  });

  it("normalizes an animated-GIF candidate only with silent or unspecified audio evidence", () => {
    const result = normalizeSyntheticXMetadata(IDENTITY, metadata({
      contentType: "animated_gif",
      hasAudio: false,
      width: 800,
      height: 800
    }));
    expect(result).toMatchObject({
      contentType: "animated-gif-candidate",
      orientation: "square",
      aspectRatio: { width: 1, height: 1 },
      hasAudio: false
    });
    expectCode({ contentType: "animated_gif", hasAudio: true }, API_ERROR_CODES.EXTRACTOR_FAILED);
  });

  it("preserves safe Unicode, emoji, and hashtags while removing mentions and dangerous text", () => {
    const result = normalizeSyntheticXMetadata(IDENTITY, metadata({
      title: "  Привет\n🌍 #video @Synthetic_User \u202Ehidden  ",
      description: "source https://media.example/video token=secret bearer abcdefghijklmnop example.org/path <unsafe>|name"
    }));
    expect(result.title).toContain("Привет 🌍 #video");
    expect(result.title).toContain("hidden");
    expect(result.title).not.toMatch(/@Synthetic_User|\u202e/);
    expect(result.description).not.toMatch(/https?:\/\/|media\.example|example\.org|token|bearer|secret|[<>|]/i);
  });

  it("truncates title and description by Unicode code point", () => {
    const result = normalizeSyntheticXMetadata(IDENTITY, metadata({
      title: "🌍".repeat(200),
      description: "я".repeat(600)
    }));
    expect(Array.from(result.title)).toHaveLength(160);
    expect(Array.from(result.description)).toHaveLength(512);
  });

  it("records silent video only when the synthetic schema says so", () => {
    expect(normalizeSyntheticXMetadata(IDENTITY, metadata({ hasAudio: false }))).toMatchObject({ hasAudio: false });
    const withoutAudio = JSON.parse(metadata()) as Record<string, unknown>;
    delete withoutAudio.hasAudio;
    expect(normalizeSyntheticXMetadata(IDENTITY, JSON.stringify(withoutAudio))).not.toHaveProperty("hasAudio");
  });

  it.each([
    ["photo", API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED],
    ["image", API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED],
    ["mixed_media", API_ERROR_CODES.MULTI_ITEM_POST_NOT_SUPPORTED],
    ["multi_item", API_ERROR_CODES.MULTI_ITEM_POST_NOT_SUPPORTED],
    ["multi_video", API_ERROR_CODES.MULTI_ITEM_POST_NOT_SUPPORTED],
    ["external_media", API_ERROR_CODES.EXTERNAL_MEDIA_NOT_SUPPORTED],
    ["live", API_ERROR_CODES.LIVE_NOT_SUPPORTED],
    ["broadcast", API_ERROR_CODES.LIVE_NOT_SUPPORTED],
    ["space", API_ERROR_CODES.LIVE_NOT_SUPPORTED],
    ["text", API_ERROR_CODES.POST_HAS_NO_VIDEO],
    ["no_media", API_ERROR_CODES.POST_HAS_NO_VIDEO]
  ] as const)("maps unsupported content type %s safely", (contentType, code) => {
    expectCode({ contentType }, code);
  });

  it("rejects multi-video evidence independently of the content label", () => {
    expectCode({ singleVideo: false }, API_ERROR_CODES.MULTI_ITEM_POST_NOT_SUPPORTED);
  });

  it.each([
    ["external", "post"],
    ["x", "quoted"],
    ["x", "reposted"],
    ["x", "external"]
  ])("rejects external, quoted, or reposted media", (hosting, mediaOrigin) => {
    expectCode({ hosting, mediaOrigin }, API_ERROR_CODES.EXTERNAL_MEDIA_NOT_SUPPORTED);
  });

  it.each([
    ["private", API_ERROR_CODES.PRIVATE_CONTENT],
    ["protected", API_ERROR_CODES.PRIVATE_CONTENT],
    ["login_required", API_ERROR_CODES.LOGIN_REQUIRED],
    ["removed", API_ERROR_CODES.CONTENT_UNAVAILABLE],
    ["unavailable", API_ERROR_CODES.CONTENT_UNAVAILABLE],
    ["age_restricted", API_ERROR_CODES.AGE_RESTRICTED],
    ["region_restricted", API_ERROR_CODES.REGION_RESTRICTED],
    ["withheld", API_ERROR_CODES.REGION_RESTRICTED],
    ["rate_limited", API_ERROR_CODES.RATE_LIMITED],
    ["challenge", API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE],
    ["captcha", API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE]
  ] as const)("maps availability %s safely", (availability, code) => {
    expectCode({ availability }, code);
  });

  it("fails closed on malformed, multiple, mismatched, unknown, deep, and oversized shapes", () => {
    expect(() => normalizeSyntheticXMetadata(IDENTITY, "{broken"))
      .toThrowError(expect.objectContaining({ code: API_ERROR_CODES.EXTRACTOR_FAILED }));
    expect(() => normalizeSyntheticXMetadata(IDENTITY, `[${metadata()}]`))
      .toThrowError(expect.objectContaining({ code: API_ERROR_CODES.EXTRACTOR_FAILED }));
    expectCode({ postId: "700000000000000002" }, API_ERROR_CODES.EXTRACTOR_FAILED);
    expectCode({ diagnostic: "raw runtime output" }, API_ERROR_CODES.EXTRACTOR_FAILED);

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 66; index += 1) {
      const nested: Record<string, unknown> = {};
      cursor.nested = nested;
      cursor = nested;
    }
    expect(() => normalizeSyntheticXMetadata(IDENTITY, JSON.stringify(deep)))
      .toThrowError(expect.objectContaining({ code: API_ERROR_CODES.EXTRACTOR_FAILED }));
    expect(() => normalizeSyntheticXMetadata(IDENTITY, `{"padding":"${"x".repeat(4 * 1024 * 1024)}"}`))
      .toThrowError(expect.objectContaining({ code: API_ERROR_CODES.EXTRACTOR_FAILED }));
  });

  it.each([
    [{ durationSeconds: 0 }],
    [{ durationSeconds: 7 * 24 * 60 * 60 + 1 }],
    [{ durationSeconds: Number.NaN }],
    [{ width: 0 }],
    [{ height: 16_385 }],
    [{ width: 3840, height: 2161 }],
    [{ hasAudio: "unknown" }],
    [{ hosting: "unknown" }],
    [{ mediaOrigin: "unknown" }],
    [{ contentType: "unknown" }]
  ])("rejects invalid duration, geometry, or unknown classification: %j", (overrides) => {
    expectCode(overrides, API_ERROR_CODES.EXTRACTOR_FAILED);
  });

  it("never includes raw diagnostics, locators, tokens, identity, or internal paths in errors", () => {
    const raw = "stderr=/private/runtime signed=https://cdn.example/media guest_token=private-value";
    try {
      normalizeSyntheticXMetadata(IDENTITY, metadata({ diagnostic: raw }));
      throw new Error("expected normalization failure");
    } catch (error) {
      expect(error).toMatchObject({ code: API_ERROR_CODES.EXTRACTOR_FAILED });
      expect((error as Error).message).not.toContain(raw);
      expect((error as Error).message).not.toMatch(/700000000000000001|synthetic_user|cdn|guest_token|stderr|private\/runtime/i);
    }
  });
});
