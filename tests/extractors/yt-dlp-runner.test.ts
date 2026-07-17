import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createYtDlpMetadataRunner, mapYtDlpProcessError } from "@/lib/extractors/yt-dlp/runner";
import { BoundedProcessError, type BoundedProcessRunOptions } from "@/lib/process/bounded-process";
import { API_ERROR_CODES } from "@/lib/types";

const roots = new Set<string>();
afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function root() {
  const value = await mkdtemp(path.join(os.tmpdir(), "videosave-ytdlp-runner-test-"));
  roots.add(value);
  return value;
}

function fixture() {
  return JSON.stringify({
    _type: "video",
    extractor_key: "Vimeo",
    id: "fixture",
    title: "Fixture",
    availability: "public",
    formats: [{
      format_id: "direct",
      protocol: "https",
      url: "https://media.example/video.mp4",
      ext: "mp4",
      vcodec: "h264",
      acodec: "aac"
    }]
  });
}

describe("controlled yt-dlp metadata runner", () => {
  it("uses fixed isolation arguments, guarded proxy, and removes scratch state", async () => {
    const temporaryRoot = await root();
    const calls: BoundedProcessRunOptions[] = [];
    const processRunner = vi.fn(async (options: BoundedProcessRunOptions) => {
      calls.push(options);
      return { stdout: calls.length === 1 ? "2026.07.04\n" : fixture(), stderr: "", stderrTruncated: false, durationMs: 1 };
    });
    const close = vi.fn(async () => undefined);
    let allowHostname: ((hostname: string) => boolean) | undefined;
    const runner = createYtDlpMetadataRunner({
      binaryPath: "/approved/yt-dlp",
      nodeEnv: "production",
      temporaryRoot,
      processRunner,
      guardFactory: async (options) => {
        allowHostname = options.allowHostname;
        return { proxyUrl: "http://127.0.0.1:41000", close };
      }
    });

    await expect(runner.extract("vimeo", new URL("https://vimeo.example/123"))).resolves.toMatchObject({ sourceId: "fixture" });
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual(expect.arrayContaining([
      "--ignore-config", "--no-config-locations", "--no-plugin-dirs", "--no-remote-components",
      "--no-js-runtimes", "--no-cookies", "--no-cookies-from-browser", "--no-netrc",
      "--no-exec", "--skip-download", "--dump-single-json", "--no-playlist"
    ]));
    expect(calls[1].args).not.toContain("--cookies");
    expect(calls[1].args).not.toContain("--netrc");
    expect(calls[1].args).not.toContain("--cookies-from-browser");
    expect(calls[1].args).not.toContain("--proxy-header");
    expect(calls[1].args.at(-1)).toBe("https://vimeo.example/123");
    expect(calls[1].env).not.toHaveProperty("HTTP_PROXY");
    expect(calls[1].env).not.toHaveProperty("XDG_CONFIG_DIRS");
    expect(calls[1].env.HOME).toContain(temporaryRoot);
    expect(close).toHaveBeenCalledOnce();
    expect(allowHostname?.("vimeo.com")).toBe(true);
    expect(allowHostname?.("player.vimeo.com")).toBe(true);
    expect(allowHostname?.("video.vimeocdn.com")).toBe(true);
    expect(allowHostname?.("vimeo.com.attacker.example")).toBe(false);
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  it("caches an exact successful version check", async () => {
    const temporaryRoot = await root();
    const processRunner = vi.fn(async () => ({ stdout: "2026.07.04\n", stderr: "", stderrTruncated: false, durationMs: 1 }));
    const runner = createYtDlpMetadataRunner({ binaryPath: "/approved/yt-dlp", nodeEnv: "production", temporaryRoot, processRunner });
    await runner.checkVersion();
    await runner.checkVersion();
    expect(processRunner).toHaveBeenCalledOnce();
  });

  it("fails closed on a version mismatch", async () => {
    const temporaryRoot = await root();
    const runner = createYtDlpMetadataRunner({
      binaryPath: "/approved/yt-dlp",
      nodeEnv: "production",
      temporaryRoot,
      processRunner: async () => ({ stdout: "2026.08.01\n", stderr: "", stderrTruncated: false, durationMs: 1 })
    });
    await expect(runner.checkVersion()).rejects.toMatchObject({ code: API_ERROR_CODES.EXTRACTOR_FAILED });
  });

  it("forwards AbortSignal to the bounded metadata process", async () => {
    const temporaryRoot = await root();
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const processRunner = vi.fn(async (options: BoundedProcessRunOptions) => {
      signals.push(options.signal);
      return { stdout: signals.length === 1 ? "2026.07.04\n" : fixture(), stderr: "", stderrTruncated: false, durationMs: 1 };
    });
    const runner = createYtDlpMetadataRunner({
      binaryPath: "/approved/yt-dlp",
      nodeEnv: "production",
      temporaryRoot,
      processRunner,
      guardFactory: async () => ({ proxyUrl: "http://127.0.0.1:41000", close: async () => undefined })
    });
    await runner.extract("vimeo", new URL("https://vimeo.com/123"), controller.signal);
    expect(signals).toEqual([undefined, controller.signal]);
  });

  it.each([
    ["Video is unavailable", API_ERROR_CODES.CONTENT_UNAVAILABLE],
    ["This is a private video", API_ERROR_CODES.PRIVATE_CONTENT],
    ["This video is password protected", API_ERROR_CODES.PRIVATE_CONTENT],
    ["Login required; use --cookies", API_ERROR_CODES.LOGIN_REQUIRED],
    ["This video is DRM protected", API_ERROR_CODES.DRM_PROTECTED],
    ["This video is not available in your country", API_ERROR_CODES.GEO_RESTRICTED],
    ["This video is age-restricted", API_ERROR_CODES.AGE_RESTRICTED],
    ["unknown raw failure https://signed.example/source", API_ERROR_CODES.EXTRACTOR_FAILED]
  ])("maps yt-dlp failure safely without returning stderr: %s", (stderr, code) => {
    const mapped = mapYtDlpProcessError(new BoundedProcessError("non-zero-exit", 1, null, stderr));
    expect(mapped.code).toBe(code);
    expect(mapped.message).not.toContain(stderr);
    expect(mapped.message).not.toMatch(/https?:\/\/|stderr/i);
  });

  it("maps bounded timeout and cancellation without inspecting raw stderr", () => {
    expect(mapYtDlpProcessError(new BoundedProcessError("timeout", null, "SIGKILL", "private URL")))
      .toMatchObject({ code: API_ERROR_CODES.EXTRACTOR_TIMEOUT });
    expect(mapYtDlpProcessError(new BoundedProcessError("aborted", null, "SIGTERM", "private URL")))
      .toMatchObject({ code: API_ERROR_CODES.JOB_CANCELLED });
  });
});
