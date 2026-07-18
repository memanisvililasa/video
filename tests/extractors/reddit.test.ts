import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type { RedditFormatTopology } from "@/lib/extractors/reddit-formats";
import type { RedditManifest, RedditManifestRepresentation } from "@/lib/extractors/reddit-manifest";
import type {
  RedditMediaLocator,
  RedditMetadataProvider,
  RedditProductMetadata,
  RedditResolvedMetadata
} from "@/lib/extractors/reddit-metadata";
import { createRedditExtractor } from "@/lib/extractors/reddit";
import type { MergeAudioVideoResult } from "@/lib/ffmpeg/merge";
import type { SafeDownloadResult } from "@/lib/http/safe-fetch";
import { API_ERROR_CODES } from "@/lib/types";

const POST_URL = new URL("https://www.reddit.com/r/videos/comments/abc123/synthetic_post/");
const MAX_BYTES = 10 * 1024 * 1024;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((candidate) => rm(candidate, { recursive: true, force: true })));
});

function source(
  identity: string,
  kind: RedditManifestRepresentation["kind"],
  overrides: Partial<RedditManifestRepresentation> = {}
): RedditManifestRepresentation {
  const bitrate = kind === "audio" ? 128_000 : 1_000_000;
  return {
    identity,
    url: new URL(`https://v.redd.it/media42/${identity}.mp4?signature=synthetic`),
    kind,
    container: "mp4",
    ...(kind !== "audio" ? { videoCodec: "h264", width: 640, height: 360, fps: 30 } : {}),
    ...(kind !== "video" ? { audioCodec: "aac" } : {}),
    bitrate,
    durationSeconds: 4,
    filesizeEstimateBytes: Math.ceil(bitrate * 4 / 8),
    ...overrides
  };
}

function manifest(topology: RedditFormatTopology, suffix = ""): RedditManifest {
  const representations = topology === "progressive"
    ? [source(`progressive${suffix}`, "progressive")]
    : topology === "split"
      ? [source(`video${suffix}`, "video"), source(`audio${suffix}`, "audio")]
      : [source(`silent${suffix}`, "video")];
  return { mediaId: "media42", durationSeconds: 4, representations };
}

function product(hasAudio: boolean): RedditProductMetadata {
  return {
    platform: "reddit",
    canonicalPostId: "abc123",
    title: "Синтетический Reddit #video",
    durationSeconds: 4,
    redditHostedVideo: true,
    hasAudio,
    sourceKind: "direct"
  };
}

function resolved(hasAudio: boolean): RedditResolvedMetadata {
  const locator: RedditMediaLocator = {
    mediaId: "media42",
    fallbackUrl: new URL("https://v.redd.it/media42/DASH_360.mp4"),
    dashManifestUrl: new URL("https://v.redd.it/media42/DASHPlaylist.mpd"),
    width: 640,
    height: 360,
    bitrate: 1_000_000
  };
  return { product: product(hasAudio), locator };
}

function metadataProvider(hasAudio: boolean): RedditMetadataProvider & { resolve: ReturnType<typeof vi.fn> } {
  const value = resolved(hasAudio);
  const resolve = vi.fn(async () => value);
  return {
    fetch: async () => value.product,
    resolve
  };
}

async function workDir(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "videosave-reddit-unit-"));
  temporaryRoots.push(value);
  return value;
}

function successfulDownload(bytes = 6) {
  return vi.fn(async (url: URL, destination: string, options): Promise<SafeDownloadResult> => {
    await writeFile(destination, Buffer.alloc(bytes, 1));
    options.onProgress?.(bytes, bytes);
    return {
      finalUrl: new URL(url),
      statusCode: 200,
      headers: { "content-type": url.pathname.includes("audio") ? "audio/mp4" : "video/mp4" },
      contentType: url.pathname.includes("audio") ? "audio/mp4" : "video/mp4",
      contentLength: bytes,
      sizeBytes: bytes
    };
  });
}

function successfulMerge() {
  return vi.fn(async (options): Promise<MergeAudioVideoResult> => {
    await writeFile(options.outputPath, Buffer.alloc(12, 2));
    return { outputPath: options.outputPath, sizeBytes: 12 } as MergeAudioVideoResult;
  });
}

