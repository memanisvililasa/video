import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import {
  classifySafeDownloadBytes,
  classifySafeDownloadContent,
  classifySafeDownloadStatus,
  createSafeDownloadDiagnosticObserver,
  createSafeFileDownloader,
  recordSafeDownloadDiagnostic,
  type SafeDownloadDiagnosticObserver,
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

function recordSyntheticRequest(observer: SafeDownloadDiagnosticObserver | undefined): void {
  recordSafeDownloadDiagnostic(observer, {
    phase: "request-profile-built",
    requestCount: 1,
    approvedHostname: "v16-webapp-prime.tiktok.com",
    scheme: "https",
    effectivePort: 443
  });
  recordSafeDownloadDiagnostic(observer, { phase: "dns-ip-validation-completed", requestCount: 1 });
  recordSafeDownloadDiagnostic(observer, { phase: "media-request-started", requestCount: 1 });
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

  it("forwards only the fixed TikTok media profile and exact-host predicate", async () => {
    const stream = new PassThrough();
    const requestDownload = vi.fn(async () => response(stream, 6));
    const download = createSafeFileDownloader({ requestDownload });
    const hosts = new Set(["v16-webapp-prime.tiktok.com", "v19-webapp-prime.tiktok.com"]);
    const allowHostname = (hostname: string) => hosts.has(hostname);
    const pending = download(
      new URL("https://v16-webapp-prime.tiktok.com/synthetic/video.mp4?expire=1900000000"),
      destinationPath,
      {
        maxBytes: 10,
        maxRedirects: 0,
        requireHttps: true,
        requestProfile: "tiktok-media-v1",
        allowHostname
      }
    );
    stream.end("source");
    await pending;
    expect(requestDownload).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "v16-webapp-prime.tiktok.com" }),
      expect.objectContaining({
        maxRedirects: 0,
        requireHttps: true,
        requestProfile: "tiktok-media-v1",
        allowHostname
      })
    );
    expect(allowHostname("www.tiktok.com")).toBe(false);
    expect(allowHostname("v16-webapp-prime.tiktok.com.attacker.example")).toBe(false);
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

describe("internal safe download diagnostics", () => {
  it("keeps the legacy result unchanged when no observer is present", async () => {
    const stream = new PassThrough();
    const download = createSafeFileDownloader({ requestDownload: async () => response(stream, 6) });
    const pending = download(new URL("https://public.example/video.mp4"), destinationPath, { maxBytes: 10 });
    stream.end("source");
    await expect(pending).resolves.toMatchObject({ sizeBytes: 6, contentType: "video/mp4" });
  });

  it("records the completed success phases with only closed structural values", async () => {
    const observer = createSafeDownloadDiagnosticObserver();
    const stream = new PassThrough();
    const download = createSafeFileDownloader({
      requestDownload: async (_url, options) => {
        recordSyntheticRequest(options.diagnosticObserver);
        return response(stream, 6);
      }
    });
    const pending = download(new URL("https://public.example/video.mp4"), destinationPath, {
      maxBytes: 10,
      diagnosticObserver: observer
    });
    stream.end("source");
    await pending;

    expect(observer.snapshot().map((event) => event.phase)).toEqual([
      "request-profile-built",
      "dns-ip-validation-completed",
      "media-request-started",
      "response-received",
      "http-status-classified",
      "content-type-classified",
      "body-streaming-started",
      "byte-budget-evaluated",
      "body-streaming-completed",
      "byte-budget-evaluated",
      "temporary-file-finalized"
    ]);
    expect(observer.snapshot().at(-1)).toMatchObject({
      requestCount: 1,
      approvedHostname: "v16-webapp-prime.tiktok.com",
      scheme: "https",
      effectivePort: 443,
      redirectCount: 0,
      statusClass: "2xx",
      contentCategory: "video",
      contentLengthPresent: "yes",
      boundedBytesCategory: "small",
      terminationCategory: "success",
      safeErrorCode: "none"
    });
  });

  it("uses closed status, content, and byte classifications", () => {
    expect([200, 302, 403, 503, 0, 999].map(classifySafeDownloadStatus)).toEqual([
      "2xx", "3xx", "4xx", "5xx", "no-response", "unknown"
    ]);
    expect([
      "video/mp4; charset=binary",
      "application/octet-stream",
      "text/html",
      "application/problem+json",
      "text/plain",
      "",
      undefined,
      "image/png"
    ].map(classifySafeDownloadContent)).toEqual([
      "video", "binary", "html", "json", "text", "empty", "missing", "unknown"
    ]);
    expect([
      classifySafeDownloadBytes(0, 100_000),
      classifySafeDownloadBytes(10, 100_000),
      classifySafeDownloadBytes(70_000, 100_000),
      classifySafeDownloadBytes(100_000, 100_000),
      classifySafeDownloadBytes(100_001, 100_000)
    ]).toEqual(["zero", "small", "within-budget", "at-limit", "over-limit"]);
  });

  it.each([
    [403, "4xx"],
    [404, "4xx"],
    [410, "4xx"],
    [429, "4xx"],
    [503, "5xx"]
  ])("retains only the safe status class for HTTP %s", async (statusCode, statusClass) => {
    const observer = createSafeDownloadDiagnosticObserver();
    const stream = new PassThrough();
    const download = createSafeFileDownloader({
      requestDownload: async (_url, options) => {
        recordSyntheticRequest(options.diagnosticObserver);
        return { ...response(stream), statusCode };
      }
    });
    const error = await appError(download(new URL("https://public.example/video.mp4"), destinationPath, {
      maxBytes: 10,
      diagnosticObserver: observer
    }));
    expect(error.code).toBe(API_ERROR_CODES.EXTRACTION_FAILED);
    expect(observer.snapshot().at(-1)).toMatchObject({
      phase: "failed",
      statusClass,
      terminationCategory: "response-rejected",
      safeErrorCode: API_ERROR_CODES.EXTRACTION_FAILED
    });
    stream.destroy();
  });

  it.each([
    ["text/html", "html"],
    ["application/json", "json"],
    [undefined, "missing"],
    ["application/mp4", "binary"],
    ["video/mp4; charset=binary", "video"]
  ])("classifies %s without retaining the raw Content-Type", async (contentType, category) => {
    const observer = createSafeDownloadDiagnosticObserver();
    const stream = new PassThrough();
    const download = createSafeFileDownloader({
      requestDownload: async (_url, options) => {
        recordSyntheticRequest(options.diagnosticObserver);
        return { ...response(stream, 1), contentType };
      }
    });
    const pending = download(new URL("https://public.example/video.mp4"), destinationPath, {
      maxBytes: 2,
      diagnosticObserver: observer
    });
    stream.end("x");
    await pending;
    expect(observer.snapshot().find((event) => event.phase === "content-type-classified"))
      .toMatchObject({ contentCategory: category });
  });

  it("classifies missing Content-Length and chunked streaming without exact byte evidence", async () => {
    const observer = createSafeDownloadDiagnosticObserver();
    const stream = new PassThrough();
    const download = createSafeFileDownloader({
      requestDownload: async (_url, options) => {
        recordSyntheticRequest(options.diagnosticObserver);
        return response(stream);
      }
    });
    const pending = download(new URL("https://public.example/video.mp4"), destinationPath, {
      maxBytes: 20,
      diagnosticObserver: observer
    });
    stream.write("chunk");
    stream.end("ed");
    await pending;
    expect(observer.snapshot().find((event) => event.phase === "content-type-classified"))
      .toMatchObject({ contentLengthPresent: "no" });
    expect(observer.snapshot().at(-1)?.boundedBytesCategory).toBe("small");
  });

  it("localizes zero-byte and streamed overflow failures", async () => {
    for (const scenario of ["zero", "overflow"] as const) {
      const observer = createSafeDownloadDiagnosticObserver();
      const stream = new PassThrough();
      const download = createSafeFileDownloader({
        requestDownload: async (_url, options) => {
          recordSyntheticRequest(options.diagnosticObserver);
          return response(stream);
        }
      });
      const pending = download(new URL("https://public.example/video.mp4"), destinationPath, {
        maxBytes: 4,
        diagnosticObserver: observer
      });
      stream.end(scenario === "zero" ? "" : "oversized");
      const error = await appError(pending);
      expect(error.code).toBe(scenario === "zero" ? API_ERROR_CODES.DOWNLOAD_FAILED : API_ERROR_CODES.FILE_TOO_LARGE);
      expect(observer.snapshot().at(-1)).toMatchObject({
        phase: "failed",
        boundedBytesCategory: scenario === "zero" ? "zero" : "over-limit",
        terminationCategory: scenario === "zero" ? "network" : "byte-limit"
      });
    }
  });

  it.each([
    ["timeout", new AppError(API_ERROR_CODES.EXTRACTION_FAILED, undefined, 504), "timeout"],
    ["network", new Error("synthetic network details must not escape"), "network"]
  ] as const)("localizes %s request failure without raw error data", async (_label, failure, termination) => {
    const observer = createSafeDownloadDiagnosticObserver();
    const download = createSafeFileDownloader({ requestDownload: async () => { throw failure; } });
    await expect(download(new URL("https://public.example/private?token=synthetic"), destinationPath, {
      maxBytes: 10,
      diagnosticObserver: observer
    })).rejects.toBe(failure);
    expect(observer.snapshot().at(-1)).toMatchObject({
      phase: "failed",
      terminationCategory: termination,
      safeErrorCode: failure instanceof AppError ? failure.code : API_ERROR_CODES.DOWNLOAD_FAILED
    });
    expect(JSON.stringify(observer.snapshot())).not.toMatch(/private|token|network details|public\.example/i);
  });

  it("localizes AbortSignal cancellation and cleans partial data", async () => {
    const observer = createSafeDownloadDiagnosticObserver();
    const controller = new AbortController();
    const stream = new PassThrough();
    const download = createSafeFileDownloader({ requestDownload: async () => response(stream) });
    const pending = download(new URL("https://public.example/video.mp4"), destinationPath, {
      maxBytes: 100,
      signal: controller.signal,
      diagnosticObserver: observer
    });
    stream.write("partial");
    await Promise.resolve();
    controller.abort();
    await appError(pending);
    expect(observer.snapshot().at(-1)).toMatchObject({
      phase: "failed",
      terminationCategory: "cancelled",
      cleanupResult: "success"
    });
  });

  it("distinguishes filesystem and cleanup failure without changing the safe error", async () => {
    const observer = createSafeDownloadDiagnosticObserver();
    const stream = new PassThrough();
    const download = createSafeFileDownloader({
      requestDownload: async () => response(stream, 3),
      linkFile: async () => { throw new Error("synthetic absolute path and token"); },
      removeFile: async () => { throw new Error("synthetic cleanup path"); }
    });
    const pending = download(new URL("https://public.example/video.mp4"), destinationPath, {
      maxBytes: 10,
      diagnosticObserver: observer
    });
    stream.end("new");
    const error = await appError(pending);
    expect(error.code).toBe(API_ERROR_CODES.DOWNLOAD_FAILED);
    expect(observer.snapshot().at(-1)).toMatchObject({
      phase: "failed",
      terminationCategory: "cleanup",
      cleanupResult: "failure",
      safeErrorCode: API_ERROR_CODES.DOWNLOAD_FAILED
    });
    expect(JSON.stringify(observer.snapshot())).not.toMatch(/absolute|token|cleanup path|public\.example/i);
  });

  it("reports filesystem failure when owned partial cleanup succeeds", async () => {
    const observer = createSafeDownloadDiagnosticObserver();
    const stream = new PassThrough();
    const download = createSafeFileDownloader({
      requestDownload: async () => response(stream, 3),
      linkFile: async () => { throw new Error("synthetic link failure"); }
    });
    const pending = download(new URL("https://public.example/video.mp4"), destinationPath, {
      maxBytes: 10,
      diagnosticObserver: observer
    });
    stream.end("new");
    await appError(pending);
    expect(observer.snapshot().at(-1)).toMatchObject({
      phase: "failed",
      terminationCategory: "filesystem",
      cleanupResult: "success",
      safeErrorCode: API_ERROR_CODES.DOWNLOAD_FAILED
    });
    expect(await exists(destinationPath)).toBe(false);
    expect(await exists(`${destinationPath}.download`)).toBe(false);
  });

  it("ignores a foreign throwing observer and cannot let it affect the request", async () => {
    const foreign = Object.freeze({ snapshot: () => { throw new Error("observer callback"); } }) as unknown as SafeDownloadDiagnosticObserver;
    const stream = new PassThrough();
    const download = createSafeFileDownloader({ requestDownload: async () => response(stream, 2) });
    const pending = download(new URL("https://public.example/video.mp4"), destinationPath, {
      maxBytes: 10,
      diagnosticObserver: foreign
    });
    stream.end("ok");
    await expect(pending).resolves.toMatchObject({ sizeBytes: 2 });
  });

  it("never exposes raw request/response objects or source-derived strings", () => {
    const observer = createSafeDownloadDiagnosticObserver();
    recordSafeDownloadDiagnostic(observer, {
      phase: "failed",
      approvedHostname: "unapproved",
      scheme: "https",
      effectivePort: 443,
      safeErrorCode: API_ERROR_CODES.DOWNLOAD_FAILED,
      terminationCategory: "validation"
    });
    const serialized = JSON.stringify(observer.snapshot());
    expect(serialized).not.toMatch(/https?:\/\/|expire|signature|authorization|referer|user-agent|stack|body|headers|path/i);
    expect(Object.keys(observer.snapshot()[0] ?? {}).sort()).toEqual([
      "approvedHostname",
      "boundedBytesCategory",
      "cleanupResult",
      "contentCategory",
      "contentLengthPresent",
      "effectivePort",
      "phase",
      "redirectCount",
      "requestCount",
      "safeErrorCode",
      "scheme",
      "statusClass",
      "terminationCategory"
    ].sort());
  });
});
