import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import {
  createTikTokMediaAdapter,
  type TikTokMediaDownloadToFile,
  type TikTokMediaPageBodyFetcher
} from "@/lib/extractors/tiktok-media";
import type { SafeBodyFetchResult } from "@/lib/http/safe-fetch";
import {
  SYNTHETIC_TIKTOK_EXPIRE,
  SYNTHETIC_TIKTOK_NOW_MS,
  SYNTHETIC_TIKTOK_VIDEO_ID,
  syntheticTikTokLocator,
  syntheticTikTokMediaPage
} from "@/tests/fixtures/tiktok-media";
import { API_ERROR_CODES } from "@/lib/types";

const URL_INPUT = new URL(`https://m.tiktok.com/@synthetic/video/${SYNTHETIC_TIKTOK_VIDEO_ID}`);
const CANONICAL = new URL(`https://www.tiktok.com/@_/video/${SYNTHETIC_TIKTOK_VIDEO_ID}`);
let workDir: string;

function pageResult(body = syntheticTikTokMediaPage()): SafeBodyFetchResult {
  return {
    finalUrl: CANONICAL,
    statusCode: 200,
    headers: { "content-type": "text/html" },
    contentType: "text/html",
    contentLength: body.length,
    body,
    sizeBytes: body.length
  };
}

beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "videosave-tiktok-media-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("internal TikTok media adapter", () => {
  it("returns only opaque descriptors through bounded canonical page resolution", async () => {
    const fetchBody = vi.fn<TikTokMediaPageBodyFetcher>(async () => pageResult());
    const adapter = createTikTokMediaAdapter({ fetchBody, now: () => SYNTHETIC_TIKTOK_NOW_MS });
    const analysis = await adapter.analyze(URL_INPUT, { maxFileSizeBytes: 10 * 1024 * 1024 });
    expect(analysis.formats).toHaveLength(1);
    expect(JSON.stringify(analysis)).not.toMatch(/https?:\/\/|expire|signature|7000000000000000001/i);
    expect(fetchBody).toHaveBeenCalledOnce();
    const [pageUrl, policy] = fetchBody.mock.calls[0]!;
    expect(pageUrl).toEqual(CANONICAL);
    expect(policy).toMatchObject({
      maxBytes: 4 * 1024 * 1024,
      maxRedirects: 1,
      requireHttps: true,
      requestProfile: "tiktok-public-page-v1"
    });
  });

  it("re-resolves the page, matches the stable ID, and downloads only through the fixed profile", async () => {
    const pages = [
      pageResult(),
      pageResult(syntheticTikTokMediaPage({
        locators: [syntheticTikTokLocator("v19-webapp-prime.tiktok.com", SYNTHETIC_TIKTOK_EXPIRE + 10, "fresh")]
      }))
    ];
    const fetchBody = vi.fn<TikTokMediaPageBodyFetcher>(async () => pages.shift()!);
    const downloadToFile = vi.fn<TikTokMediaDownloadToFile>(async (url, _destination, options) => ({
      finalUrl: url,
      statusCode: 200,
      headers: { "content-type": "video/mp4", "content-length": "7" },
      contentType: "video/mp4",
      contentLength: 7,
      sizeBytes: 7
    }));
    const adapter = createTikTokMediaAdapter({ fetchBody, downloadToFile, now: () => SYNTHETIC_TIKTOK_NOW_MS });
    const format = (await adapter.analyze(URL_INPUT, { maxFileSizeBytes: 10 * 1024 * 1024 })).formats[0];
    const downloaded = await adapter.download(URL_INPUT, format.id, {
      workDir,
      processingPreset: "original",
      maxFileSizeBytes: 10 * 1024 * 1024
    });
    expect(fetchBody).toHaveBeenCalledTimes(2);
    expect(downloaded).toMatchObject({ filename: "tiktok-video.mp4", contentType: "video/mp4", sizeBytes: 7 });
    expect(downloadToFile).toHaveBeenCalledOnce();
    const [locator, destination, policy] = downloadToFile.mock.calls[0]!;
    expect(locator.hostname).toBe("v19-webapp-prime.tiktok.com");
    expect(destination).toBe(path.join(await realpath(workDir), "source.mp4"));
    expect(policy).toMatchObject({
      maxRedirects: 0,
      requireHttps: true,
      requestProfile: "tiktok-media-v1"
    });
    expect(policy.allowHostname?.("v16-webapp-prime.tiktok.com")).toBe(true);
    expect(policy.allowHostname?.("www.tiktok.com")).toBe(false);
    expect(JSON.stringify(downloaded.format)).not.toMatch(/https?:\/\/|expire|signature|7000000000000000001/i);
  });

  it("rejects a stale selected format before media download", async () => {
    const first = pageResult();
    const changed = pageResult(syntheticTikTokMediaPage({ urlKey: "synthetic_h264_720p_30" }));
    const pages = [first, changed];
    const downloadToFile = vi.fn<TikTokMediaDownloadToFile>();
    const adapter = createTikTokMediaAdapter({
      fetchBody: async () => pages.shift()!,
      downloadToFile,
      now: () => SYNTHETIC_TIKTOK_NOW_MS
    });
    const format = (await adapter.analyze(URL_INPUT)).formats[0];
    await expect(adapter.download(URL_INPUT, format.id, { workDir, processingPreset: "original" }))
      .rejects.toMatchObject({ code: API_ERROR_CODES.SOURCE_EXPIRED });
    expect(downloadToFile).not.toHaveBeenCalled();
  });

  it("rejects audio-only without starting a media request", async () => {
    const downloadToFile = vi.fn<TikTokMediaDownloadToFile>();
    const adapter = createTikTokMediaAdapter({
      fetchBody: async () => pageResult(),
      downloadToFile,
      now: () => SYNTHETIC_TIKTOK_NOW_MS
    });
    await expect(adapter.download(URL_INPUT, "ttf_synthetic", { workDir, processingPreset: "audio-only" }))
      .rejects.toMatchObject({ code: API_ERROR_CODES.SOURCE_HAS_NO_AUDIO });
    expect(downloadToFile).not.toHaveBeenCalled();
  });

  it("redacts transport failures and removes owned destination/partial paths", async () => {
    const adapter = createTikTokMediaAdapter({
      fetchBody: async () => pageResult(),
      downloadToFile: async () => {
        throw new Error("signed locator https://v16-webapp-prime.tiktok.com/private?expire=secret");
      },
      now: () => SYNTHETIC_TIKTOK_NOW_MS
    });
    const format = (await adapter.analyze(URL_INPUT)).formats[0];
    try {
      await adapter.download(URL_INPUT, format.id, { workDir, processingPreset: "original" });
      throw new Error("Expected download failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: API_ERROR_CODES.DOWNLOAD_FAILED });
      expect((error as Error).message).not.toMatch(/https?:\/\/|expire|signature|7000000000000000001/i);
    }
    await expect(stat(path.join(workDir, "source.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(workDir, "source.mp4.download"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an HTML media response as invalid and cleans the source", async () => {
    const adapter = createTikTokMediaAdapter({
      fetchBody: async () => pageResult(),
      downloadToFile: async (url) => ({
        finalUrl: url,
        statusCode: 200,
        headers: { "content-type": "text/html" },
        contentType: "text/html",
        sizeBytes: 12
      }),
      now: () => SYNTHETIC_TIKTOK_NOW_MS
    });
    const format = (await adapter.analyze(URL_INPUT)).formats[0];
    await expect(adapter.download(URL_INPUT, format.id, { workDir, processingPreset: "original" }))
      .rejects.toMatchObject({ code: API_ERROR_CODES.OUTPUT_INVALID });
  });
});
