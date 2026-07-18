import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import {
  createRedditManifestProvider,
  createRedditSilentFallbackManifest,
  parseRedditDashManifest,
  type RedditManifestBodyFetcher
} from "@/lib/extractors/reddit-manifest";
import type { RedditMediaLocator } from "@/lib/extractors/reddit-metadata";
import type { SafeBodyFetchResult } from "@/lib/http/safe-fetch";
import { API_ERROR_CODES } from "@/lib/types";

const MEDIA_ID = "media42";
const MANIFEST_URL = new URL(`https://v.redd.it/${MEDIA_ID}/DASHPlaylist.mpd`);

async function fixture(): Promise<string> {
  return readFile(path.join(process.cwd(), "tests/fixtures/reddit-dash-synthetic.mpd"), "utf8");
}

function locator(overrides: Partial<RedditMediaLocator> = {}): RedditMediaLocator {
  return {
    mediaId: MEDIA_ID,
    fallbackUrl: new URL(`https://v.redd.it/${MEDIA_ID}/DASH_720.mp4`),
    dashManifestUrl: MANIFEST_URL,
    width: 1280,
    height: 720,
    bitrate: 2_400_000,
    ...overrides
  };
}

function response(body: string, overrides: Partial<SafeBodyFetchResult> = {}): SafeBodyFetchResult {
  const encoded = Buffer.from(body);
  return {
    finalUrl: MANIFEST_URL,
    statusCode: 200,
    headers: { "content-type": "application/dash+xml" },
    contentType: "application/dash+xml",
    contentLength: encoded.length,
    body: encoded,
    sizeBytes: encoded.length,
    ...overrides
  };
}

async function code(promise: Promise<unknown>, expected: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: expected });
  try {
    await promise;
  } catch (caught) {
    expect((caught as Error).message).not.toMatch(/v\.redd\.it|DASH|<MPD|media42|127\.0\.0\.1/i);
  }
}

describe("strict Reddit DASH manifest parser", () => {
  it("parses bounded split video/audio representations without publishing URLs", async () => {
    const parsed = parseRedditDashManifest(await fixture(), MANIFEST_URL, MEDIA_ID);
    expect(parsed).toMatchObject({ mediaId: MEDIA_ID, durationSeconds: 12 });
    expect(parsed.representations.map((item) => ({
      identity: item.identity,
      kind: item.kind,
      width: item.width,
      height: item.height,
      videoCodec: item.videoCodec,
      audioCodec: item.audioCodec
    }))).toEqual([
      { identity: "video-360", kind: "video", width: 640, height: 360, videoCodec: "h264", audioCodec: undefined },
      { identity: "video-720", kind: "video", width: 1280, height: 720, videoCodec: "h264", audioCodec: undefined },
      { identity: "audio-128", kind: "audio", width: undefined, height: undefined, videoCodec: undefined, audioCodec: "aac" }
    ]);
    expect(parsed.representations.every((item) => item.url.hostname === "v.redd.it")).toBe(true);
  });

  it("accepts a direct progressive MP4 representation", () => {
    const parsed = parseRedditDashManifest(`
      <MPD type="static" mediaPresentationDuration="PT3S"><Period duration="PT3S">
        <AdaptationSet mimeType="video/mp4" codecs="avc1.64001f,mp4a.40.2">
          <Representation id="progressive-720" bandwidth="2500000" width="1280" height="720" frameRate="30">
            <BaseURL>progressive.mp4?signature=synthetic</BaseURL>
          </Representation>
        </AdaptationSet>
      </Period></MPD>`, MANIFEST_URL, MEDIA_ID);
    expect(parsed.representations).toHaveLength(1);
    expect(parsed.representations[0]).toMatchObject({ kind: "progressive", videoCodec: "h264", audioCodec: "aac" });
  });

  it("accepts missing audio for later silent truth validation but rejects a manifest without video", () => {
    const silent = parseRedditDashManifest(
      "<MPD mediaPresentationDuration=\"PT1S\"><Period><AdaptationSet mimeType=\"video/mp4\" contentType=\"video\" codecs=\"avc1.1\"><Representation id=\"video\" bandwidth=\"1000\" width=\"64\" height=\"96\"><BaseURL>video.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>",
      MANIFEST_URL,
      MEDIA_ID
    );
    expect(silent.representations).toEqual([expect.objectContaining({ kind: "video" })]);
    expect(() => parseRedditDashManifest(
      "<MPD mediaPresentationDuration=\"PT1S\"><Period><AdaptationSet mimeType=\"audio/mp4\" contentType=\"audio\" codecs=\"mp4a.40.2\"><Representation id=\"audio\" bandwidth=\"1000\"><BaseURL>audio.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>",
      MANIFEST_URL,
      MEDIA_ID
    )).toThrowError(AppError);
  });

  it("accepts a direct silent fallback only with bounded structural metadata", () => {
    const parsed = createRedditSilentFallbackManifest(locator({ dashManifestUrl: undefined }), 12);
    expect(parsed.representations[0]).toMatchObject({
      identity: "fallback-video",
      kind: "video",
      videoCodec: "h264",
      width: 1280,
      height: 720
    });
    expect(() => createRedditSilentFallbackManifest(locator({ dashManifestUrl: undefined, bitrate: undefined }), 12))
      .toThrowError(AppError);
  });

  it.each([
    ["malformed", "<MPD><Period></MPD>"],
    ["DTD", "<!DOCTYPE MPD [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]><MPD></MPD>"],
    ["entity", "<MPD mediaPresentationDuration=\"PT1S\"><Period><BaseURL>&xxe;</BaseURL></Period></MPD>"],
    ["excessive nesting", `<MPD mediaPresentationDuration="PT1S">${"<Period>".repeat(20)}${"</Period>".repeat(20)}</MPD>`],
    ["external BaseURL", "<MPD mediaPresentationDuration=\"PT1S\"><Period><AdaptationSet mimeType=\"video/mp4\" contentType=\"video\" codecs=\"avc1.1\"><Representation id=\"v\" bandwidth=\"1\" width=\"2\" height=\"2\"><BaseURL>https://media.example.test/video.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>"],
    ["private IP BaseURL", "<MPD mediaPresentationDuration=\"PT1S\"><Period><AdaptationSet mimeType=\"video/mp4\" contentType=\"video\" codecs=\"avc1.1\"><Representation id=\"v\" bandwidth=\"1\" width=\"2\" height=\"2\"><BaseURL>https://127.0.0.1/video.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>"],
    ["invalid protocol", "<MPD mediaPresentationDuration=\"PT1S\"><Period><AdaptationSet mimeType=\"video/mp4\" contentType=\"video\" codecs=\"avc1.1\"><Representation id=\"v\" bandwidth=\"1\" width=\"2\" height=\"2\"><BaseURL>file:///tmp/video.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>"],
    ["unsafe codec", "<MPD mediaPresentationDuration=\"PT1S\"><Period><AdaptationSet mimeType=\"video/mp4\" contentType=\"video\" codecs=\"unknown\"><Representation id=\"v\" bandwidth=\"1\" width=\"2\" height=\"2\"><BaseURL>video.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>"],
    ["manifest recursion", "<MPD mediaPresentationDuration=\"PT1S\"><Period><AdaptationSet mimeType=\"video/mp4\" contentType=\"video\" codecs=\"avc1.1\"><Representation id=\"v\" bandwidth=\"1\" width=\"2\" height=\"2\"><SegmentTemplate media=\"segment.m4s\"/></Representation></AdaptationSet></Period></MPD>"],
    ["duration mismatch", "<MPD mediaPresentationDuration=\"PT2S\"><Period duration=\"PT3S\"><AdaptationSet mimeType=\"video/mp4\" contentType=\"video\" codecs=\"avc1.1\"><Representation id=\"v\" bandwidth=\"1\" width=\"2\" height=\"2\"><BaseURL>video.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>"]
  ])("rejects %s fail-closed", (_label, xml) => {
    expect(() => parseRedditDashManifest(xml, MANIFEST_URL, MEDIA_ID)).toThrowError(AppError);
  });

  it("rejects oversized XML before parsing", () => {
    expect(() => parseRedditDashManifest("x".repeat(256 * 1024 + 1), MANIFEST_URL, MEDIA_ID)).toThrowError(AppError);
  });
});

