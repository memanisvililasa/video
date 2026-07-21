import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { createTikTokInternalPipeline } from "@/lib/extractors/tiktok-internal-pipeline";
import type { TikTokMediaAdapter } from "@/lib/extractors/tiktok-media";
import type { TikTokInternalFormat } from "@/lib/extractors/tiktok-media-manifest";
import type { CompatibleMp4Result, MediaProbeResult } from "@/lib/ffmpeg/types";
import { createJobArtifactLifecycle } from "@/lib/storage/job-artifacts";
import { createFileRegistry } from "@/lib/storage/file-registry";
import { API_ERROR_CODES } from "@/lib/types";

const FORMAT: TikTokInternalFormat = Object.freeze({
  id: `ttf_${"a".repeat(43)}`,
  kind: "progressive",
  container: "mp4",
  codecFamily: "h264",
  width: 576,
  height: 1024,
  fps: 30,
  audioPresence: "present",
  compatibility: Object.freeze({ original: true, compatibleMp4: true, streamCopyCandidate: true }),
  staleMarker: "fresh"
});

function probe(hasAudio = true): MediaProbeResult {
  const video = {
    index: 0,
    codec: "h264",
    width: 576,
    height: 1024,
    attachedPicture: false,
    frameRate: { numerator: 30, denominator: 1, value: 30 },
    durationSeconds: 1
  };
  const audio = {
    index: 1,
    codec: "aac",
    sampleRate: 48_000,
    channels: 2,
    durationSeconds: 1
  };
  return {
    durationSeconds: 1,
    formatName: "mov,mp4,m4a,3gp,3g2,mj2",
    containerFormats: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
    sizeBytes: 9,
    bitRate: 1_000_000,
    hasVideo: true,
    hasAudio,
    videoStreams: [video],
    audioStreams: hasAudio ? [audio] : [],
    width: 576,
    height: 1024,
    videoCodec: "h264",
    ...(hasAudio ? { audioCodec: "aac" } : {}),
    frameRate: video.frameRate,
    format: {
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      containerFormats: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
      durationSeconds: 1,
      sizeBytes: 9,
      bitRate: 1_000_000
    }
  };
}

let temporaryRoot: string;
let storageRoot: string;
let nextFile: number;
let nextSource: number;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-tiktok-pipeline-"));
  storageRoot = path.join(temporaryRoot, "storage");
  await mkdir(storageRoot);
  storageRoot = await realpath(storageRoot);
  nextFile = 0;
  nextSource = 0;
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

function adapter(overrides: Partial<TikTokMediaAdapter> = {}): TikTokMediaAdapter {
  return {
    async analyze() {
      return {
        title: "Synthetic",
        durationSeconds: 1,
        width: 576,
        height: 1024,
        orientation: "portrait",
        formats: [FORMAT]
      };
    },
    async download(_url, _formatId, context) {
      const sourcePath = path.join(context.workDir, "source.mp4");
      await writeFile(sourcePath, "synthetic");
      return {
        path: sourcePath,
        filename: "tiktok-video.mp4",
        contentType: "video/mp4",
        sizeBytes: 9,
        format: FORMAT
      };
    },
    ...overrides
  };
}

function harness(options: Readonly<{
  mediaAdapter?: TikTokMediaAdapter;
  probeMedia?: (candidate: string) => Promise<MediaProbeResult>;
  compatibleMetadata?: MediaProbeResult;
}> = {}) {
  const registry = createFileRegistry();
  const probeMedia = vi.fn(options.probeMedia ?? (async () => probe()));
  const convertMedia = vi.fn(async ({ inputPath, outputPath }): Promise<CompatibleMp4Result> => {
    await copyFile(inputPath, outputPath);
    const metadata = options.compatibleMetadata ?? probe();
    return {
      preset: "compatible-mp4",
      input: probe(),
      output: metadata,
      outputPath,
      sizeBytes: (await lstat(outputPath)).size,
      targetWidth: 576,
      targetHeight: 1024,
      videoEncoder: "libx264",
      audioEncoder: metadata.hasAudio ? "aac" : null,
      threads: 2
    };
  });
  const execute = createTikTokInternalPipeline({
    adapter: options.mediaAdapter ?? adapter(),
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
        createFileId: () => `file_tiktok_${++nextFile}`,
        createSourceId: () => `source_tiktok_${++nextSource}`,
        getExpiresAt: () => new Date(Date.now() + 60_000).toISOString(),
        now: Date.now
      }
    ),
    probeMedia,
    convertMedia,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxDurationSeconds: 60,
    metadataTimeoutSeconds: 5,
    downloadTimeoutSeconds: 5
  });
  return { execute, registry, probeMedia, convertMedia };
}

const REQUEST = {
  jobId: "job_tiktok_internal_1",
  url: new URL("https://www.tiktok.com/@synthetic/video/7000000000000000001"),
  formatId: FORMAT.id
};

describe("internal-only TikTok processing and publication pipeline", () => {
  it("publishes original atomically and leaves only a final registered artifact", async () => {
    const test = harness();
    const result = await test.execute({ ...REQUEST, preset: "original" });
    expect(result).toMatchObject({
      fileId: "file_tiktok_1",
      filename: "tiktok-video.mp4",
      contentType: "video/mp4",
      preset: "original",
      media: { width: 576, height: 1024, hasAudio: true, videoCodec: "h264", audioCodec: "aac" }
    });
    expect(JSON.stringify(result)).not.toMatch(/https?:\/\/|7000000000000000001|source\.mp4|storage|signature|expire=/i);
    const files = test.registry.listRegisteredFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ kind: "final", id: result.fileId });
    expect(await readFile(files[0].path, "utf8")).toBe("synthetic");
  });

  it("runs compatible MP4 processing while preserving vertical silent-video truth", async () => {
    const silent = probe(false);
    const test = harness({
      probeMedia: async () => silent,
      compatibleMetadata: silent
    });
    const result = await test.execute({ ...REQUEST, jobId: "job_tiktok_internal_2", preset: "compatible-mp4" });
    expect(result).toMatchObject({
      preset: "compatible-mp4",
      media: { width: 576, height: 1024, hasAudio: false, videoCodec: "h264" }
    });
    expect(test.convertMedia).toHaveBeenCalledOnce();
    expect(test.registry.listRegisteredFiles()).toHaveLength(1);
  });

  it("discards every artifact after ffprobe rejection", async () => {
    const test = harness({
      probeMedia: async () => ({ ...probe(), hasVideo: false, videoStreams: [], width: undefined, height: undefined })
    });
    await expect(test.execute({ ...REQUEST, jobId: "job_tiktok_internal_3", preset: "original" }))
      .rejects.toMatchObject({ code: API_ERROR_CODES.OUTPUT_INVALID });
    expect(test.registry.listRegisteredFiles()).toEqual([]);
    await expect(lstat(path.join(storageRoot, "jobs", "job_tiktok_internal_3"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps cancellation safely and removes partial internal state", async () => {
    const controller = new AbortController();
    const cancelling = adapter({
      async download() {
        controller.abort();
        throw new AppError(API_ERROR_CODES.JOB_CANCELLED);
      }
    });
    const test = harness({ mediaAdapter: cancelling });
    await expect(test.execute({
      ...REQUEST,
      jobId: "job_tiktok_internal_4",
      preset: "original",
      signal: controller.signal
    })).rejects.toMatchObject({ code: API_ERROR_CODES.JOB_CANCELLED });
    expect(test.registry.listRegisteredFiles()).toEqual([]);
    await expect(lstat(path.join(storageRoot, "jobs", "job_tiktok_internal_4"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
