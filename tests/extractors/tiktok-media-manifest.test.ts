import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { parseTikTokMediaManifest } from "@/lib/extractors/tiktok-media-manifest";
import {
  isTikTokMediaHostname,
  TIKTOK_MEDIA_HOSTS,
  validateTikTokMediaLocator
} from "@/lib/extractors/tiktok-media-policy";
import { canonicalizeTikTokVideoUrl } from "@/lib/extractors/tiktok-url";
import {
  SYNTHETIC_TIKTOK_EXPIRE,
  SYNTHETIC_TIKTOK_NOW_MS,
  SYNTHETIC_TIKTOK_OTHER_VIDEO_ID,
  SYNTHETIC_TIKTOK_VIDEO_ID,
  syntheticTikTokLocator,
  syntheticTikTokMediaPage
} from "@/tests/fixtures/tiktok-media";
import { API_ERROR_CODES } from "@/lib/types";

const IDENTITY = canonicalizeTikTokVideoUrl(
  new URL(`https://www.tiktok.com/@synthetic/video/${SYNTHETIC_TIKTOK_VIDEO_ID}`)
);

function parse(body = syntheticTikTokMediaPage(), nowMs = SYNTHETIC_TIKTOK_NOW_MS) {
  return parseTikTokMediaManifest(IDENTITY, body, { nowMs, maxFileSizeBytes: 10 * 1024 * 1024 });
}

function safeCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("Expected TikTok manifest failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code });
    expect((error as Error).message).not.toMatch(/https?:\/\/|7000000000000000001|signature|expire=/i);
  }
}

