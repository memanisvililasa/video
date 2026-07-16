import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { genericDirectMediaExtractor } from "@/lib/extractors/generic-direct-media";

const safeHttp = vi.hoisted(() => ({
  safeDownloadToFile: vi.fn(),
  safeGetMetadata: vi.fn(),
  safeHead: vi.fn()
}));

vi.mock("@/lib/http/safe-fetch", () => safeHttp);

let temporaryRoot: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-direct-extractor-"));
  safeHttp.safeHead.mockReset();
  safeHttp.safeGetMetadata.mockReset();
  safeHttp.safeDownloadToFile.mockReset();
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function metadata(url: URL, overrides: Record<string, unknown> = {}) {
  return {
    finalUrl: url,
    statusCode: 200,
    headers: { "content-length": "6" },
    contentType: "video/mp4",
    contentLength: 6,
    ...overrides
  };
}

describe("generic direct-media extractor", () => {
  it.each(["mp4", "webm", "mov", "MP4"])("supports explicit .%s media paths", (extension) => {
    expect(genericDirectMediaExtractor.supports(new URL(`https://public.example/video.${extension}?token=redacted`))).toBe(true);
  });

  it("extracts bounded metadata without exposing the source path or query", async () => {
    const source = new URL("https://public.example/private-name.mp4?token=redacted");
    const redirected = new URL("https://cdn.example/final-name.mp4?signature=redacted");
    safeHttp.safeHead.mockResolvedValue(metadata(redirected, {
      headers: { "content-length": "2048" },
      contentLength: 2048
    }));

    await expect(genericDirectMediaExtractor.extract(source, { maxFileSizeBytes: 4096 })).resolves.toMatchObject({
      originalUrl: "https://public.example/",
      title: "final-name",
      platform: "direct-media",
      formats: [{
        id: "direct-source",
        ext: "mp4",
        filesizeBytes: 2048,
        hasAudio: true,
        hasVideo: true
      }]
    });
  });

  it.each([403, 405, 501])("falls back to a bounded Range GET when HEAD returns %s", async (statusCode) => {
    const url = new URL("https://public.example/video.mp4");
    const { AppError } = await import("@/lib/errors");
    safeHttp.safeHead.mockRejectedValue(new AppError("EXTRACTION_FAILED", "head rejected", 502, { statusCode }));
    safeHttp.safeGetMetadata.mockResolvedValue(metadata(url));

    await expect(genericDirectMediaExtractor.extract(url)).resolves.toMatchObject({ platform: "direct-media" });
    expect(safeHttp.safeGetMetadata).toHaveBeenCalledOnce();
  });

  it("rejects a declared or ranged file larger than the configured maximum", async () => {
    const url = new URL("https://public.example/video.mp4");
    safeHttp.safeHead.mockResolvedValue(metadata(url, {
      headers: { "content-range": "bytes 0-0/2049" },
      contentLength: 1
    }));

    await expect(genericDirectMediaExtractor.extract(url, { maxFileSizeBytes: 2048 }))
      .rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("rejects HTML before download", async () => {
    const url = new URL("https://public.example/video.mp4");
    safeHttp.safeHead.mockResolvedValue(metadata(url, { contentType: "text/html" }));
    await expect(genericDirectMediaExtractor.extract(url)).rejects.toMatchObject({ code: "UNSUPPORTED_URL" });
  });

  it("downloads the selected source format and returns a sanitized filename", async () => {
    const url = new URL("https://public.example/video.mp4");
    safeHttp.safeHead.mockResolvedValue(metadata(url));
    safeHttp.safeDownloadToFile.mockImplementation(async (_url, destinationPath) => {
      await writeFile(destinationPath, "source");
      return { ...metadata(url), sizeBytes: 6 };
    });

    await expect(genericDirectMediaExtractor.download(url, "direct-source", {
      workDir: temporaryRoot,
      maxFileSizeBytes: 1024
    })).resolves.toMatchObject({
      path: path.join(temporaryRoot, "source.mp4"),
      filename: "video.mp4",
      contentType: "video/mp4",
      sizeBytes: 6
    });
  });

  it("removes a downloaded source rejected by post-download Content-Type validation", async () => {
    const url = new URL("https://public.example/video.mp4");
    const destination = path.join(temporaryRoot, "source.mp4");
    safeHttp.safeHead.mockResolvedValue({
      finalUrl: url,
      statusCode: 200,
      headers: { "content-length": "6" },
      contentType: "video/mp4",
      contentLength: 6
    });
    safeHttp.safeDownloadToFile.mockImplementation(async (_url, destinationPath) => {
      await writeFile(destinationPath, "source");
      return {
        finalUrl: url,
        statusCode: 200,
        headers: { "content-length": "6" },
        contentType: "text/html",
        contentLength: 6,
        sizeBytes: 6
      };
    });

    await expect(genericDirectMediaExtractor.download(url, "direct-source", {
      workDir: temporaryRoot,
      maxFileSizeBytes: 1024
    })).rejects.toMatchObject({ code: "UNSUPPORTED_URL" });

    expect(await exists(destination)).toBe(false);
  });
});
