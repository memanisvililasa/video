import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileDeliveryRouteHandler } from "@/app/api/file/[id]/handler";
import { createTikTokInternalPipeline } from "@/lib/extractors/tiktok-internal-pipeline";
import type { TikTokMediaAdapter } from "@/lib/extractors/tiktok-media";
import type { TikTokInternalFormat } from "@/lib/extractors/tiktok-media-manifest";
import { createCompatibleMp4Converter } from "@/lib/ffmpeg/convert";
import { createMediaProbe } from "@/lib/ffmpeg/probe";
import { createConfiguredMediaProcessRunner } from "@/lib/ffmpeg/process-runner";
import { createJobArtifactLifecycle } from "@/lib/storage/job-artifacts";
import { createFileRegistry } from "@/lib/storage/file-registry";

const runFile = promisify(execFile);
const MAX_BYTES = 10 * 1024 * 1024;
const FORMAT: TikTokInternalFormat = Object.freeze({
  id: `ttf_${"b".repeat(43)}`,
  kind: "progressive",
  container: "mp4",
  codecFamily: "h264",
  width: 64,
  height: 96,
  fps: 10,
  audioPresence: "unknown",
  compatibility: Object.freeze({ original: true, compatibleMp4: true, streamCopyCandidate: true }),
  staleMarker: "fresh"
});

let temporaryRoot: string;
let storageRoot: string;
let audioVideoPath: string;
let silentVideoPath: string;
let nextFile = 0;
let nextSource = 0;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-tiktok-internal-smoke-"));
  storageRoot = path.join(temporaryRoot, "storage");
  audioVideoPath = path.join(temporaryRoot, "portrait-audio.mp4");
  silentVideoPath = path.join(temporaryRoot, "portrait-silent.mp4");
  await mkdir(storageRoot);
  storageRoot = await realpath(storageRoot);
  await runFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-filter_threads", "1",
    "-f", "lavfi", "-i", "testsrc2=size=64x96:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=900:sample_rate=48000",
    "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1",
    "-c:a", "aac", "-shortest", audioVideoPath
  ], { timeout: 20_000, maxBuffer: 128 * 1024 });
  await runFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-filter_threads", "1",
    "-f", "lavfi", "-i", "testsrc2=size=64x96:rate=10",
    "-t", "1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1",
    silentVideoPath
  ], { timeout: 20_000, maxBuffer: 128 * 1024 });
});

afterAll(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

function adapter(sourcePath: string): TikTokMediaAdapter {
  return Object.freeze({
    async analyze() {
      return Object.freeze({
        title: "Synthetic TikTok",
        durationSeconds: 1,
        width: 64,
        height: 96,
        orientation: "portrait" as const,
        formats: Object.freeze([FORMAT])
      });
    },
    async download(_url, formatId, context) {
      if (formatId !== FORMAT.id) throw new Error("Synthetic format mismatch.");
      const destination = path.join(context.workDir, "source.mp4");
      await copyFile(sourcePath, destination);
      return Object.freeze({
        path: destination,
        filename: "tiktok-video.mp4",
        contentType: "video/mp4",
        sizeBytes: (await lstat(destination)).size,
        format: FORMAT
      });
    }
  });
}

function harness(sourcePath: string) {
  const registry = createFileRegistry();
  const processRunner = createConfiguredMediaProcessRunner({
    binaryPaths: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
    nodeEnv: "test",
    pathValue: process.env.PATH,
    killGraceMs: 1_000
  });
  const getAllowedRoot = () => storageRoot;
  const probeMedia = createMediaProbe({
    runProcess: processRunner,
    getAllowedRoot,
    timeoutMs: 10_000,
    maxDurationSeconds: 60
  });
  const convertMedia = createCompatibleMp4Converter({
    runProcess: processRunner,
    probeMedia,
    getAllowedRoot,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_BYTES,
    maxDurationSeconds: 60,
    threads: 1
  });
  const execute = createTikTokInternalPipeline({
    adapter: adapter(sourcePath),
    createArtifacts: ({ jobId, maxFileSizeBytes }) => createJobArtifactLifecycle(
      { jobId, maxFileSizeBytes },
      {
        ensureJobDirectory: async (id) => {
          const directory = path.join(storageRoot, "jobs", id);
          await mkdir(directory, { recursive: true });
          return directory;
        },
        getStorageRoot: () => storageRoot,
        getRelativeStoragePath: (candidate) => path.relative(storageRoot, candidate),
        registerFile: registry.registerFile,
        deleteRegisteredFile: registry.deleteRegisteredFile,
        createFileId: () => `file_tiktok_smoke_${++nextFile}`,
        createSourceId: () => `source_tiktok_smoke_${++nextSource}`,
        getExpiresAt: () => new Date(Date.now() + 60_000).toISOString(),
        now: Date.now
      }
    ),
    probeMedia,
    convertMedia,
    maxFileSizeBytes: MAX_BYTES,
    maxDurationSeconds: 60,
    metadataTimeoutSeconds: 5,
    downloadTimeoutSeconds: 5
  });
  return { execute, registry };
}

describe("Stage 8.10B local synthetic media smoke", () => {
  it("publishes and delivers an original portrait progressive MP4", async () => {
    const test = harness(audioVideoPath);
    const result = await test.execute({
      jobId: "job_tiktok_smoke_original",
      url: new URL("https://www.tiktok.com/@synthetic/video/7000000000000000001"),
      formatId: FORMAT.id,
      preset: "original"
    });
    expect(result).toMatchObject({
      preset: "original",
      media: { width: 64, height: 96, hasAudio: true, videoCodec: "h264", audioCodec: "aac" }
    });
    expect(JSON.stringify(result)).not.toMatch(/tiktok\.com|7000000000000000001|sourceUrl|locator|signature/i);
    const handler = createFileDeliveryRouteHandler({
      checkRateLimit: () => ({
        ok: true,
        allowed: true,
        bucket: "file",
        key: "file:tiktok-internal-smoke",
        limit: 1,
        remaining: 1,
        resetAt: Date.now() + 1_000,
        retryAfterSeconds: 0
      }),
      getFile: async (fileId) => {
        const file = test.registry.getRegisteredFile(fileId);
        if (!file || file.kind !== "final") return null;
        return {
          fileId: file.id,
          filename: file.filename,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
          expiresAt: file.expiresAt,
          stream: createReadStream(file.path),
          close: async () => undefined
        };
      }
    });
    const response = await handler(
      new NextRequest(`http://127.0.0.1/api/file/${result.fileId}`),
      { params: Promise.resolve({ id: result.fileId }) }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await response.arrayBuffer()).equals(
      await readFile(test.registry.getRegisteredFile(result.fileId)!.path)
    )).toBe(true);
  });

  it("converts portrait silent input without inventing an audio track", async () => {
    const test = harness(silentVideoPath);
    const result = await test.execute({
      jobId: "job_tiktok_smoke_compatible",
      url: new URL("https://www.tiktok.com/@synthetic/video/7000000000000000002"),
      formatId: FORMAT.id,
      preset: "compatible-mp4"
    });
    expect(result).toMatchObject({
      preset: "compatible-mp4",
      media: { width: 64, height: 96, hasAudio: false, videoCodec: "h264" }
    });
    expect(test.registry.listRegisteredFiles()).toHaveLength(1);
    expect(test.registry.listRegisteredFiles()[0]).toMatchObject({ kind: "final", contentType: "video/mp4" });
  });
});
