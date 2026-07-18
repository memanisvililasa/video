import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { createYouTubeExtractor } from "@/lib/extractors/youtube";
import { selectYouTubeFormats } from "@/lib/extractors/youtube-formats";
import { canonicalizeYouTubePageUrl, supportsYouTubePageUrl } from "@/lib/extractors/youtube-url";
import { parseYtDlpMetadataJson } from "@/lib/extractors/yt-dlp/parser";
import {
  YOUTUBE_PUBLIC_ACCEPT,
  YOUTUBE_PUBLIC_ACCEPT_LANGUAGE,
  YOUTUBE_PUBLIC_SEC_FETCH_MODE,
  YOUTUBE_PUBLIC_USER_AGENT
} from "@/lib/extractors/yt-dlp/contract";
import { API_ERROR_CODES } from "@/lib/types";

const fixturePath = path.join(process.cwd(), "tests/fixtures/youtube-public.json");
const MAX_BYTES = 10 * 1024 * 1024;

async function parsedFixture(transform?: (value: Record<string, unknown>) => void) {
  const value = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  transform?.(value);
  return parseYtDlpMetadataJson(JSON.stringify(value), "youtube");
}

describe("strict public YouTube and Shorts URL boundary", () => {
  it.each([
    "https://youtube.com/watch?v=AbCdEfGhI_1",
    "https://www.youtube.com/watch?v=AbCdEfGhI_1&si=tracking",
    "https://m.youtube.com/watch?v=AbCdEfGhI_1&t=12",
    "https://youtu.be/AbCdEfGhI_1?feature=share",
    "https://youtube.com/shorts/AbCdEfGhI_1?si=tracking",
    "https://www.youtube.com/shorts/AbCdEfGhI_1/"
  ])("canonicalizes %s to one page identity", (input) => {
    const canonical = canonicalizeYouTubePageUrl(new URL(input));
    expect(canonical.videoId).toBe("AbCdEfGhI_1");
    expect(canonical.url.toString()).toBe("https://www.youtube.com/watch?v=AbCdEfGhI_1");
    expect(supportsYouTubePageUrl(new URL(input))).toBe(true);
  });

  it.each([
    "http://youtube.com/watch?v=AbCdEfGhI_1",
    "https://youtube.com:444/watch?v=AbCdEfGhI_1",
    "https://user:password@youtube.com/watch?v=AbCdEfGhI_1",
    "https://youtube.com/watch?v=short",
    "https://youtube.com/watch?v=AbCdEfGhI_1&list=PLfixture",
    "https://youtube.com/watch?v=AbCdEfGhI_1#index=2",
    "https://youtube.com/watch?v=AbCdEfGhI_1#t=2",
    "https://youtube.com/watch?v=AbCdEfGhI_1&x-user-header=yes",
    "https://youtube.com/playlist?list=PLfixture",
    "https://youtube.com/channel/UCfixture",
    "https://youtube.com/@profile",
    "https://youtube.com/results?search_query=fixture",
    "https://youtube.com/live/AbCdEfGhI_1",
    "https://youtube-nocookie.com/embed/AbCdEfGhI_1",
    "https://youtube.com.attacker.example/watch?v=AbCdEfGhI_1"
  ])("rejects out-of-scope URL %s", (input) => {
    expect(supportsYouTubePageUrl(new URL(input))).toBe(false);
  });

  it("distinguishes playlist semantics with a stable safe error", () => {
    expect(() => canonicalizeYouTubePageUrl(new URL(
      "https://www.youtube.com/watch?v=AbCdEfGhI_1&list=PLfixture"
    ))).toThrowError(expect.objectContaining({ code: API_ERROR_CODES.PLAYLIST_NOT_SUPPORTED }));
  });
});