function extractor(topology: RedditFormatTopology, overrides: Record<string, unknown> = {}) {
  const metadata = metadataProvider(topology !== "silent");
  const manifestProvider = { fetch: vi.fn(async () => manifest(topology)) };
  const downloadToFile = successfulDownload();
  const mergeSources = successfulMerge();
  return {
    metadata,
    manifestProvider,
    downloadToFile,
    mergeSources,
    extractor: createRedditExtractor({
      metadataProvider: metadata,
      manifestProvider,
      downloadToFile,
      mergeSources,
      ...overrides
    })
  };
}

describe("internal Reddit media extractor", () => {
  it.each([
    ["progressive", "original", 1, 0],
    ["split", "original", 2, 1],
    ["split", "remux-to-mp4", 2, 1],
    ["split", "compatible-mp4", 2, 1],
    ["split", "audio-only", 1, 0],
    ["silent", "original", 1, 0],
    ["silent", "compatible-mp4", 1, 0]
  ] as const)("materializes %s for %s without client source data", async (topology, preset, downloads, merges) => {
    const harness = extractor(topology);
    const metadata = await harness.extractor.extract(POST_URL, { maxFileSizeBytes: MAX_BYTES });
    const output = await harness.extractor.download(POST_URL, metadata.formats[0].id, {
      workDir: await workDir(),
      processingPreset: preset,
      maxFileSizeBytes: MAX_BYTES,
      downloadTimeoutSeconds: 10
    });
    expect(output).toMatchObject({ contentType: preset === "audio-only" ? "audio/mp4" : "video/mp4" });
    expect(output.filename).toMatch(/\.mp4$/);
    expect(harness.metadata.resolve).toHaveBeenCalledTimes(2);
    expect(harness.manifestProvider.fetch).toHaveBeenCalledTimes(2);
    expect(harness.downloadToFile).toHaveBeenCalledTimes(downloads);
    expect(harness.mergeSources).toHaveBeenCalledTimes(merges);
    expect(JSON.stringify(metadata)).not.toMatch(/v\.redd\.it|DASH|signature|media42|synthetic_post/i);
    for (const call of harness.downloadToFile.mock.calls) {
      expect(call[2]).toMatchObject({
        maxRedirects: 2,
        requireHttps: true,
        requestProfile: "reddit-media-v1"
      });
      expect(call[2].allowHostname?.("v.redd.it")).toBe(true);
      expect(call[2].allowHostname?.("127.0.0.1")).toBe(false);
    }
  });

  it("returns SOURCE_HAS_NO_AUDIO before creating any silent audio artifact", async () => {
    const harness = extractor("silent");
    const metadata = await harness.extractor.extract(POST_URL, { maxFileSizeBytes: MAX_BYTES });
    const directory = await workDir();
    await expect(harness.extractor.download(POST_URL, metadata.formats[0].id, {
      workDir: directory,
      processingPreset: "audio-only",
      maxFileSizeBytes: MAX_BYTES
    })).rejects.toMatchObject({ code: API_ERROR_CODES.SOURCE_HAS_NO_AUDIO });
    expect(harness.downloadToFile).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("re-resolves metadata and rejects a stale opaque format before downloading", async () => {
    const metadata = metadataProvider(true);
    const manifestProvider = { fetch: vi.fn()
      .mockResolvedValueOnce(manifest("split"))
      .mockResolvedValueOnce(manifest("split", "-fresh")) };
    const downloadToFile = successfulDownload();
    const reddit = createRedditExtractor({ metadataProvider: metadata, manifestProvider, downloadToFile });
    const extracted = await reddit.extract(POST_URL, { maxFileSizeBytes: MAX_BYTES });
    await expect(reddit.download(POST_URL, extracted.formats[0].id, {
      workDir: await workDir(),
      maxFileSizeBytes: MAX_BYTES
    })).rejects.toMatchObject({ code: API_ERROR_CODES.SOURCE_EXPIRED });
    expect(downloadToFile).not.toHaveBeenCalled();
  });

  it("does not accept client-injected URLs, representation IDs, codecs or filenames", async () => {
    const harness = extractor("split");
    await expect(harness.extractor.download(POST_URL, "https://attacker.example/video.mp4", {
      workDir: await workDir(),
      maxFileSizeBytes: MAX_BYTES
    })).rejects.toMatchObject({ code: API_ERROR_CODES.SOURCE_EXPIRED });
    expect(harness.downloadToFile).not.toHaveBeenCalled();
  });

  it("blocks an unsafe fresh representation even when a fake provider is hostile", async () => {
    const metadata = metadataProvider(true);
    const unsafe: RedditManifest = {
      ...manifest("progressive"),
      representations: [source("unsafe", "progressive", { url: new URL("https://127.0.0.1/video.mp4") })]
    };
    const downloadToFile = successfulDownload();
    const reddit = createRedditExtractor({
      metadataProvider: metadata,
      manifestProvider: { fetch: async () => unsafe },
      downloadToFile
    });
    const extracted = await reddit.extract(POST_URL, { maxFileSizeBytes: MAX_BYTES });
    await expect(reddit.download(POST_URL, extracted.formats[0].id, {
      workDir: await workDir(),
      maxFileSizeBytes: MAX_BYTES
    })).rejects.toMatchObject({ code: API_ERROR_CODES.DOWNLOAD_FAILED });
    expect(downloadToFile).not.toHaveBeenCalled();
  });

  it("enforces one combined split byte budget and removes both partials on overflow", async () => {
    const metadata = metadataProvider(true);
    const calls: number[] = [];
    const downloadToFile = vi.fn(async (url: URL, destination: string, options): Promise<SafeDownloadResult> => {
      calls.push(options.maxBytes);
      if (calls.length === 1) {
        await writeFile(destination, "video!");
        return { finalUrl: url, statusCode: 200, headers: {}, contentType: "video/mp4", sizeBytes: 6 };
      }
      await writeFile(`${destination}.download`, "partial");
      throw new AppError(API_ERROR_CODES.FILE_TOO_LARGE);
    });
    const reddit = createRedditExtractor({
      metadataProvider: metadata,
      manifestProvider: {
        fetch: async () => ({
          mediaId: "media42",
          durationSeconds: 4,
          representations: [
            source("video", "video", { bitrate: 8, filesizeEstimateBytes: 5 }),
            source("audio", "audio", { bitrate: 8, filesizeEstimateBytes: 4 })
          ]
        })
      },
      downloadToFile,
      mergeSources: successfulMerge()
    });
    const extracted = await reddit.extract(POST_URL, { maxFileSizeBytes: 10 });
    const directory = await workDir();
    await expect(reddit.download(POST_URL, extracted.formats[0].id, {
      workDir: directory,
      maxFileSizeBytes: 10
    })).rejects.toMatchObject({ code: API_ERROR_CODES.FILE_TOO_LARGE });
    expect(calls).toEqual([10, 4]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("uses a shared split timeout deadline and monotonic aggregate progress", async () => {
    const clock = [0, 0, 2_000];
    const progress = vi.fn();
    const harness = extractor("split", { now: () => clock.shift() ?? 2_000 });
    const extracted = await harness.extractor.extract(POST_URL, { maxFileSizeBytes: MAX_BYTES });
    const directory = await workDir();
    await expect(harness.extractor.download(POST_URL, extracted.formats[0].id, {
      workDir: directory,
      maxFileSizeBytes: MAX_BYTES,
      downloadTimeoutSeconds: 1,
      onDownloadProgress: progress
    })).rejects.toMatchObject({ code: API_ERROR_CODES.DOWNLOAD_FAILED });
    expect(harness.downloadToFile).toHaveBeenCalledTimes(1);
    const values = progress.mock.calls.map(([bytes]) => bytes);
    expect(values).toEqual([...values].sort((left, right) => left - right));
    expect(await readdir(directory)).toEqual([]);
  });

  it("preserves a safe MERGE_FAILED code and removes downloaded split sources", async () => {
    const reddit = createRedditExtractor({
      metadataProvider: metadataProvider(true),
      manifestProvider: { fetch: async () => manifest("split") },
      downloadToFile: successfulDownload(),
      mergeSources: async () => { throw new AppError(API_ERROR_CODES.MERGE_FAILED, "raw ffmpeg stderr"); }
    });
    const extracted = await reddit.extract(POST_URL, { maxFileSizeBytes: MAX_BYTES });
    const directory = await workDir();
    await expect(reddit.download(POST_URL, extracted.formats[0].id, {
      workDir: directory,
      maxFileSizeBytes: MAX_BYTES
    })).rejects.toMatchObject({
      code: API_ERROR_CODES.MERGE_FAILED,
      message: expect.not.stringMatching(/ffmpeg|stderr/i)
    });
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    ["missing resource", new AppError(API_ERROR_CODES.DOWNLOAD_FAILED, "raw https://v.redd.it/media42/missing")],
    ["request timeout", new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "raw timeout", 504)]
  ] as const)("maps a %s to a safe DOWNLOAD_FAILED and removes partial output", async (_label, failure) => {
    const reddit = createRedditExtractor({
      metadataProvider: metadataProvider(true),
      manifestProvider: { fetch: async () => manifest("progressive") },
      downloadToFile: async (_url, destination) => {
        await writeFile(`${destination}.download`, "partial");
        throw failure;
      }
    });
    const extracted = await reddit.extract(POST_URL, { maxFileSizeBytes: MAX_BYTES });
    const directory = await workDir();
    await expect(reddit.download(POST_URL, extracted.formats[0].id, {
      workDir: directory,
      maxFileSizeBytes: MAX_BYTES
    })).rejects.toMatchObject({
      code: API_ERROR_CODES.DOWNLOAD_FAILED,
      message: expect.not.stringMatching(/https|timeout|v\.redd/i)
    });
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects a media response with the wrong Content-Type and removes the downloaded source", async () => {
    const reddit = createRedditExtractor({
      metadataProvider: metadataProvider(true),
      manifestProvider: { fetch: async () => manifest("progressive") },
      downloadToFile: async (url, destination) => {
        await writeFile(destination, "not-media");
        return { finalUrl: url, statusCode: 200, headers: {}, contentType: "text/html", sizeBytes: 9 };
      }
    });
    const extracted = await reddit.extract(POST_URL, { maxFileSizeBytes: MAX_BYTES });
    const directory = await workDir();
    await expect(reddit.download(POST_URL, extracted.formats[0].id, {
      workDir: directory,
      maxFileSizeBytes: MAX_BYTES
    })).rejects.toMatchObject({ code: API_ERROR_CODES.OUTPUT_INVALID });
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["video", "audio", "merge"] as const)("cancels during %s and removes every intermediate", async (stage) => {
    const controller = new AbortController();
    let calls = 0;
    const downloadToFile = vi.fn(async (url: URL, destination: string): Promise<SafeDownloadResult> => {
      calls += 1;
      if ((stage === "video" && calls === 1) || (stage === "audio" && calls === 2)) {
        await writeFile(`${destination}.download`, "partial");
        controller.abort();
        throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED);
      }
      await writeFile(destination, "source");
      return { finalUrl: url, statusCode: 200, headers: {}, contentType: url.pathname.includes("audio") ? "audio/mp4" : "video/mp4", sizeBytes: 6 };
    });
    const mergeSources = vi.fn(async () => {
      controller.abort();
      throw new AppError(API_ERROR_CODES.MERGE_FAILED);
    });
    const reddit = createRedditExtractor({
      metadataProvider: metadataProvider(true),
      manifestProvider: { fetch: async () => manifest("split") },
      downloadToFile,
      mergeSources: stage === "merge" ? mergeSources : successfulMerge()
    });
    const extracted = await reddit.extract(POST_URL, { maxFileSizeBytes: MAX_BYTES });
    const directory = await workDir();
    await expect(reddit.download(POST_URL, extracted.formats[0].id, {
      workDir: directory,
      signal: controller.signal,
      maxFileSizeBytes: MAX_BYTES
    })).rejects.toMatchObject({ code: API_ERROR_CODES.JOB_CANCELLED });
    expect(await readdir(directory)).toEqual([]);
  });
});
