import { describe, expect, it, vi } from "vitest";
import { createManifestRunner, type ManifestBodyFetcher } from "@/lib/extractors/manifest-runner";
import type { SafeBodyFetchResult } from "@/lib/http/safe-fetch";
import { API_ERROR_CODES } from "@/lib/types";

const url = new URL("https://v.redd.it/media42/DASHPlaylist.mpd");

function response(body = "<MPD/>", overrides: Partial<SafeBodyFetchResult> = {}): SafeBodyFetchResult {
  const encoded = Buffer.from(body);
  return {
    finalUrl: url,
    statusCode: 200,
    headers: { "content-type": "application/dash+xml" },
    contentType: "application/dash+xml",
    contentLength: encoded.length,
    body: encoded,
    sizeBytes: encoded.length,
    ...overrides
  };
}

function runner(fetchBody: ManifestBodyFetcher) {
  return createManifestRunner({
    fetchBody,
    maxBytes: 1024,
    maxRedirects: 2,
    defaultTimeoutSeconds: 5,
    maximumTimeoutSeconds: 10,
    requestProfile: "reddit-media-v1",
    contentTypes: new Set(["application/dash+xml"]),
    allowHostname: (hostname) => hostname === "v.redd.it"
  });
}

describe("generic bounded manifest runner", () => {
  it("forwards only repository-controlled transport policy and returns a typed document", async () => {
    const fetchBody = vi.fn<ManifestBodyFetcher>(async () => response());
    const signal = new AbortController().signal;
    await expect(runner(fetchBody).fetch(url, { timeoutSeconds: 7, signal })).resolves.toEqual({
      finalUrl: url,
      contentType: "application/dash+xml",
      body: Buffer.from("<MPD/>"),
      sizeBytes: 6
    });
    expect(fetchBody).toHaveBeenCalledWith(url, expect.objectContaining({
      maxBytes: 1024,
      timeoutSeconds: 7,
      maxRedirects: 2,
      requireHttps: true,
      requestProfile: "reddit-media-v1",
      signal
    }));
  });

  it("fails closed for status, Content-Type and body-size inconsistencies", async () => {
    for (const result of [
      response("x", { statusCode: 404 }),
      response("x", { contentType: "text/html" }),
      response("x", { sizeBytes: 2 })
    ]) {
      await expect(runner(async () => result).fetch(url)).rejects.toMatchObject({
        code: API_ERROR_CODES.EXTRACTOR_FAILED
      });
    }
  });

  it("rejects invalid construction and per-request bounds", async () => {
    expect(() => createManifestRunner({
      fetchBody: async () => response(),
      maxBytes: 0,
      maxRedirects: 2,
      defaultTimeoutSeconds: 5,
      maximumTimeoutSeconds: 10,
      requestProfile: "reddit-media-v1",
      contentTypes: new Set(["application/dash+xml"]),
      allowHostname: () => true
    })).toThrow(TypeError);
    await expect(runner(async () => response()).fetch(url, { timeoutSeconds: 11 })).rejects.toThrow(TypeError);
  });
});
