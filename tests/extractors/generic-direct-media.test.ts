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

describe("generic direct-media source cleanup", () => {
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