describe("controlled Reddit manifest provider", () => {
  it("applies exact bounded HTTPS, host, redirect, profile and AbortSignal policy", async () => {
    const fetchBody = vi.fn<RedditManifestBodyFetcher>(async () => response(await fixture()));
    const signal = new AbortController().signal;
    const manifest = await createRedditManifestProvider({ fetchBody }).fetch(locator(), {
      signal,
      metadataTimeoutSeconds: 7
    });
    expect(manifest.representations).toHaveLength(3);
    expect(fetchBody).toHaveBeenCalledWith(MANIFEST_URL, expect.objectContaining({
      maxBytes: 256 * 1024,
      timeoutSeconds: 7,
      maxRedirects: 2,
      requireHttps: true,
      requestProfile: "reddit-media-v1",
      signal
    }));
    const options = fetchBody.mock.calls[0][1];
    expect(options.allowHostname?.("v.redd.it")).toBe(true);
    expect(options.allowHostname?.("127.0.0.1")).toBe(false);
    expect(options.allowHostname?.("v.redd.it.attacker.example")).toBe(false);
  });

  it("rejects wrong content type, oversized response, unsafe redirect root, timeout and abort safely", async () => {
    const xml = await fixture();
    await code(createRedditManifestProvider({
      fetchBody: async () => response(xml, { contentType: "text/html" })
    }).fetch(locator()), API_ERROR_CODES.EXTRACTOR_FAILED);
    await code(createRedditManifestProvider({
      fetchBody: async () => { throw new AppError(API_ERROR_CODES.FILE_TOO_LARGE); }
    }).fetch(locator()), API_ERROR_CODES.EXTRACTOR_FAILED);
    await code(createRedditManifestProvider({
      fetchBody: async () => response(xml, { finalUrl: new URL("https://v.redd.it/other42/DASHPlaylist.mpd") })
    }).fetch(locator()), API_ERROR_CODES.EXTRACTOR_FAILED);
    await code(createRedditManifestProvider({
      fetchBody: async () => { throw new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "raw manifest", 504); }
    }).fetch(locator()), API_ERROR_CODES.EXTRACTOR_TIMEOUT);
    const controller = new AbortController();
    controller.abort();
    await code(createRedditManifestProvider({
      fetchBody: async () => { throw new Error("raw abort"); }
    }).fetch(locator(), { signal: controller.signal }), API_ERROR_CODES.JOB_CANCELLED);
  });
});