describe("Stage 8.10B TikTok progressive media manifest", () => {
  it("extracts one opaque progressive format and keeps every locator server-only", () => {
    const manifest = parse();
    expect(manifest.formats).toHaveLength(1);
    const resolved = manifest.formats[0];
    expect(resolved.descriptor).toMatchObject({
      id: expect.stringMatching(/^ttf_[A-Za-z0-9_-]{43}$/),
      kind: "progressive",
      container: "mp4",
      codecFamily: "h264",
      width: 576,
      height: 1024,
      fps: 30,
      approximateBitrate: 2_000_000,
      estimatedSizeBytes: 3_000_000,
      audioPresence: "present",
      staleMarker: "fresh"
    });
    expect(resolved.locatorReferences.map((item) => item.locator.hostname)).toEqual([
      "v16-webapp-prime.tiktok.com",
      "v19-webapp-prime.tiktok.com"
    ]);
    expect(JSON.stringify(resolved.descriptor)).not.toMatch(/https?:\/\/|tiktok\.com|expire|signature|7000000000000000001/i);
  });

  it("keeps format identity stable across fresh signed locator values", () => {
    const first = parse().formats[0].descriptor.id;
    const second = parse(syntheticTikTokMediaPage({
      locators: [syntheticTikTokLocator("v16-webapp-prime.tiktok.com", SYNTHETIC_TIKTOK_EXPIRE + 10, "fresh")]
    })).formats[0].descriptor.id;
    expect(second).toBe(first);
  });

  it("uses only the two exact media hosts and ignores the known broken page-host locator", () => {
    expect(TIKTOK_MEDIA_HOSTS).toEqual([
      "v16-webapp-prime.tiktok.com",
      "v19-webapp-prime.tiktok.com"
    ]);
    for (const hostname of TIKTOK_MEDIA_HOSTS) expect(isTikTokMediaHostname(hostname)).toBe(true);
    for (const hostname of [
      "www.tiktok.com",
      "v16-webapp-prime.tiktok.com.attacker.example",
      "sub.v16-webapp-prime.tiktok.com",
      "tiktok.com",
      "127.0.0.1"
    ]) expect(isTikTokMediaHostname(hostname)).toBe(false);
  });

  it.each([
    ["unknown host", syntheticTikTokLocator("media.example.test"), API_ERROR_CODES.DOWNLOAD_FAILED],
    ["lookalike host", syntheticTikTokLocator("v16-webapp-prime.tiktok.com.attacker.example"), API_ERROR_CODES.DOWNLOAD_FAILED],
    ["IP literal", syntheticTikTokLocator("127.0.0.1"), API_ERROR_CODES.DOWNLOAD_FAILED]
  ])("rejects %s fail-closed", (_label, locator, code) => {
    safeCode(() => parse(syntheticTikTokMediaPage({ locators: [locator] })), code);
  });

  it.each([
    ["missing", "https://v16-webapp-prime.tiktok.com/synthetic/video.mp4", API_ERROR_CODES.DOWNLOAD_FAILED],
    ["malformed", syntheticTikTokLocator("v16-webapp-prime.tiktok.com", "bad"), API_ERROR_CODES.DOWNLOAD_FAILED],
    ["expired", syntheticTikTokLocator("v16-webapp-prime.tiktok.com", 1_899_899_999), API_ERROR_CODES.SOURCE_EXPIRED],
    ["inside safety window", syntheticTikTokLocator("v16-webapp-prime.tiktok.com", 1_899_900_020), API_ERROR_CODES.SOURCE_EXPIRED]
  ])("rejects %s expiry", (_label, locator, code) => {
    safeCode(() => parse(syntheticTikTokMediaPage({ locators: [locator] })), code);
  });

  it.each([
    ["credentials", `https://user:secret@v16-webapp-prime.tiktok.com/synthetic/video.mp4?expire=${SYNTHETIC_TIKTOK_EXPIRE}`],
    ["custom port", `https://v16-webapp-prime.tiktok.com:444/synthetic/video.mp4?expire=${SYNTHETIC_TIKTOK_EXPIRE}`],
    ["HTTP", `http://v16-webapp-prime.tiktok.com/synthetic/video.mp4?expire=${SYNTHETIC_TIKTOK_EXPIRE}`]
  ])("rejects %s transport", (_label, locator) => {
    safeCode(() => validateTikTokMediaLocator(new URL(locator), SYNTHETIC_TIKTOK_NOW_MS), API_ERROR_CODES.DOWNLOAD_FAILED);
  });

  it("rejects identity drift", () => {
    safeCode(() => parse(syntheticTikTokMediaPage({ videoId: SYNTHETIC_TIKTOK_OTHER_VIDEO_ID })), API_ERROR_CODES.EXTRACTOR_FAILED);
  });

  it.each([
    ["HLS", { hlsManifest: "synthetic" }],
    ["DASH", { dashInfo: { synthetic: true } }],
    ["video-only", { videoOnly: { synthetic: true } }],
    ["audio-only", { audio_only: { synthetic: true } }]
  ])("rejects %s topology", (_label, videoOverrides) => {
    safeCode(
      () => parse(syntheticTikTokMediaPage({ videoOverrides })),
      API_ERROR_CODES.NO_SUPPORTED_FORMAT
    );
  });

  it.each([
    ["HLS locator", `https://v16-webapp-prime.tiktok.com/synthetic/video.m3u8?expire=${SYNTHETIC_TIKTOK_EXPIRE}`],
    ["DASH locator", `https://v16-webapp-prime.tiktok.com/synthetic/video.mpd?expire=${SYNTHETIC_TIKTOK_EXPIRE}`]
  ])("rejects direct %s", (_label, locator) => {
    safeCode(
      () => parse(syntheticTikTokMediaPage({ locators: [locator] })),
      API_ERROR_CODES.NO_SUPPORTED_FORMAT
    );
  });

  it.each([
    ["photo", { imagePost: {} }, API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED],
    ["live", { isLive: true }, API_ERROR_CODES.LIVE_NOT_SUPPORTED],
    ["multi-item", { isMultiItem: true }, API_ERROR_CODES.MULTI_ITEM_POST_NOT_SUPPORTED]
  ])("preserves safe %s classification", (_label, itemOverrides, code) => {
    safeCode(() => parse(syntheticTikTokMediaPage({ itemOverrides })), code);
  });
});
