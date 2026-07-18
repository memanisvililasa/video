import { describe, expect, it, vi } from "vitest";
import { API_ERROR_MESSAGES, API_ERROR_STATUS, AppError } from "@/lib/errors";
import {
  createRedditMetadataProvider,
  type RedditBodyFetcher
} from "@/lib/extractors/reddit-metadata";
import { redactValue, REDACTED_VALUE } from "@/lib/observability/redaction";
import type { SafeBodyFetchResult } from "@/lib/http/safe-fetch";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";

const POST_ID = "abc123";
const POST_URL = new URL(`https://www.reddit.com/r/videos/comments/${POST_ID}/synthetic_post/`);

function redditVideo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fallback_url: "https://v.redd.it/media42/DASH_720.mp4",
    dash_url: "https://v.redd.it/media42/DASHPlaylist.mpd",
    hls_url: "https://v.redd.it/media42/HLSPlaylist.m3u8",
    duration: 12,
    has_audio: true,
    width: 1280,
    height: 720,
    ...overrides
  };
}

function post(overrides: Record<string, unknown> = {}, videoOverrides: Record<string, unknown> = {}): unknown {
  const data = {
    id: POST_ID,
    title: "Synthetic Reddit video",
    is_video: true,
    is_reddit_media_domain: true,
    domain: "v.redd.it",
    over_18: false,
    secure_media: { reddit_video: redditVideo(videoOverrides) },
    url: `https://www.reddit.com/r/videos/comments/${POST_ID}/synthetic_post/`,
    ...overrides
  };
  return [{ kind: "Listing", data: { children: [{ kind: "t3", data }] } }];
}

function result(body: unknown, overrides: Partial<SafeBodyFetchResult> = {}): SafeBodyFetchResult {
  const encoded = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return {
    finalUrl: new URL(`https://www.reddit.com/comments/${POST_ID}/.json?raw_json=1&limit=1&depth=0`),
    statusCode: 200,
    headers: { "content-type": "application/json" },
    contentType: "application/json",
    contentLength: encoded.length,
    body: encoded,
    sizeBytes: encoded.length,
    ...overrides
  };
}

function provider(body: unknown, overrides: Partial<SafeBodyFetchResult> = {}) {
  const fetchBody = vi.fn<RedditBodyFetcher>(async () => result(body, overrides));
  return { fetchBody, metadata: createRedditMetadataProvider({ fetchBody }) };
}

async function expectCode(promise: Promise<unknown>, code: ApiErrorCode): Promise<AppError> {
  try {
    await promise;
    throw new Error("Expected Reddit metadata extraction to fail.");
  } catch (caught) {
    expect(caught).toBeInstanceOf(AppError);
    const appError = caught as AppError;
    expect(appError).toMatchObject({ code, message: API_ERROR_MESSAGES[code] });
    expect(appError.message).not.toMatch(/https?:\/\/|media42|DASH|raw_json|secret/i);
    return appError;
  }
}

