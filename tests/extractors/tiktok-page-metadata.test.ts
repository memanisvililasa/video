import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import {
  createTikTokPageMetadataProvider,
  type TikTokPageBodyFetcher
} from "@/lib/extractors/tiktok-page-metadata";
import { canonicalizeTikTokVideoUrl } from "@/lib/extractors/tiktok-url";
import { parseTikTokHydrationMetadata } from "@/lib/extractors/tiktok-metadata";
import type { SafeBodyFetchResult } from "@/lib/http/safe-fetch";
import { API_ERROR_CODES } from "@/lib/types";

const VIDEO_ID = "7000000000000000001";
const OTHER_VIDEO_ID = "7000000000000000002";
const CANONICAL_URL = new URL(`https://www.tiktok.com/@_/video/${VIDEO_ID}`);
const IDENTITY = canonicalizeTikTokVideoUrl(CANONICAL_URL);

function universalHtml(
  itemOverrides: Record<string, unknown> = {},
  detailOverrides: Record<string, unknown> = {}
): string {
  const item = {
    id: VIDEO_ID,
    desc: "Synthetic public video",
    contentType: "video",
    video: {
      duration: 12,
      width: 1080,
      height: 1920,
      hasAudio: true,
      playAddr: "https://media.example/signed.mp4?token=must-not-escape",
      cover: "https://image.example/cover.jpeg"
    },
    ...itemOverrides
  };
  const state = {
    __DEFAULT_SCOPE__: {
      "webapp.video-detail": {
        statusCode: 0,
        itemInfo: { itemStruct: item },
        ...detailOverrides
      }
    }
  };
  return `<!doctype html><html><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(state)}</script></body></html>`;
}

function result(
  html = universalHtml(),
  overrides: Partial<SafeBodyFetchResult> = {}
): SafeBodyFetchResult {
  const body = Buffer.from(html);
  return {
    finalUrl: CANONICAL_URL,
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    contentType: "text/html",
    contentLength: body.length,
    body,
    sizeBytes: body.length,
    ...overrides
  };
}

function provider(fetchBody: TikTokPageBodyFetcher) {
  return createTikTokPageMetadataProvider({ fetchBody });
}

async function expectSafeCode(operation: Promise<unknown>, code: string): Promise<void> {
  try {
    await operation;
    throw new Error("Expected restricted metadata failure.");
  } catch (caught) {
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ code });
    expect((caught as Error).message).not.toMatch(/https?:\/\/|signed|token|7000000000000000001/i);
  }
}

