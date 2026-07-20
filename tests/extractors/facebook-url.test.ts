import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  canonicalizeFacebookContentUrl,
  classifyFacebookUrl,
  supportsInternalFacebookUrl
} from "@/lib/extractors/facebook-url";
import { API_ERROR_CODES } from "@/lib/types";

const CONTENT_ID = "700000000000001";

function expectCode(value: string, code: string = API_ERROR_CODES.UNSUPPORTED_URL): void {
  try {
    classifyFacebookUrl(new URL(value));
    throw new Error("Expected URL rejection.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    expect((error as Error).message).not.toMatch(/700000000000001|fixture\.page|SynthCode/i);
  }
}

describe("internal Facebook URL identity", () => {
  it.each([
    `https://www.facebook.com/watch/?v=${CONTENT_ID}`,
    `https://facebook.com/watch?v=${CONTENT_ID}`,
    `https://m.facebook.com/watch/?v=${CONTENT_ID}`,
    `https://web.facebook.com/watch/?v=${CONTENT_ID}`
  ])("canonicalizes a strict watch candidate URL: %s", (value) => {
    const identity = canonicalizeFacebookContentUrl(new URL(value));
    expect(identity).toMatchObject({ platform: "facebook", contentId: CONTENT_ID, sourceKind: "video" });
    expect(identity.canonicalUrl.toString()).toBe(`https://www.facebook.com/watch/?v=${CONTENT_ID}`);
  });

  it.each([
    `https://www.facebook.com/fixture.page/videos/${CONTENT_ID}/`,
    `https://facebook.com/fixture-page/videos/${CONTENT_ID}`,
    `https://m.facebook.com/fixture_page/videos/${CONTENT_ID}/`,
    `https://web.facebook.com/fixture.page/videos/${CONTENT_ID}`
  ])("canonicalizes a strict page video candidate without trusting its slug: %s", (value) => {
    const identity = canonicalizeFacebookContentUrl(new URL(value));
    expect(identity.sourceKind).toBe("video");
    expect(identity.contentId).toBe(CONTENT_ID);
    expect(identity.canonicalUrl.toString()).toBe(`https://www.facebook.com/watch/?v=${CONTENT_ID}`);
  });

  it.each([
    `https://www.facebook.com/reel/${CONTENT_ID}/`,
    `https://facebook.com/reel/${CONTENT_ID}`,
    `https://m.facebook.com/reel/${CONTENT_ID}/`,
    `https://web.facebook.com/reel/${CONTENT_ID}`
  ])("canonicalizes a strict Reel candidate URL: %s", (value) => {
    const identity = canonicalizeFacebookContentUrl(new URL(value));
    expect(identity).toMatchObject({ platform: "facebook", contentId: CONTENT_ID, sourceKind: "reel" });
    expect(identity.canonicalUrl.toString()).toBe(`https://www.facebook.com/reel/${CONTENT_ID}/`);
  });

  it("removes bounded tracking parameters and fragments without changing identity", () => {
    const plain = canonicalizeFacebookContentUrl(new URL(`https://www.facebook.com/watch/?v=${CONTENT_ID}`));
    const shared = canonicalizeFacebookContentUrl(new URL(
      `https://m.facebook.com/watch/?v=${CONTENT_ID}&fbclid=fixture&mibextid=fixture#details`
    ));
    expect(shared.contentId).toBe(plain.contentId);
    expect(shared.canonicalUrl.toString()).toBe(plain.canonicalUrl.toString());
  });

  it("keeps route type as classification while the numeric identifier remains identity", () => {
    const video = canonicalizeFacebookContentUrl(new URL(`https://facebook.com/fixture/videos/${CONTENT_ID}/`));
    const reel = canonicalizeFacebookContentUrl(new URL(`https://facebook.com/reel/${CONTENT_ID}/`));
    expect(video.contentId).toBe(reel.contentId);
    expect(video.sourceKind).toBe("video");
    expect(reel.sourceKind).toBe("reel");
  });

  it("classifies fb.watch only as an unresolved short link", () => {
    const identity = classifyFacebookUrl(new URL("https://fb.watch/Synth_Code/?fbclid=fixture#details"));
    expect(identity).toMatchObject({ platform: "facebook", shortCode: "Synth_Code", sourceKind: "short-link" });
    if (identity.sourceKind !== "short-link") throw new Error("Expected short-link identity.");
    expect(identity.url.toString()).toBe("https://fb.watch/Synth_Code/");
    expect(() => canonicalizeFacebookContentUrl(identity.url)).toThrowError(expect.objectContaining({
      code: API_ERROR_CODES.UNSUPPORTED_URL
    }));
  });

  it.each([
    `https://www.facebook.com/watch/?v=12345`,
    `https://www.facebook.com/watch/?v=${"7".repeat(26)}`,
    "https://www.facebook.com/watch/",
    `https://www.facebook.com/watch/?v=${CONTENT_ID}&V=${CONTENT_ID}`,
    `https://www.facebook.com/watch/?v=${CONTENT_ID}&unknown=value`,
    `https://www.facebook.com/fixture/videos/${CONTENT_ID}/extra`,
    `https://www.facebook.com/bad%20slug/videos/${CONTENT_ID}/`,
    "https://www.facebook.com/fixture.page/",
    "https://www.facebook.com/marketplace/",
    "https://www.facebook.com/playlist/fixture/",
    "https://www.facebook.com/posts/pfbidSynthetic",
    "https://www.facebook.com/plugins/video.php?href=fixture",
    "https://en-gb.facebook.com/watch/?v=700000000000001",
    `http://www.facebook.com/watch/?v=${CONTENT_ID}`,
    `https://user:password@www.facebook.com/watch/?v=${CONTENT_ID}`,
    `https://www.facebook.com:444/watch/?v=${CONTENT_ID}`,
    `https://facebook.com.attacker.example/watch/?v=${CONTENT_ID}`,
    `https://127.0.0.1/watch/?v=${CONTENT_ID}`,
    "https://fb.watch/a/",
    "https://fb.watch/Synth.Code/"
  ])("rejects an out-of-scope or unsafe URL: %s", (value) => {
    expectCode(value);
    expect(supportsInternalFacebookUrl(new URL(value))).toBe(false);
  });

  it.each([
    ["https://www.facebook.com/groups/fixture/videos/700000000000001/", API_ERROR_CODES.GROUP_CONTENT_NOT_SUPPORTED],
    ["https://www.facebook.com/stories/fixture/700000000000001/", API_ERROR_CODES.STORY_NOT_SUPPORTED],
    ["https://www.facebook.com/live/", API_ERROR_CODES.LIVE_NOT_SUPPORTED],
    ["https://www.facebook.com/photos/fixture/", API_ERROR_CODES.IMAGE_POST_NOT_SUPPORTED],
    ["https://www.facebook.com/login/", API_ERROR_CODES.LOGIN_REQUIRED],
    ["https://www.facebook.com/checkpoint/fixture/", API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE],
    ["https://www.facebook.com/challenge/fixture/", API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE]
  ])("maps a known unsupported content route precisely: %s", (value, code) => {
    expectCode(value, code);
  });
});