describe("cookie-free Reddit product metadata provider", () => {
  it("returns only normalized product truth for a Reddit-hosted video", async () => {
    const { fetchBody, metadata } = provider(post());
    const extracted = await metadata.fetch(new URL(
      `https://old.reddit.com/r/videos/comments/${POST_ID}/different_slug/?utm_source=share#fragment`
    ));

    expect(extracted).toEqual({
      platform: "reddit",
      canonicalPostId: POST_ID,
      title: "Synthetic Reddit video",
      durationSeconds: 12,
      redditHostedVideo: true,
      hasAudio: true,
      sourceKind: "direct"
    });
    const serialized = JSON.stringify(extracted);
    expect(serialized).not.toMatch(/v\.redd\.it|DASH|HLS|fallback|manifest|thumbnail|url/i);
    expect(fetchBody).toHaveBeenCalledWith(
      new URL(`https://www.reddit.com/comments/${POST_ID}/.json?raw_json=1&limit=1&depth=0`),
      expect.objectContaining({
        maxBytes: 1024 * 1024,
        timeoutSeconds: 10,
        maxRedirects: 2,
        requireHttps: true,
        requestProfile: "reddit-public-v1",
        signal: undefined
      })
    );
    const options = fetchBody.mock.calls[0]?.[1];
    expect(options?.allowHostname?.("www.reddit.com")).toBe(true);
    expect(options?.allowHostname?.("old.reddit.com")).toBe(true);
    expect(options?.allowHostname?.("reddit.com.attacker.example")).toBe(false);
  });

  it("accepts one first-level Reddit-hosted crosspost without exposing media identity", async () => {
    const parent = {
      id: "parent42",
      is_video: true,
      is_reddit_media_domain: true,
      domain: "v.redd.it",
      secure_media: { reddit_video: redditVideo({ has_audio: false }) }
    };
    const { metadata } = provider(post({
      is_video: false,
      is_reddit_media_domain: false,
      domain: "reddit.com",
      secure_media: null,
      crosspost_parent_list: [parent]
    }));
    await expect(metadata.fetch(POST_URL)).resolves.toEqual(expect.objectContaining({
      canonicalPostId: POST_ID,
      redditHostedVideo: true,
      hasAudio: false,
      sourceKind: "crosspost"
    }));
  });

  it.each([
    ["external", { secure_media: null, is_video: false, is_reddit_media_domain: false, domain: "youtube.com", url_overridden_by_dest: "https://www.youtube.com/watch?v=synthetic" }, API_ERROR_CODES.EXTERNAL_MEDIA_NOT_SUPPORTED],
    ["gallery", { secure_media: null, is_video: false, is_gallery: true, gallery_data: {} }, API_ERROR_CODES.GALLERY_NOT_SUPPORTED],
    ["image", { secure_media: null, is_video: false, domain: "i.redd.it", post_hint: "image", url: "https://i.redd.it/synthetic.png" }, API_ERROR_CODES.POST_HAS_NO_VIDEO],
    ["text", { secure_media: null, is_video: false, is_self: true, domain: "self.videos" }, API_ERROR_CODES.POST_HAS_NO_VIDEO],
    ["live", { secure_media: null, is_video: false, is_live: true }, API_ERROR_CODES.LIVE_NOT_SUPPORTED],
    ["removed", { removed_by_category: "moderator" }, API_ERROR_CODES.CONTENT_UNAVAILABLE],
    ["deleted", { title: "[deleted]" }, API_ERROR_CODES.CONTENT_UNAVAILABLE],
    ["private", { subreddit_type: "private" }, API_ERROR_CODES.PRIVATE_CONTENT],
    ["quarantined", { quarantine: true }, API_ERROR_CODES.LOGIN_REQUIRED],
    ["age-gated", { over_18: true }, API_ERROR_CODES.AGE_RESTRICTED]
  ] as const)("maps a %s post without leaking metadata", async (_label, overrides, code) => {
    const { metadata } = provider(post({ ...overrides }));
    await expectCode(metadata.fetch(POST_URL), code);
  });

  it.each([
    [401, API_ERROR_CODES.LOGIN_REQUIRED, undefined],
    [403, API_ERROR_CODES.PRIVATE_CONTENT, { reason: "private" }],
    [404, API_ERROR_CODES.CONTENT_UNAVAILABLE, undefined],
    [429, API_ERROR_CODES.RATE_LIMITED, undefined],
    [503, API_ERROR_CODES.EXTRACTOR_FAILED, undefined]
  ] as const)("maps upstream HTTP %s safely", async (statusCode, code, body) => {
    const responseBody = body ?? { error: statusCode };
    const { metadata } = provider(responseBody, { statusCode });
    await expectCode(metadata.fetch(POST_URL), code);
  });

  it("rejects malformed, oversized, wrong-type, and identity-mismatched responses", async () => {
    await expectCode(provider("{broken").metadata.fetch(POST_URL), API_ERROR_CODES.EXTRACTOR_FAILED);
    await expectCode(
      provider(`{"padding":"${"x".repeat(1024 * 1024)}"}`).metadata.fetch(POST_URL),
      API_ERROR_CODES.EXTRACTOR_FAILED
    );
    await expectCode(
      provider(post(), { contentType: "text/html", headers: { "content-type": "text/html" } }).metadata.fetch(POST_URL),
      API_ERROR_CODES.EXTRACTOR_FAILED
    );
    await expectCode(provider(post({ id: "other42" })).metadata.fetch(POST_URL), API_ERROR_CODES.EXTRACTOR_FAILED);
  });

  it("rejects unsafe or inconsistent Reddit media boundaries", async () => {
    await expectCode(
      provider(post({}, { fallback_url: "https://media.example.test/media42/DASH_720.mp4" })).metadata.fetch(POST_URL),
      API_ERROR_CODES.EXTRACTOR_FAILED
    );
    await expectCode(
      provider(post({}, { dash_url: "https://v.redd.it/other42/DASHPlaylist.mpd" })).metadata.fetch(POST_URL),
      API_ERROR_CODES.EXTRACTOR_FAILED
    );
  });

  it("sanitizes timeout, abort, redirect, and private-address failures", async () => {
    for (const [caught, code] of [
      [new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "timeout https://www.reddit.com/secret", 504), API_ERROR_CODES.EXTRACTOR_TIMEOUT],
      [new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "aborted raw response"), API_ERROR_CODES.EXTRACTOR_FAILED],
      [new AppError(API_ERROR_CODES.DOWNLOAD_FAILED, "redirect https://attacker.example/secret"), API_ERROR_CODES.EXTRACTOR_FAILED],
      [new AppError(API_ERROR_CODES.PRIVATE_OR_LOCAL_URL, "127.0.0.1"), API_ERROR_CODES.PRIVATE_OR_LOCAL_URL]
    ] as const) {
      const fetchBody = vi.fn<RedditBodyFetcher>(async () => { throw caught; });
      await expectCode(createRedditMetadataProvider({ fetchBody }).fetch(POST_URL), code);
    }
  });

  it("redacts source URLs and raw payload-shaped metadata from structured logs", () => {
    expect(redactValue({
      sourceUrl: `https://www.reddit.com/r/videos/comments/${POST_ID}/secret_slug/`,
      payload: post(),
      safe: "reddit"
    })).toEqual({ payload: REDACTED_VALUE, safe: "reddit", sourceUrl: REDACTED_VALUE });
  });

  it("registers short safe messages and 422 statuses for additive product-truth errors", () => {
    for (const code of [
      API_ERROR_CODES.EXTERNAL_MEDIA_NOT_SUPPORTED,
      API_ERROR_CODES.POST_HAS_NO_VIDEO,
      API_ERROR_CODES.GALLERY_NOT_SUPPORTED,
      API_ERROR_CODES.SOURCE_HAS_NO_AUDIO
    ]) {
      expect(API_ERROR_STATUS[code]).toBe(422);
      expect(API_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
      expect(API_ERROR_MESSAGES[code]).not.toMatch(/https?:\/\/|reddit\.com|v\.redd\.it|DASH|HLS/i);
    }
  });
});