describe("YouTube metadata, format pair, and download policy", () => {
  it.each([
    ["private", API_ERROR_CODES.PRIVATE_CONTENT],
    ["needs_auth", API_ERROR_CODES.LOGIN_REQUIRED],
    ["subscriber_only", API_ERROR_CODES.MEMBERS_ONLY]
  ] as const)("maps availability %s safely", async (availability, code) => {
    await expect(parsedFixture((value) => { value.availability = availability; }))
      .rejects.toMatchObject({ code });
  });

  it.each([
    ["live", API_ERROR_CODES.LIVE_NOT_SUPPORTED, (value: Record<string, unknown>) => { value.is_live = true; }],
    ["playlist", API_ERROR_CODES.PLAYLIST_NOT_SUPPORTED, (value: Record<string, unknown>) => { value._type = "playlist"; }],
    ["DRM", API_ERROR_CODES.DRM_PROTECTED, (value: Record<string, unknown>) => { value.has_drm = true; }],
    ["age", API_ERROR_CODES.AGE_RESTRICTED, (value: Record<string, unknown>) => { value.age_limit = 18; }]
  ] as const)("rejects %s metadata with %s", async (_name, code, transform) => {
    await expect(parsedFixture(transform)).rejects.toMatchObject({ code });
  });

  it("selects four stable bounded UI tiers without exposing CDN URLs", async () => {
    const selected = selectYouTubeFormats(await parsedFixture(), MAX_BYTES);
    expect(selected.map((format) => format.qualityTier)).toEqual([1080, 720, 480, 360]);
    expect(selected.map((format) => format.transport)).toEqual([
      "separate-direct", "separate-direct", "separate-direct", "progressive-direct"
    ]);
    expect(new Set(selected.map((format) => format.stableId)).size).toBe(4);
    expect(selected.every((format) => format.audioOnlySource?.formatId === "140")).toBe(true);
    for (const format of selected) {
      expect(format.stableId).toMatch(/^pf_[A-Za-z0-9_-]{43}$/);
      expect(format.stableId).not.toMatch(/googlevideo|videoplayback|fixture=/i);
    }
  });

  it("accepts only the replayable fixed request profile and rejects arbitrary headers", async () => {
    const fixed = await parsedFixture((value) => {
      for (const format of value.formats as Array<Record<string, unknown>>) {
        if (format.protocol !== "https" || format.ext === "mhtml") continue;
        format.http_headers = {
          "User-Agent": YOUTUBE_PUBLIC_USER_AGENT,
          Accept: YOUTUBE_PUBLIC_ACCEPT,
          "Accept-Language": YOUTUBE_PUBLIC_ACCEPT_LANGUAGE,
          "Sec-Fetch-Mode": YOUTUBE_PUBLIC_SEC_FETCH_MODE
        };
      }
    });
    expect(selectYouTubeFormats(fixed, MAX_BYTES)).toHaveLength(4);

    await expect(parsedFixture((value) => {
      for (const format of value.formats as Array<Record<string, unknown>>) {
        format.http_headers = { Authorization: "Bearer forbidden" };
      }
    })).rejects.toMatchObject({ code: API_ERROR_CODES.NO_SUPPORTED_FORMAT });
  });

  it("extracts safe metadata for Shorts and does not leak source data", async () => {
    const metadata = await parsedFixture();
    const extractor = createYouTubeExtractor({ metadataRunner: { extract: vi.fn(async () => metadata) } });
    const result = await extractor.extract(new URL("https://youtube.com/shorts/AbCdEfGhI_1?si=removed"), {
      maxFileSizeBytes: MAX_BYTES,
      maxDurationSeconds: 60
    });
    expect(result).toMatchObject({
      originalUrl: "https://www.youtube.com/",
      title: "Deterministic YouTube fixture",
      durationSeconds: 1,
      platform: "YouTube"
    });
    expect(result.formats.map((format) => format.quality)).toEqual(["1080p", "720p", "480p", "360p"]);
    expect(JSON.stringify(result)).not.toMatch(/googlevideo|videoplayback|fixture=|http_headers|signature/i);
  });

  it("re-extracts a fresh pair, enforces fixed egress profile, and merges server-side", async () => {
    const initial = await parsedFixture();
    const fresh = await parsedFixture((value) => {
      for (const format of value.formats as Array<Record<string, unknown>>) {
        if (typeof format.url === "string") format.url = format.url.replace("fixture=", "fresh=");
      }
    });
    const extract = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh);
    const downloads: Array<{ url: URL; destination: string; options: Record<string, unknown> }> = [];
    const downloadToFile = vi.fn(async (url: URL, destination: string, options: Record<string, unknown>) => {
      downloads.push({ url, destination, options });
      return { finalUrl: url, statusCode: 200, headers: {}, contentType: "video/mp4", sizeBytes: 100 };
    });
    const mergeSources = vi.fn(async (options) => ({
      outputPath: options.outputPath,
      sizeBytes: 190,
      videoInput: {} as never,
      audioInput: {} as never,
      output: {} as never
    }));
    const extractor = createYouTubeExtractor({ metadataRunner: { extract }, downloadToFile, mergeSources });
    const page = new URL("https://youtu.be/AbCdEfGhI_1?si=removed");
    const metadata = await extractor.extract(page, { maxFileSizeBytes: MAX_BYTES });
    const selected = metadata.formats.find((format) => format.quality === "1080p")!;
    const source = await extractor.download(page, selected.id, {
      workDir: "/tmp",
      maxFileSizeBytes: MAX_BYTES,
      processingPreset: "original"
    });
    expect(extract).toHaveBeenNthCalledWith(1, "youtube", new URL("https://www.youtube.com/watch?v=AbCdEfGhI_1"), undefined);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(downloads).toHaveLength(2);
    expect(downloads.every((download) => download.url.searchParams.has("fresh"))).toBe(true);
    expect(downloads.every((download) => download.options.requestProfile === "youtube-public-v1")).toBe(true);
    expect(downloads.every((download) => download.options.requireHttps === true)).toBe(true);
    expect(downloads.every((download) => (download.options.allowHostname as (host: string) => boolean)(download.url.hostname))).toBe(true);
    expect(mergeSources).toHaveBeenCalledOnce();
    expect(source).toMatchObject({ path: "/tmp/source.mp4", contentType: "video/mp4", sizeBytes: 190 });
  });

  it("downloads only the selected audio reference for audio-only", async () => {
    const parsed = await parsedFixture();
    const downloadToFile = vi.fn(async (url: URL) => ({
      finalUrl: url, statusCode: 200, headers: {}, contentType: "audio/mp4", sizeBytes: 100
    }));
    const mergeSources = vi.fn();
    const extractor = createYouTubeExtractor({ metadataRunner: { extract: async () => parsed }, downloadToFile, mergeSources });
    const metadata = await extractor.extract(new URL("https://youtube.com/watch?v=AbCdEfGhI_1"), { maxFileSizeBytes: MAX_BYTES });
    await extractor.download(new URL("https://youtube.com/watch?v=AbCdEfGhI_1"), metadata.formats[0].id, {
      workDir: "/tmp", maxFileSizeBytes: MAX_BYTES, processingPreset: "audio-only"
    });
    expect(downloadToFile).toHaveBeenCalledOnce();
    expect((downloadToFile.mock.calls[0]?.[0] as URL).searchParams.get("fixture")).toBe("audio");
    expect(mergeSources).not.toHaveBeenCalled();
  });

  it("fails stale or unsafe fresh sources closed", async () => {
    const initial = await parsedFixture();
    const changed = await parsedFixture((value) => {
      value.formats = (value.formats as Array<Record<string, unknown>>).filter((format) => format.format_id === "18");
    });
    const extractor = createYouTubeExtractor({
      metadataRunner: { extract: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(changed) },
      downloadToFile: vi.fn()
    });
    const page = new URL("https://youtube.com/watch?v=AbCdEfGhI_1");
    const metadata = await extractor.extract(page, { maxFileSizeBytes: MAX_BYTES });
    await expect(extractor.download(page, metadata.formats[0].id, {
      workDir: "/tmp", maxFileSizeBytes: MAX_BYTES
    })).rejects.toMatchObject({ code: API_ERROR_CODES.SOURCE_EXPIRED });

    const unsafe = createYouTubeExtractor({
      metadataRunner: { extract: async () => initial },
      allowMediaHostname: () => false,
      downloadToFile: vi.fn()
    });
    const unsafeMetadata = await unsafe.extract(page, { maxFileSizeBytes: MAX_BYTES });
    await expect(unsafe.download(page, unsafeMetadata.formats.at(-1)!.id, {
      workDir: "/tmp", maxFileSizeBytes: MAX_BYTES
    })).rejects.toMatchObject({ code: API_ERROR_CODES.DOWNLOAD_FAILED });
  });

  it("maps cancellation and identity mismatch without exposing source URLs", async () => {
    const parsed = await parsedFixture();
    const controller = new AbortController();
    const extractor = createYouTubeExtractor({
      metadataRunner: { extract: async () => parsed },
      downloadToFile: async () => {
        controller.abort();
        throw new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "raw https://cdn.invalid/source");
      }
    });
    const page = new URL("https://youtube.com/watch?v=AbCdEfGhI_1");
    const metadata = await extractor.extract(page, { maxFileSizeBytes: MAX_BYTES });
    await expect(extractor.download(page, metadata.formats.at(-1)!.id, {
      workDir: "/tmp", signal: controller.signal, maxFileSizeBytes: MAX_BYTES
    })).rejects.toMatchObject({ code: API_ERROR_CODES.JOB_CANCELLED });

    const wrongId = await parsedFixture((value) => { value.id = "ZyXwVuTsR_2"; });
    await expect(createYouTubeExtractor({ metadataRunner: { extract: async () => wrongId } }).extract(page, {
      maxFileSizeBytes: MAX_BYTES
    })).rejects.toMatchObject({ code: API_ERROR_CODES.EXTRACTOR_FAILED });
  });

  it("cancels a split-stream download and removes every partial source", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "videosave-youtube-cancel-"));
    const parsed = await parsedFixture();
    const controller = new AbortController();
    let call = 0;
    const extractor = createYouTubeExtractor({
      metadataRunner: { extract: async () => parsed },
      downloadToFile: async (url, destination) => {
        call += 1;
        if (call === 1) {
          await writeFile(destination, "video");
          return { finalUrl: url, statusCode: 200, headers: {}, contentType: "video/mp4", sizeBytes: 5 };
        }
        await writeFile(`${destination}.download`, "partial-audio");
        controller.abort();
        throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED);
      },
      mergeSources: vi.fn()
    });
    try {
      const page = new URL("https://youtube.com/watch?v=AbCdEfGhI_1");
      const metadata = await extractor.extract(page, { maxFileSizeBytes: MAX_BYTES });
      await expect(extractor.download(page, metadata.formats[0].id, {
        workDir,
        signal: controller.signal,
        maxFileSizeBytes: MAX_BYTES,
        processingPreset: "original"
      })).rejects.toMatchObject({ code: API_ERROR_CODES.JOB_CANCELLED });
      expect(await readdir(workDir)).toEqual([]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
