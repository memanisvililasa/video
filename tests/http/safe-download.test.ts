import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import {
  createSafeFileDownloader,
  type SafeDownloadStreamResult
} from "@/lib/http/safe-fetch";
import { API_ERROR_CODES } from "@/lib/types";

let temporaryRoot: string;
let destinationPath: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-safe-download-"));
  destinationPath = path.join(temporaryRoot, "source.mp4");
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

function response(stream: PassThrough, contentLength?: number): SafeDownloadStreamResult {
  return {
    finalUrl: new URL("https://public.example/video.mp4"),
    statusCode: 200,
    headers: contentLength === undefined ? {} : { "content-length": String(contentLength) },
    contentType: "video/mp4",
    contentLength,
    stream: stream as unknown as http.IncomingMessage
  };
}

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
    throw new Error("Expected safe download to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
}

describe("atomic safe source download", () => {
  it("downloads through a partial file and atomically publishes the final source", async () => {
    const stream = new PassThrough();
    const requestDownload = vi.fn(async () => response(stream, 6));
    const download = createSafeFileDownloader({ requestDownload });
    const pending = download(new URL("https://public.example/video.mp4"), destinationPath, { maxBytes: 10 });
    stream.end("source");

    await expect(pending).resolves.toMatchObject({ sizeBytes: 6, contentType: "video/mp4" });
    expect(await readFile(destinationPath, "utf8")).toBe("source");
    expect(await exists(`${destinationPath}.download`)).toBe(false);
    expect(requestDownload).toHaveBeenCalledTimes(1);
  });

  it("forwards the repository-controlled HTTPS/request-profile/hostname policy", async () => {
    const stream = new PassThrough();
    const requestDownload = vi.fn(async () => response(stream, 6));
    const download = createSafeFileDownloader({ requestDownload });
    const allowHostname = (hostname: string) => hostname.endsWith(".googlevideo.com");
    const pending = download(new URL("https://r1.googlevideo.com/videoplayback"), destinationPath, {
      maxBytes: 10,
      requireHttps: true,
      requestProfile: "youtube-public-v1",
      allowHostname
    });
    stream.end("source");
    await pending;
    expect(requestDownload).toHaveBeenCalledWith(
      new URL("https://r1.googlevideo.com/videoplayback"),
      expect.objectContaining({
        requireHttps: true,
        requestProfile: "youtube-public-v1",
        allowHostname
      })
    );
  });

  it("reports bounded progress only from byte counts and trusted Content-Length", async () => {
    const stream = new PassThrough();
    const progress = vi.fn();
    const download = createSafeFileDownloader({ requestDownload: async () => response(stream, 6) });
    const pending = download(new URL("https://public.example/video.mp4"), destinationPath, {
      maxBytes: 10,
      onProgress: progress
    });
    stream.write("abc");
    stream.end("def");
    await pending;

    expect(progress).toHaveBeenCalledWith(3, 6);
    expect(progress).toHaveBeenLastCalledWith(6, 6);
  });

  it("aborts an active response body and removes source partial data", async () => {
    const stream = new PassThrough();
    const controller = new AbortController();
    const download = createSafeFileDownloader({ requestDownload: async () => response(stream) });
    const pending = download(new URL("https://public.example/video.mp4"), destinationPath, {
      maxBytes: 100,
      signal: controller.signal
    });
    stream.write("partial");
    await Promise.resolve();
    controller.abort();

    const error = await appError(pending);
    expect(error.code).toBe(API_ERROR_CODES.EXTRACTION_FAILED);
    expect(await exists(destinationPath)).toBe(false);
    expect(await exists(`${destinationPath}.download`)).toBe(false);
  });

  it("enforces the streamed byte limit when Content-Length is absent", async () => {
    const stream = new PassThrough();
    const download = createSafeFileDownloader({ requestDownload: async () => response(stream) });
    const pending = download(new URL("https://public.example/video.mp4"), destinationPath, { maxBytes: 4 });
    stream.end("oversized");

    const error = await appError(pending);
    expect(error.code).toBe(API_ERROR_CODES.FILE_TOO_LARGE);
    expect(await exists(destinationPath)).toBe(false);
    expect(await exists(`${destinationPath}.download`)).toBe(false);
  });

  it("rejects an incomplete body that does not match Content-Length", async () => {
    const stream = new PassThrough();
    const download = createSafeFileDownloader({ requestDownload: async () => response(stream, 10) });
    const pending = download(new URL("https://public.example/video.mp4"), destinationPath, { maxBytes: 20 });
    stream.end("short");

    const error = await appError(pending);
    expect(error.code).toBe(API_ERROR_CODES.DOWNLOAD_FAILED);
    expect(await exists(destinationPath)).toBe(false);
  });

  it("does not overwrite an existing destination", async () => {
    await writeFile(destinationPath, "existing");
    const stream = new PassThrough();
    const download = createSafeFileDownloader({ requestDownload: async () => response(stream, 3) });
    const pending = download(new URL("https://public.example/video.mp4"), destinationPath, { maxBytes: 10 });
    stream.end("new");

    const error = await appError(pending);
    expect(error.code).toBe(API_ERROR_CODES.DOWNLOAD_FAILED);
    expect(await readFile(destinationPath, "utf8")).toBe("existing");
    expect(await exists(`${destinationPath}.download`)).toBe(false);
  });

  it("does not delete a pre-existing partial file it does not own", async () => {
    await writeFile(`${destinationPath}.download`, "existing-partial");
    const stream = new PassThrough();
    const download = createSafeFileDownloader({ requestDownload: async () => response(stream, 3) });
    const pending = download(new URL("https://public.example/video.mp4"), destinationPath, { maxBytes: 10 });
    stream.end("new");

    await appError(pending);
    expect(await readFile(`${destinationPath}.download`, "utf8")).toBe("existing-partial");
    expect(await exists(destinationPath)).toBe(false);
  });
});
