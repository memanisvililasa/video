import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  canonicalizeTikTokVideoUrl,
  classifyTikTokUrl,
  supportsInternalTikTokUrl
} from "@/lib/extractors/tiktok-url";
import { API_ERROR_CODES } from "@/lib/types";

const VIDEO_ID = "7000000000000000001";

function expectCode(value: string, code: string = API_ERROR_CODES.UNSUPPORTED_URL): void {
  try {
    classifyTikTokUrl(new URL(value));
    throw new Error("Expected URL rejection.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  }
}

describe("internal TikTok URL identity", () => {
  it.each([
    `https://www.tiktok.com/@synthetic/video/${VIDEO_ID}`,
    `https://tiktok.com/@synthetic/video/${VIDEO_ID}`
  ])("canonicalizes a strict single-video URL: %s", (value) => {
    expect(canonicalizeTikTokVideoUrl(new URL(value))).toMatchObject({
      platform: "tiktok",
      videoId: VIDEO_ID,
      sourceKind: "video-page"
    });
    expect(canonicalizeTikTokVideoUrl(new URL(value)).canonicalUrl.toString())
      .toBe(`https://www.tiktok.com/@_/video/${VIDEO_ID}`);
  });

  it("removes tracking parameters and fragments", () => {
    const identity = canonicalizeTikTokVideoUrl(new URL(
      `https://www.tiktok.com/@synthetic/video/${VIDEO_ID}?is_copy_url=1&_t=synthetic#details`
    ));
    expect(identity.canonicalUrl.toString()).toBe(`https://www.tiktok.com/@_/video/${VIDEO_ID}`);
  });

  it("does not include the username in canonical identity", () => {
    const first = canonicalizeTikTokVideoUrl(new URL(`https://www.tiktok.com/@First.User/video/${VIDEO_ID}`));
    const second = canonicalizeTikTokVideoUrl(new URL(`https://www.tiktok.com/@second_user/video/${VIDEO_ID}`));
    expect(first).toEqual(second);
  });

  it.each([
    ["vm", "https://vm.tiktok.com/SynthCode/"],
    ["vt", "https://vt.tiktok.com/SynthCode/"]
  ])("classifies a %s short link without treating its code as video identity", (_label, value) => {
    expect(classifyTikTokUrl(new URL(value))).toMatchObject({
      platform: "tiktok",
      shortCode: "SynthCode",
      sourceKind: "short-link"
    });
  });

  it.each([
    `https://www.tiktok.com/@synthetic/video/123`,
    `https://www.tiktok.com/@synthetic/video/${VIDEO_ID}0extra`,
    "https://www.tiktok.com/@synthetic",
    "https://www.tiktok.com/search?q=synthetic",
    "https://www.tiktok.com/tag/synthetic",
    "https://www.tiktok.com/music/synthetic-7000000000000000001",
    "https://www.tiktok.com/sound/synthetic-7000000000000000001",
    "https://www.tiktok.com/@synthetic/story/7000000000000000001",
    "https://www.tiktok.com/@synthetic/playlist/7000000000000000001",
    "https://www.tiktok.com/t/ZUnknown/",
    `http://www.tiktok.com/@synthetic/video/${VIDEO_ID}`,
    `https://user:password@www.tiktok.com/@synthetic/video/${VIDEO_ID}`,
    `https://www.tiktok.com:444/@synthetic/video/${VIDEO_ID}`,
    `https://tiktok.com.attacker.example/@synthetic/video/${VIDEO_ID}`,
    `https://127.0.0.1/@synthetic/video/${VIDEO_ID}`,
    `https://www.tiktok.com/@synthetic/video/${VIDEO_ID}?unexpected=value`,
    `https://www.tiktok.com/@synthetic/video/${VIDEO_ID}?_t=one&_T=two`
  ])("rejects an out-of-scope or unsafe URL: %s", (value) => {
    expectCode(value);
    expect(supportsInternalTikTokUrl(new URL(value))).toBe(false);
  });

  it.each([
    ["https://www.tiktok.com/@synthetic/live", API_ERROR_CODES.LIVE_NOT_SUPPORTED],
    ["https://www.tiktok.com/live", API_ERROR_CODES.LIVE_NOT_SUPPORTED],
    ["https://www.tiktok.com/@synthetic/photo/7000000000000000001", API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED],
    ["https://www.tiktok.com/@synthetic/carousel/7000000000000000001", API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED]
  ])("maps a known non-video page precisely: %s", (value, code) => {
    expectCode(value, code);
  });
});
