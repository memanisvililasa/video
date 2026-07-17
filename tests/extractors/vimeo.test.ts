import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { createVimeoExtractor, selectVimeoProgressiveFormats } from "@/lib/extractors/vimeo";
import {
  canonicalizeVimeoPageUrl,
  supportsVimeoPageUrl
} from "@/lib/extractors/vimeo-url";
import { parseYtDlpMetadataJson } from "@/lib/extractors/yt-dlp/parser";
import { API_ERROR_CODES } from "@/lib/types";

const fixturePath = path.join(process.cwd(), "tests/fixtures/vimeo-public.json");

async function parsedFixture(transform?: (value: Record<string, unknown>) => void) {
  const value = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  transform?.(value);
  return parseYtDlpMetadataJson(JSON.stringify(value), "vimeo");
}

describe("strict Vimeo public-page URL boundary", () => {
  it.each([
    ["https://vimeo.com/123456789", "https://vimeo.com/123456789"],
    ["https://www.vimeo.com/123456789/", "https://vimeo.com/123456789"],
    ["https://player.vimeo.com/video/123456789", "https://vimeo.com/123456789"],
    ["https://VIMEO.com:443/123456789", "https://vimeo.com/123456789"]
  ])("canonicalizes %s", (input, expected) => {
    expect(canonicalizeVimeoPageUrl(new URL(input)).url.toString()).toBe(expected);
    expect(supportsVimeoPageUrl(new URL(input))).toBe(true);
  });

  it.each([
    "http://vimeo.com/123456789",
    "https://vimeo.com:444/123456789",
    "https://user:password@vimeo.com/123456789",
    "https://vimeo.com/0",
    "https://vimeo.com/not-a-number",
    "https://vimeo.com/123456789?password=secret",
    "https://vimeo.com/123456789#private",
    "https://vimeo.com/showcase/123456789",
    "https://vimeo.com/album/123456789",
    "https://vimeo.com/channels/staffpicks/123456789",
    "https://vimeo.com/groups/test/videos/123456789",
    "https://vimeo.com/ondemand/title/123456789",
    "https://vimeo.com/event/123456789",
    "https://vimeo.com/user123456789",
    "https://vimeo.com/123456789/private-hash",
    "https://player.vimeo.com/video/not-a-number",
    "https://vimeo.com.attacker.example/123456789"
  ])("rejects out-of-scope URL %s", (input) => {
    expect(supportsVimeoPageUrl(new URL(input))).toBe(false);
    expect(() => canonicalizeVimeoPageUrl(new URL(input))).toThrowError(
      expect.objectContaining({ code: API_ERROR_CODES.UNSUPPORTED_URL })
    );
  });

  it("rejects malformed input before classification", () => {
    expect(() => new URL("not a URL")).toThrow();
  });
});

