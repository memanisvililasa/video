import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  canonicalizeInstagramContentUrl,
  classifyInstagramUrl,
  supportsInternalInstagramUrl
} from "@/lib/extractors/instagram-url";
import { API_ERROR_CODES } from "@/lib/types";

const SHORTCODE = "Synth_01";

function expectCode(value: string, code: string = API_ERROR_CODES.UNSUPPORTED_URL): void {
  try {
    classifyInstagramUrl(new URL(value));
    throw new Error("Expected URL rejection.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    expect((error as Error).message).not.toContain(SHORTCODE);
  }
}

describe("internal Instagram URL identity", () => {
  it.each([
    `https://www.instagram.com/reel/${SHORTCODE}/`,
    `https://instagram.com/reel/${SHORTCODE}`
  ])("canonicalizes a strict Reel candidate URL: %s", (value) => {
    const identity = canonicalizeInstagramContentUrl(new URL(value));
    expect(identity).toMatchObject({
      platform: "instagram",
      shortcode: SHORTCODE,
      sourceKind: "reel"
    });
    expect(identity.canonicalUrl.toString()).toBe(`https://www.instagram.com/reel/${SHORTCODE}/`);
  });

  it.each([
    `https://www.instagram.com/p/${SHORTCODE}/`,
    `https://instagram.com/p/${SHORTCODE}`
  ])("canonicalizes a strict video-post candidate URL: %s", (value) => {
    const identity = canonicalizeInstagramContentUrl(new URL(value));
    expect(identity).toMatchObject({
      platform: "instagram",
      shortcode: SHORTCODE,
      sourceKind: "video-post"
    });
    expect(identity.canonicalUrl.toString()).toBe(`https://www.instagram.com/p/${SHORTCODE}/`);
  });

  it("removes bounded tracking parameters and fragments without changing identity", () => {
    const plain = canonicalizeInstagramContentUrl(new URL(`https://www.instagram.com/reel/${SHORTCODE}/`));
    const shared = canonicalizeInstagramContentUrl(new URL(
      `https://instagram.com/reel/${SHORTCODE}?igsh=synthetic&utm_source=fixture#details`
    ));
    expect(shared.shortcode).toBe(plain.shortcode);
    expect(shared.sourceKind).toBe(plain.sourceKind);
    expect(shared.canonicalUrl.toString()).toBe(plain.canonicalUrl.toString());
  });

  it("keeps the route type as classification while shortcode remains the identity", () => {
    const reel = canonicalizeInstagramContentUrl(new URL(`https://instagram.com/reel/${SHORTCODE}/`));
    const post = canonicalizeInstagramContentUrl(new URL(`https://instagram.com/p/${SHORTCODE}/`));
    expect(reel.shortcode).toBe(post.shortcode);
    expect(reel.sourceKind).toBe("reel");
    expect(post.sourceKind).toBe("video-post");
  });

  it.each([
    `https://www.instagram.com/reel/a/`,
    `https://www.instagram.com/reel/${"a".repeat(29)}/`,
    "https://www.instagram.com/reel/bad.code/",
    "https://www.instagram.com/synthetic_profile/",
    "https://www.instagram.com/highlights/fixture/",
    "https://www.instagram.com/explore/",
    "https://www.instagram.com/explore/search/keyword/",
    "https://www.instagram.com/explore/tags/fixture/",
    "https://www.instagram.com/reels/audio/fixture/",
    "https://www.instagram.com/direct/inbox/",
    "https://www.instagram.com/accounts/login/",
    "https://www.instagram.com/challenge/",
    "https://www.instagram.com/collections/fixture/",
    `https://www.instagram.com/tv/${SHORTCODE}/`,
    `https://www.instagram.com/p/${SHORTCODE}/embed/`,
    `https://www.instagram.com/p/${SHORTCODE}/?img_index=1`,
    `https://www.instagram.com/reel/${SHORTCODE}/?unknown=value`,
    `https://www.instagram.com/reel/${SHORTCODE}/?igsh=one&IGSH=two`,
    `http://www.instagram.com/reel/${SHORTCODE}/`,
    `https://user:password@www.instagram.com/reel/${SHORTCODE}/`,
    `https://www.instagram.com:444/reel/${SHORTCODE}/`,
    `https://instagram.com.attacker.example/reel/${SHORTCODE}/`,
    `https://127.0.0.1/reel/${SHORTCODE}/`
  ])("rejects an out-of-scope or unsafe URL: %s", (value) => {
    expectCode(value);
    expect(supportsInternalInstagramUrl(new URL(value))).toBe(false);
  });

  it.each([
    ["https://www.instagram.com/stories/synthetic_profile/Synth_02/", API_ERROR_CODES.STORY_NOT_SUPPORTED],
    ["https://www.instagram.com/live/", API_ERROR_CODES.LIVE_NOT_SUPPORTED]
  ])("maps a known unsupported content route precisely: %s", (value, code) => {
    expectCode(value, code);
  });
});
