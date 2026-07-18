import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ERROR_CODES } from "@/lib/types";
import { createMediaMerge } from "@/lib/ffmpeg/merge";
import { MediaProcessError } from "@/lib/ffmpeg/process-runner";
import type { MediaProbeResult, MediaProcessRunOptions } from "@/lib/ffmpeg/types";

const roots = new Set<string>();
afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

function probe(kind: "video" | "audio" | "merged"): MediaProbeResult {
  const video = kind !== "audio";
  const audio = kind !== "video";
  return {
    durationSeconds: 1,
    formatName: "mov,mp4,m4a,3gp,3g2,mj2",
    containerFormats: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
    sizeBytes: 4,
    hasVideo: video,
    hasAudio: audio,
    videoStreams: video ? [{ index: 0, codec: "h264", width: 1080, height: 1920, frameRate: { numerator: 30, denominator: 1, value: 30 } }] : [],
    audioStreams: audio ? [{ index: video ? 1 : 0, codec: "aac", channels: 2 }] : [],
    width: video ? 1080 : undefined,
    height: video ? 1920 : undefined,
    videoCodec: video ? "h264" : undefined,
    audioCodec: audio ? "aac" : undefined,
    frameRate: video ? { numerator: 30, denominator: 1, value: 30 } : undefined,
    format: {
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      containerFormats: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
      durationSeconds: 1,
      sizeBytes: 4
    }
  };
}

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "videosave-merge-test-"));
  roots.add(root);
  const job = path.join(root, "job");
  await mkdir(job);
  const videoPath = path.join(job, "video.mp4");
  const audioPath = path.join(job, "audio.mp4");
  await Promise.all([writeFile(videoPath, "video"), writeFile(audioPath, "audio")]);
  return { root, job, videoPath, audioPath, outputPath: path.join(job, "source.mp4") };
}

describe("bounded local YouTube audio/video merge", () => {
  it("uses fixed stream-copy arguments, validates output, and atomically publishes", async () => {
    const files = await workspace();
    const calls: MediaProcessRunOptions[] = [];
    const runProcess = vi.fn(async (options: MediaProcessRunOptions) => {
      calls.push(options);
      await writeFile(options.args.at(-1)!, "merged");
      return { exitCode: 0 as const, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 1 };
    });
    const merge = createMediaMerge({
      runProcess,
      probeMedia: async (candidate) => candidate.endsWith("video.mp4") ? probe("video") : candidate.endsWith("audio.mp4") ? probe("audio") : probe("merged"),
      getAllowedRoot: () => files.root,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024
    });
    const result = await merge({ ...files, container: "mp4" });
    expect(result).toMatchObject({ sizeBytes: 6 });
    expect(path.basename(result.outputPath)).toBe("source.mp4");
    expect(await readFile(files.outputPath, "utf8")).toBe("merged");
    expect(calls[0]?.tool).toBe("ffmpeg");
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      "-nostdin", "-protocol_whitelist", "file", "-map", "0:V:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "copy", "-shortest", "-f", "mp4"
    ]));
    expect(calls[0]?.args.join(" ")).not.toMatch(/https?:|cookie|header|shell/i);
  });

  it.each([
    ["aborted", API_ERROR_CODES.JOB_CANCELLED],
    ["timeout", API_ERROR_CODES.PROCESSING_TIMEOUT],
    ["spawn", API_ERROR_CODES.FFMPEG_NOT_AVAILABLE],
    ["non-zero-exit", API_ERROR_CODES.MERGE_FAILED]
  ] as const)("maps %s safely and removes partial output", async (reason, code) => {
    const files = await workspace();
    const partial = path.join(files.job, "source.partial.mp4");
    const merge = createMediaMerge({
      runProcess: async () => {
        await writeFile(partial, "partial");
        throw new MediaProcessError({ tool: "ffmpeg", reason, stderr: "raw internal path and media URL" });
      },
      probeMedia: async (candidate) => candidate.endsWith("video.mp4") ? probe("video") : probe("audio"),
      getAllowedRoot: () => files.root,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024
    });
    await expect(merge({ ...files, container: "mp4" })).rejects.toMatchObject({ code });
    await expect(readFile(partial)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(files.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an audio-bearing video input before FFmpeg", async () => {
    const files = await workspace();
    const runProcess = vi.fn();
    const merge = createMediaMerge({
      runProcess,
      probeMedia: async () => probe("merged"),
      getAllowedRoot: () => files.root,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024
    });
    await expect(merge({ ...files, container: "mp4" })).rejects.toMatchObject({ code: API_ERROR_CODES.MERGE_FAILED });
    expect(runProcess).not.toHaveBeenCalled();
  });
});