describe("Vimeo progressive format and download policy", () => {
  it("normalizes a bounded deterministic progressive-only list without leaking URLs", async () => {
    const parsed = await parsedFixture();
    const selected = selectVimeoProgressiveFormats(parsed, 2 * 1024 * 1024);
    expect(selected).toHaveLength(2);
    expect(selected.map((format) => format.height)).toEqual([1080, 720]);
    expect(selected.every((format) => format.transport === "progressive-direct")).toBe(true);
    expect(new Set(selected.map((format) => format.stableId)).size).toBe(2);
    for (const id of selected.map((format) => format.stableId)) {
      expect(id).toMatch(/^pf_[A-Za-z0-9_-]{43}$/);
      expect(id).not.toMatch(/https|media|signature/i);
    }
  });

  it("extracts safe public metadata and never returns a media/CDN URL", async () => {
    const metadata = await parsedFixture();
    const extractor = createVimeoExtractor({ metadataRunner: { extract: vi.fn(async () => metadata) } });
    const result = await extractor.extract(new URL("https://player.vimeo.com/video/123456789"), {
      maxFileSizeBytes: 2 * 1024 * 1024
    });
    expect(result).toMatchObject({
      originalUrl: "https://vimeo.com/",
      title: "Deterministic Vimeo fixture",
      durationSeconds: 1,
      platform: "Vimeo",
      formats: [
        { label: "1080p MP4", ext: "mp4", hasVideo: true, hasAudio: true },
        { label: "720p MP4", ext: "mp4", hasVideo: true, hasAudio: true }
      ]
    });
    expect(JSON.stringify(result)).not.toMatch(/media\.example|signature=|http_headers|Authorization/i);
  });

  it("sanitizes an extractor title before display and filename use", async () => {
    const metadata = await parsedFixture((value) => { value.title = "../folder\\unsafe:name"; });
    const extractor = createVimeoExtractor({ metadataRunner: { extract: async () => metadata } });
    const result = await extractor.extract(new URL("https://vimeo.com/123456789"), {
      maxFileSizeBytes: 2 * 1024 * 1024
    });
    expect(result.title).not.toMatch(/[/\\]/);
    expect(result.title).not.toContain("..");
  });

  it("re-extracts and downloads only the fresh server-side progressive URL", async () => {
    const first = await parsedFixture((value) => {
      const formats = value.formats as Array<Record<string, unknown>>;
      (formats[0] as Record<string, unknown>).url = "https://old.example.test/video.mp4?signature=old";
    });
    const fresh = await parsedFixture();
    const extract = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(fresh);
    const downloadToFile = vi.fn(async (url: URL, _destination: string) => ({
      finalUrl: url,
      statusCode: 200,
      headers: { "content-type": "video/mp4", "content-length": "6" },
      contentType: "video/mp4",
      contentLength: 6,
      sizeBytes: 6
    }));
    const extractor = createVimeoExtractor({ metadataRunner: { extract }, downloadToFile });
    const page = new URL("https://www.vimeo.com/123456789/");
    const metadata = await extractor.extract(page, { maxFileSizeBytes: 2 * 1024 * 1024 });
    const source = await extractor.download(page, metadata.formats[0].id, {
      workDir: "/tmp",
      maxFileSizeBytes: 2 * 1024 * 1024
    });
    expect(extract).toHaveBeenCalledTimes(2);
    expect(extract).toHaveBeenNthCalledWith(1, "vimeo", new URL("https://vimeo.com/123456789"), undefined);
    expect(downloadToFile).toHaveBeenCalledOnce();
    expect((downloadToFile.mock.calls[0]?.[0] as URL).toString()).toContain("fresh-1080.mp4");
    expect((downloadToFile.mock.calls[0]?.[0] as URL).toString()).not.toContain("old.example");
    expect(source).toMatchObject({ filename: "Deterministic Vimeo fixture.mp4", contentType: "video/mp4" });
  });

  it("fails stale format IDs closed as SOURCE_EXPIRED", async () => {
    const initial = await parsedFixture();
    const changed = await parsedFixture((value) => {
      value.formats = [{
        format_id: "http-360p",
        protocol: "https",
        url: "https://media.example.test/fresh-360.mp4",
        ext: "mp4",
        vcodec: "avc1.4d401e",
        acodec: "mp4a.40.2",
        width: 640,
        height: 360,
        fps: 30,
        filesize: 1000
      }];
    });
    const extract = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(changed);
    const downloadToFile = vi.fn();
    const extractor = createVimeoExtractor({ metadataRunner: { extract }, downloadToFile });
    const page = new URL("https://vimeo.com/123456789");
    const metadata = await extractor.extract(page, { maxFileSizeBytes: 2 * 1024 * 1024 });
    await expect(extractor.download(page, metadata.formats[0].id, {
      workDir: "/tmp",
      maxFileSizeBytes: 2 * 1024 * 1024
    })).rejects.toMatchObject({ code: API_ERROR_CODES.SOURCE_EXPIRED });
    expect(downloadToFile).not.toHaveBeenCalled();
  });

  it("returns NO_SUPPORTED_FORMAT without manifest, split-stream, header, or cookie fallback", async () => {
    const parsed = await parsedFixture((value) => {
      const formats = value.formats as Array<Record<string, unknown>>;
      value.formats = formats.filter((format) => !String(format.format_id).startsWith("http-"));
    });
    const extractor = createVimeoExtractor({ metadataRunner: { extract: async () => parsed } });
    await expect(extractor.extract(new URL("https://vimeo.com/123456789"), {
      maxFileSizeBytes: 2 * 1024 * 1024
    })).rejects.toMatchObject({ code: API_ERROR_CODES.NO_SUPPORTED_FORMAT });
  });

  it("maps download failures safely and forwards cancellation", async () => {
    const parsed = await parsedFixture();
    const controller = new AbortController();
    const extractor = createVimeoExtractor({
      metadataRunner: { extract: async () => parsed },
      downloadToFile: async () => {
        controller.abort();
        throw new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "raw source failure");
      }
    });
    const metadata = await extractor.extract(new URL("https://vimeo.com/123456789"), {
      maxFileSizeBytes: 2 * 1024 * 1024
    });
    await expect(extractor.download(new URL("https://vimeo.com/123456789"), metadata.formats[0].id, {
      workDir: "/tmp",
      signal: controller.signal,
      maxFileSizeBytes: 2 * 1024 * 1024
    })).rejects.toMatchObject({ code: API_ERROR_CODES.JOB_CANCELLED });
  });

  it("rejects a non-media response as OUTPUT_INVALID without exposing its URL", async () => {
    const parsed = await parsedFixture();
    const extractor = createVimeoExtractor({
      metadataRunner: { extract: async () => parsed },
      downloadToFile: async (url) => ({
        finalUrl: url,
        statusCode: 200,
        headers: { "content-type": "text/html" },
        contentType: "text/html",
        sizeBytes: 10
      })
    });
    const metadata = await extractor.extract(new URL("https://vimeo.com/123456789"), {
      maxFileSizeBytes: 2 * 1024 * 1024
    });
    await expect(extractor.download(new URL("https://vimeo.com/123456789"), metadata.formats[0].id, {
      workDir: "/tmp",
      maxFileSizeBytes: 2 * 1024 * 1024
    })).rejects.toMatchObject({ code: API_ERROR_CODES.OUTPUT_INVALID });
  });
});
