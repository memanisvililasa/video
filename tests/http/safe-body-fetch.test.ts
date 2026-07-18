import { PassThrough } from "node:stream";
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import {
  createSafeBodyFetcher,
  type SafeDownloadStreamResult
} from "@/lib/http/safe-fetch";
import { API_ERROR_CODES } from "@/lib/types";

function response(stream: PassThrough, contentLength?: number): SafeDownloadStreamResult {
  return {
    finalUrl: new URL("https://www.reddit.com/comments/abc123/.json"),
    statusCode: 200,
    headers: contentLength === undefined ? {} : { "content-length": String(contentLength) },
    contentType: "application/json",
    contentLength,
    stream: stream as unknown as http.IncomingMessage
  };
}

describe("bounded safe response body fetch", () => {
  it("collects a bounded body and forwards the fixed request policy", async () => {
    const stream = new PassThrough();
    const requestBody = vi.fn(async () => response(stream, 7));
    const fetchBody = createSafeBodyFetcher({ requestBody });
    const allowHostname = (hostname: string) => hostname === "www.reddit.com";
    const pending = fetchBody(new URL("https://www.reddit.com/comments/abc123/.json"), {
      maxBytes: 16,
      requireHttps: true,
      maxRedirects: 2,
      requestProfile: "reddit-public-v1",
      allowHostname
    });
    stream.end("{\"x\":1}");

    await expect(pending).resolves.toMatchObject({ sizeBytes: 7, body: Buffer.from("{\"x\":1}") });
    expect(requestBody).toHaveBeenCalledWith(
      new URL("https://www.reddit.com/comments/abc123/.json"),
      expect.objectContaining({
        requireHttps: true,
        maxRedirects: 2,
        requestProfile: "reddit-public-v1",
        allowHostname
      })
    );
  });

  it("rejects declared and streamed oversized bodies", async () => {
    const declared = new PassThrough();
    const declaredFetch = createSafeBodyFetcher({ requestBody: async () => response(declared, 100) });
    await expect(declaredFetch(new URL("https://www.reddit.com/"), { maxBytes: 8 })).rejects.toMatchObject({
      code: API_ERROR_CODES.FILE_TOO_LARGE
    });

    const streamed = new PassThrough();
    const streamedFetch = createSafeBodyFetcher({ requestBody: async () => response(streamed) });
    const pending = streamedFetch(new URL("https://www.reddit.com/"), { maxBytes: 4 });
    streamed.end("oversized");
    await expect(pending).rejects.toMatchObject({ code: API_ERROR_CODES.FILE_TOO_LARGE });
  });

  it("rejects an incomplete body and aborts an active body read", async () => {
    const incomplete = new PassThrough();
    const incompleteFetch = createSafeBodyFetcher({ requestBody: async () => response(incomplete, 10) });
    const short = incompleteFetch(new URL("https://www.reddit.com/"), { maxBytes: 20 });
    incomplete.end("short");
    await expect(short).rejects.toMatchObject({ code: API_ERROR_CODES.EXTRACTION_FAILED });

    const active = new PassThrough();
    const controller = new AbortController();
    const abortingFetch = createSafeBodyFetcher({ requestBody: async () => response(active) });
    const pending = abortingFetch(new URL("https://www.reddit.com/"), {
      maxBytes: 20,
      signal: controller.signal
    });
    active.write("partial");
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AppError);
    await expect(pending).rejects.toMatchObject({ code: API_ERROR_CODES.EXTRACTION_FAILED });
  });

  it("rejects invalid in-memory limits before a request", async () => {
    const requestBody = vi.fn();
    const fetchBody = createSafeBodyFetcher({ requestBody });
    await expect(fetchBody(new URL("https://www.reddit.com/"), { maxBytes: 0 })).rejects.toThrow(TypeError);
    expect(requestBody).not.toHaveBeenCalled();
  });
});