describe("restricted TikTok page metadata adapter", () => {
  it("uses only the canonical page and fixed bounded safe-fetch policy", async () => {
    const fetchBody = vi.fn<TikTokPageBodyFetcher>(async () => result());
    const metadata = await provider(fetchBody).fetch(
      new URL(`https://m.tiktok.com/@creator/video/${VIDEO_ID}?_t=tracking`)
    );
    expect(metadata).toEqual({
      platform: "tiktok",
      videoId: VIDEO_ID,
      title: "Synthetic public video",
      description: "Synthetic public video",
      durationSeconds: 12,
      width: 1080,
      height: 1920,
      orientation: "portrait",
      aspectRatio: { width: 9, height: 16 },
      hasAudio: true,
      singleVideo: true
    });
    expect(JSON.stringify(metadata)).not.toMatch(/https?:\/\/|media\.example|image\.example|signed|token|playAddr|cover/i);
    expect(fetchBody).toHaveBeenCalledOnce();
    const [requestedUrl, options] = fetchBody.mock.calls[0]!;
    expect(requestedUrl).toEqual(CANONICAL_URL);
    expect(options).toMatchObject({
      maxBytes: 4 * 1024 * 1024,
      timeoutSeconds: 10,
      maxRedirects: 1,
      requireHttps: true,
      requestProfile: "tiktok-public-page-v1"
    });
    expect(options.allowHostname?.("www.tiktok.com")).toBe(true);
    expect(options.allowHostname?.("m.tiktok.com")).toBe(false);
    expect(options.allowHostname?.("www.tiktok.com.attacker.example")).toBe(false);
  });

  it("resolves a bounded short identity before the one page request", async () => {
    const fetchBody = vi.fn<TikTokPageBodyFetcher>(async () => result());
    const resolveShortLink = vi.fn(async () => IDENTITY);
    const adapter = createTikTokPageMetadataProvider({ fetchBody, resolveShortLink });
    const signal = new AbortController().signal;
    await adapter.fetch(new URL("https://www.tiktok.com/t/SynthCode/"), { signal });
    expect(resolveShortLink).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: "short-link",
      shortCode: "SynthCode"
    }), { signal });
    expect(fetchBody).toHaveBeenCalledOnce();
  });

  it("supports the bounded legacy SIGI_STATE hydration shape", () => {
    const state = {
      ItemModule: {
        [VIDEO_ID]: {
          id: VIDEO_ID,
          desc: "SIGI video",
          video: { duration: 8, width: 1920, height: 1080 }
        }
      }
    };
    const body = Buffer.from(`<script type='application/json' id='SIGI_STATE'>${JSON.stringify(state)}</script>`);
    expect(parseTikTokHydrationMetadata(IDENTITY, body)).toMatchObject({
      title: "SIGI video",
      orientation: "landscape",
      aspectRatio: { width: 16, height: 9 }
    });
  });

  it("rejects multiple legacy video records", async () => {
    const state = {
      ItemModule: {
        [VIDEO_ID]: {
          id: VIDEO_ID,
          desc: "Expected video",
          video: { duration: 8, width: 1080, height: 1920 }
        },
        [OTHER_VIDEO_ID]: {
          id: OTHER_VIDEO_ID,
          desc: "Unexpected second video",
          video: { duration: 9, width: 1080, height: 1920 }
        }
      }
    };
    const html = `<script type="application/json" id="SIGI_STATE">${JSON.stringify(state)}</script>`;
    await expectSafeCode(provider(async () => result(html)).fetch(CANONICAL_URL), API_ERROR_CODES.EXTRACTOR_FAILED);
  });

  it.each([
    ["zero duration", { video: { duration: 0, width: 1080, height: 1920 } }],
    ["negative duration", { video: { duration: -1, width: 1080, height: 1920 } }],
    ["zero width", { video: { duration: 8, width: 0, height: 1920 } }],
    ["oversized geometry", { video: { duration: 8, width: 16_384, height: 16_384 } }]
  ])("rejects invalid %s", async (_label, item) => {
    await expectSafeCode(provider(async () => result(universalHtml(item))).fetch(CANONICAL_URL), API_ERROR_CODES.EXTRACTOR_FAILED);
  });

  it.each([
    [401, API_ERROR_CODES.LOGIN_REQUIRED],
    [403, API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE],
    [404, API_ERROR_CODES.CONTENT_UNAVAILABLE],
    [410, API_ERROR_CODES.CONTENT_UNAVAILABLE],
    [429, API_ERROR_CODES.RATE_LIMITED],
    [451, API_ERROR_CODES.REGION_RESTRICTED]
  ])("maps HTTP %s without parsing or exposing the body", async (statusCode, code) => {
    await expectSafeCode(provider(async () => result("secret https://signed.example", { statusCode })).fetch(CANONICAL_URL), code);
  });

  it.each([
    ["private", { availability: "private" }, API_ERROR_CODES.PRIVATE_CONTENT],
    ["login", { loginRequired: true }, API_ERROR_CODES.LOGIN_REQUIRED],
    ["challenge", { challengeRequired: true }, API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE],
    ["rate limit", { rateLimited: true }, API_ERROR_CODES.RATE_LIMITED],
    ["region", { regionRestricted: true }, API_ERROR_CODES.REGION_RESTRICTED],
    ["age", { ageRestricted: true }, API_ERROR_CODES.AGE_RESTRICTED],
    ["removed", { removed: true }, API_ERROR_CODES.CONTENT_UNAVAILABLE],
    ["live", { isLive: true }, API_ERROR_CODES.LIVE_NOT_SUPPORTED],
    ["photo", { imagePost: {} }, API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED],
    ["slideshow", { contentType: "slideshow" }, API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED],
    ["multi item", { isMultiItem: true }, API_ERROR_CODES.MULTI_ITEM_POST_NOT_SUPPORTED]
  ])("fails closed for %s item state", async (_label, item, code) => {
    await expectSafeCode(provider(async () => result(universalHtml(item))).fetch(CANONICAL_URL), code);
  });

  it.each([
    ["private status", { statusCode: 10216, statusMsg: "author privacy settings" }, API_ERROR_CODES.PRIVATE_CONTENT],
    ["login status", { statusCode: 1, statusMsg: "login required" }, API_ERROR_CODES.LOGIN_REQUIRED],
    ["challenge status", { statusCode: 1, statusMsg: "verify challenge" }, API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE],
    ["rate status", { statusCode: 1, statusMsg: "too many requests" }, API_ERROR_CODES.RATE_LIMITED],
    ["missing status", { statusCode: 1, statusMsg: "video not found" }, API_ERROR_CODES.CONTENT_UNAVAILABLE]
  ])("maps %s from bounded hydration status", async (_label, detail, code) => {
    await expectSafeCode(provider(async () => result(universalHtml({}, detail))).fetch(CANONICAL_URL), code);
  });

  it.each([
    ["challenge page", "<html><main>Security check: verify-center captcha</main></html>", API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE],
    ["login wall", "<html><main>Log in to TikTok</main></html>", API_ERROR_CODES.LOGIN_REQUIRED],
    ["removed page", "<html><main>Couldn't find this video</main></html>", API_ERROR_CODES.CONTENT_UNAVAILABLE]
  ])("classifies a hydration-free %s safely", async (_label, html, code) => {
    await expectSafeCode(provider(async () => result(html)).fetch(CANONICAL_URL), code);
  });

  it("rejects malformed, duplicate, non-JSON and deeply nested hydration", async () => {
    const duplicate = `${universalHtml()}${universalHtml()}`;
    const wrongType = universalHtml().replace("application/json", "text/javascript");
    const malformed = "<script id='SIGI_STATE' type='application/json'>{broken</script>";
    const deep = `<script id='SIGI_STATE' type='application/json'>${"[".repeat(65)}0${"]".repeat(65)}</script>`;
    for (const html of [duplicate, wrongType, malformed, deep]) {
      await expectSafeCode(provider(async () => result(html)).fetch(CANONICAL_URL), API_ERROR_CODES.EXTRACTOR_FAILED);
    }
  });

  it("rejects identity drift, redirect drift, invalid content type and response-size drift", async () => {
    const cases = [
      result(universalHtml({ id: OTHER_VIDEO_ID })),
      result(undefined, { finalUrl: new URL(`https://www.tiktok.com/@_/video/${OTHER_VIDEO_ID}`) }),
      result(undefined, { contentType: "application/json" }),
      result(undefined, { sizeBytes: 1 })
    ];
    for (const response of cases) {
      await expectSafeCode(provider(async () => response).fetch(CANONICAL_URL), API_ERROR_CODES.EXTRACTOR_FAILED);
    }
  });

  it("rejects oversized output and invalid UTF-8 before JSON parsing", async () => {
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20);
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]);
    for (const body of [oversized, invalidUtf8]) {
      await expectSafeCode(provider(async () => result("x", {
        body,
        sizeBytes: body.length,
        contentLength: body.length
      })).fetch(CANONICAL_URL), API_ERROR_CODES.EXTRACTOR_FAILED);
    }
  });

  it("maps caller cancellation and transport failures without leaking raw details", async () => {
    const controller = new AbortController();
    const fetchBody = vi.fn<TikTokPageBodyFetcher>(async (_url, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("https://signed.example/?token=secret")), { once: true });
    }));
    const pending = provider(fetchBody).fetch(CANONICAL_URL, { signal: controller.signal });
    controller.abort();
    await expectSafeCode(pending, API_ERROR_CODES.JOB_CANCELLED);

    await expectSafeCode(provider(async () => {
      throw new Error("raw provider body https://signed.example/?token=secret");
    }).fetch(CANONICAL_URL), API_ERROR_CODES.EXTRACTOR_FAILED);
  });

  it("rejects timeout overrides that would widen the ten-second boundary before egress", async () => {
    const fetchBody = vi.fn<TikTokPageBodyFetcher>();
    await expect(provider(fetchBody).fetch(CANONICAL_URL, { metadataTimeoutSeconds: 11 })).rejects.toThrow(TypeError);
    expect(fetchBody).not.toHaveBeenCalled();
  });
});
