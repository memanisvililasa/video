import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileDeliveryRouteHandler } from "@/app/api/file/[id]/handler";
import type { Extractor } from "@/lib/extractors/types";
import { createVimeoExtractor, selectVimeoProgressiveFormats } from "@/lib/extractors/vimeo";
import { createYouTubeExtractor } from "@/lib/extractors/youtube";
import { selectYouTubeFormats } from "@/lib/extractors/youtube-formats";
import { parseYtDlpMetadataJson, type ParsedPlatformMetadata } from "@/lib/extractors/yt-dlp/parser";
import { createAudioExtractor } from "@/lib/ffmpeg/audio";
import { createCompatibleMp4Converter } from "@/lib/ffmpeg/convert";
import { createMediaProbe } from "@/lib/ffmpeg/probe";
import { createConfiguredMediaProcessRunner } from "@/lib/ffmpeg/process-runner";
import { createMediaRemux } from "@/lib/ffmpeg/remux";
import { createMediaMerge, type MergeAudioVideoOptions, type MergeAudioVideoResult } from "@/lib/ffmpeg/merge";
import type { ProcessingPreset } from "@/lib/ffmpeg/types";
import { createDownloadOrchestrationService } from "@/lib/jobs/download-orchestrator";
import { createMediaJobQueue } from "@/lib/jobs/queue";
import type { MediaJobSnapshot } from "@/lib/jobs/types";
import { createSafeFileDownloader, type SafeDownloadStreamResult } from "@/lib/http/safe-fetch";
import { createJobArtifactLifecycle } from "@/lib/storage/job-artifacts";
import { createFileRegistry } from "@/lib/storage/file-registry";
import { validateVideoUrl } from "@/lib/security/url-validation";
import { createSafeMediaDiagnosticRunner } from "@/tests/helpers/media-process-diagnostic";

const runFile = promisify(execFile);
const MAX_BYTES = 10 * 1024 * 1024;
let temporaryRoot: string;
let storageRoot: string;
let fixturePath: string;
let youtubeVideoPath: string;
let youtubeAudioPath: string;
let vimeoMetadata: ParsedPlatformMetadata;
let youtubeMetadata: ParsedPlatformMetadata;
let nextJob = 0;
let nextFile = 0;
let nextSource = 0;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-local-smoke-"));
  storageRoot = path.join(temporaryRoot, "storage");
  fixturePath = path.join(temporaryRoot, "fixture.mp4");
  youtubeVideoPath = path.join(temporaryRoot, "youtube-video.mp4");
  youtubeAudioPath = path.join(temporaryRoot, "youtube-audio.m4a");
  vimeoMetadata = parseYtDlpMetadataJson(
    await readFile(path.join(process.cwd(), "tests/fixtures/vimeo-public.json"), "utf8"),
    "vimeo"
  );
  youtubeMetadata = parseYtDlpMetadataJson(
    await readFile(path.join(process.cwd(), "tests/fixtures/youtube-public.json"), "utf8"),
    "youtube"
  );
  await mkdir(storageRoot);
  storageRoot = await realpath(storageRoot);
  await runFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-filter_threads", "1",
    "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
    "-t", "1", "-c:v", "mpeg4", "-q:v", "5", "-pix_fmt", "yuv420p", "-threads", "1",
    "-c:a", "aac", "-shortest",
    fixturePath
  ], { timeout: 20_000, maxBuffer: 128 * 1024 });
  await runFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-filter_threads", "1", "-f", "lavfi", "-i", "testsrc2=size=64x96:rate=10",
    "-t", "1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1",
    youtubeVideoPath
  ], { timeout: 20_000, maxBuffer: 128 * 1024 });
  await runFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "sine=frequency=800:sample_rate=48000",
    "-t", "1", "-vn", "-c:a", "aac", "-b:a", "128k", "-threads", "1",
    youtubeAudioPath
  ], { timeout: 20_000, maxBuffer: 128 * 1024 });
  const info = await lstat(fixturePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) throw new Error("Local smoke fixture is invalid.");
});

afterAll(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

function createHarness(extractorInput: Extractor | ((merge: (options: MergeAudioVideoOptions) => Promise<MergeAudioVideoResult>) => Extractor)) {
  const registry = createFileRegistry();
  const jobs = createMediaJobQueue({
    maxConcurrentJobs: 1,
    maxQueuedJobs: 5,
    terminalTtlMs: 60_000,
    createJobId: () => `job_local_smoke_${++nextJob}`
  });
  const diagnostic = createSafeMediaDiagnosticRunner(createConfiguredMediaProcessRunner({
    binaryPaths: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
    nodeEnv: "test",
    pathValue: process.env.PATH,
    killGraceMs: 1_000
  }));
  const processRunner = diagnostic.run;
  const getAllowedRoot = () => storageRoot;
  const probeMedia = createMediaProbe({
    runProcess: processRunner,
    getAllowedRoot,
    timeoutMs: 10_000,
    maxDurationSeconds: 60
  });
  const common = {
    runProcess: processRunner,
    probeMedia,
    getAllowedRoot,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_BYTES
  };
  const remuxMedia = createMediaRemux(common);
  const mergeSources = createMediaMerge(common);
  const convertMedia = createCompatibleMp4Converter({
    ...common,
    maxDurationSeconds: 60,
    threads: 1
  });
  const extractAudio = createAudioExtractor({
    ...common,
    maxDurationSeconds: 60,
    threads: 1
  });
  const extractor = typeof extractorInput === "function" ? extractorInput(mergeSources) : extractorInput;
  const service = createDownloadOrchestrationService({
    jobs,
    validateUrl: validateVideoUrl,
    getExtractor: () => extractor,
    cleanupExpiredFiles: async () => undefined,
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
        createFileId: () => `file_local_smoke_${++nextFile}`,
        createSourceId: () => `source_local_smoke_${++nextSource}`,
        getExpiresAt: () => new Date(Date.now() + 60_000).toISOString(),
        now: Date.now
      }
    ),
    probeMedia,
    remuxMedia,
    convertMedia,
    extractAudio,
    maxFileSizeBytes: MAX_BYTES,
    maxDurationSeconds: 60,
    metadataTimeoutSeconds: 5,
    downloadTimeoutSeconds: 5
  });
  return { service, jobs, registry, mediaFailure: diagnostic.failure };
}

function fixtureExtractor(): Extractor {
  return {
    id: "local-smoke-fixture",
    name: "Local smoke fixture",
    supports: () => true,
    async extract() {
      return {
        id: "local-smoke",
        originalUrl: "https://media.example.test/",
        title: "Local smoke fixture",
        platform: "direct-media",
        formats: [{ id: "direct-source", label: "MP4 source", ext: "mp4", hasAudio: true, hasVideo: true }]
      };
    },
    async download(_url, _formatId, context) {
      const target = path.join(context.workDir, "source.mp4");
      await copyFile(fixturePath, target);
      const sizeBytes = (await lstat(target)).size;
      context.onDownloadProgress?.(sizeBytes, sizeBytes);
      return { path: target, filename: "fixture.mp4", contentType: "video/mp4", sizeBytes };
    }
  };
}

function vimeoFixtureExtractor(extractCalls: URL[]): Extractor {
  return createVimeoExtractor({
    metadataRunner: {
      async extract(_platform, pageUrl) {
        extractCalls.push(new URL(pageUrl));
        return vimeoMetadata;
      }
    },
    async downloadToFile(url, destinationPath, options) {
      await copyFile(fixturePath, destinationPath);
      const sizeBytes = (await lstat(destinationPath)).size;
      options.onProgress?.(sizeBytes, sizeBytes);
      return {
        finalUrl: new URL(url),
        statusCode: 200,
        headers: { "content-type": "video/mp4", "content-length": String(sizeBytes) },
        contentType: "video/mp4",
        contentLength: sizeBytes,
        sizeBytes
      };
    }
  });
}

function youtubeFixtureExtractor(extractCalls: URL[], mergeSources: (options: MergeAudioVideoOptions) => Promise<MergeAudioVideoResult>): Extractor {
  return createYouTubeExtractor({
    metadataRunner: {
      async extract(_platform, pageUrl) {
        extractCalls.push(new URL(pageUrl));
        return { ...youtubeMetadata, title: "Синтетический YouTube #shorts" };
      }
    },
    async downloadToFile(url, destinationPath, options) {
      const source = url.searchParams.get("fixture") === "audio" ? youtubeAudioPath : youtubeVideoPath;
      await copyFile(source, destinationPath);
      const sizeBytes = (await lstat(destinationPath)).size;
      options.onProgress?.(sizeBytes, sizeBytes);
      return {
        finalUrl: new URL(url),
        statusCode: 200,
        headers: { "content-type": "video/mp4", "content-length": String(sizeBytes) },
        contentType: url.searchParams.get("fixture") === "audio" ? "audio/mp4" : "video/mp4",
        contentLength: sizeBytes,
        sizeBytes
      };
    },
    mergeSources
  });
}

async function waitForTerminal(get: () => Promise<MediaJobSnapshot>): Promise<MediaJobSnapshot> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await get();
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Local media smoke timed out.");
}

describe("personal-use local real-media pipeline", () => {
  it.each([
    ["original", "mp4"],
    ["remux-to-mp4", "mp4"],
    ["compatible-mp4", "mp4"],
    ["audio-only", "m4a"]
  ] as const)("processes, validates, publishes, and delivers the %s preset", async (preset, extension) => {
    const harness = createHarness(fixtureExtractor());
    const enqueued = await harness.service.enqueueDownloadJob({
      url: "https://media.example.test/fixture.mp4",
      formatId: "direct-source",
      processingPreset: preset,
      rightsConfirmed: true
    });
    const ready = await waitForTerminal(() => harness.service.getDownloadJob(enqueued.jobId));
    if (ready.status !== "ready" || !ready.result) {
      throw new Error(
        `Local smoke ${preset} ended in ${ready.status}:${ready.error?.code ?? "none"}; media=${harness.mediaFailure()}.`
      );
    }
    expect(ready).toMatchObject({ status: "ready", progress: 100, processingPreset: preset });
    const result = ready.result;
    expect(result.filename).toMatch(new RegExp(`\\.${extension}$`));
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.media.durationSeconds).toBeGreaterThan(0);
    if (preset === "audio-only") {
      expect(result.media).toMatchObject({ hasAudio: true, hasVideo: false, audioCodec: "aac" });
    } else {
      expect(result.media).toMatchObject({ hasAudio: true, hasVideo: true });
    }

    const handler = createFileDeliveryRouteHandler({
      checkRateLimit: () => ({
        ok: true,
        allowed: true,
        bucket: "file",
        key: "file:local-smoke",
        limit: 1,
        remaining: 1,
        resetAt: Date.now() + 1_000,
        retryAfterSeconds: 0
      }),
      getFile: async (fileId) => {
        const file = harness.registry.getRegisteredFile(fileId);
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
    expect(response.headers.get("content-disposition")).toContain(`.${extension}`);
    const delivered = Buffer.from(await response.arrayBuffer());
    expect(delivered.byteLength).toBe(result.sizeBytes);
    expect(delivered.equals(await readFile(harness.registry.getRegisteredFile(result.fileId)!.path))).toBe(true);
  });

  it.each([
    ["original", "mp4"],
    ["compatible-mp4", "mp4"],
    ["audio-only", "m4a"]
  ] as const)("runs deterministic Vimeo re-extraction through %s and final-only delivery", async (preset, extension) => {
    const extractionPages: URL[] = [];
    const harness = createHarness(vimeoFixtureExtractor(extractionPages));
    const selected = selectVimeoProgressiveFormats(vimeoMetadata, MAX_BYTES)[0];
    const enqueued = await harness.service.enqueueDownloadJob({
      url: "https://player.vimeo.com/video/123456789",
      formatId: selected.stableId,
      processingPreset: preset,
      rightsConfirmed: true
    });
    const ready = await waitForTerminal(() => harness.service.getDownloadJob(enqueued.jobId));
    if (ready.status !== "ready" || !ready.result) {
      throw new Error(`Vimeo smoke ${preset} ended in ${ready.status}:${ready.error?.code ?? "none"}.`);
    }
    expect(extractionPages.map((url) => url.toString())).toEqual([
      "https://vimeo.com/123456789",
      "https://vimeo.com/123456789"
    ]);
    expect(ready.result.filename).toMatch(new RegExp(`\\.${extension}$`));
    expect(ready.result.downloadUrl).toBe(`/api/file/${ready.result.fileId}`);
    expect(JSON.stringify(ready)).not.toMatch(/media\.example|signature=|sourceUrl/i);
    expect(harness.registry.listRegisteredFiles().every((file) => file.kind === "final")).toBe(true);
  });

  it.each([
    ["original", "mp4"],
    ["compatible-mp4", "mp4"],
    ["audio-only", "m4a"]
  ] as const)("runs deterministic YouTube split-stream re-extraction through %s and final-only delivery", async (preset, extension) => {
    const extractionPages: URL[] = [];
    const harness = createHarness((mergeSources) => youtubeFixtureExtractor(extractionPages, mergeSources));
    const selected = selectYouTubeFormats(youtubeMetadata, MAX_BYTES).find((format) => format.qualityTier === 1080)!;
    const enqueued = await harness.service.enqueueDownloadJob({
      url: "https://youtube.com/shorts/AbCdEfGhI_1?si=deterministic-tracking",
      formatId: selected.stableId,
      processingPreset: preset,
      rightsConfirmed: true
    });
    const ready = await waitForTerminal(() => harness.service.getDownloadJob(enqueued.jobId));
    if (ready.status !== "ready" || !ready.result) {
      throw new Error(`YouTube smoke ${preset} ended in ${ready.status}:${ready.error?.code ?? "none"}; media=${harness.mediaFailure()}.`);
    }
    expect(extractionPages.map((url) => url.toString())).toEqual([
      "https://www.youtube.com/watch?v=AbCdEfGhI_1",
      "https://www.youtube.com/watch?v=AbCdEfGhI_1"
    ]);
    expect(ready.result.filename).toMatch(new RegExp(`\\.${extension}$`));
    expect(ready.result.downloadUrl).toBe(`/api/file/${ready.result.fileId}`);
    if (preset === "audio-only") {
      expect(ready.result.media).toMatchObject({ hasVideo: false, hasAudio: true, audioCodec: "aac" });
    } else {
      expect(ready.result.media).toMatchObject({ hasVideo: true, hasAudio: true, width: 64, height: 96 });
    }
    expect(JSON.stringify(ready)).not.toMatch(/googlevideo|videoplayback|sourceUrl|si=|fixture=/i);
    expect(harness.registry.listRegisteredFiles().every((file) => file.kind === "final")).toBe(true);

    const stored = harness.registry.getRegisteredFile(ready.result.fileId);
    expect(stored).toMatchObject({ kind: "final", sizeBytes: ready.result.sizeBytes });
    expect(stored && await lstat(stored.path)).toMatchObject({ size: ready.result.sizeBytes });
    const handler = createFileDeliveryRouteHandler({
      checkRateLimit: () => ({
        ok: true,
        allowed: true,
        bucket: "file",
        key: "file:youtube-smoke",
        limit: 1,
        remaining: 1,
        resetAt: Date.now() + 1_000,
        retryAfterSeconds: 0
      }),
      getFile: async (fileId) => {
        const file = harness.registry.getRegisteredFile(fileId);
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
      new NextRequest(`http://127.0.0.1/api/file/${ready.result.fileId}`),
      { params: Promise.resolve({ id: ready.result.fileId }) }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(Buffer.from(await response.arrayBuffer()).byteLength).toBe(ready.result.sizeBytes);
  });

  it("cancels an active bounded download and removes its partial file", async () => {
    const stream = new PassThrough();
    const downloader = createSafeFileDownloader({
      requestDownload: async () => ({
        finalUrl: new URL("https://media.example.test/fixture.mp4"),
        statusCode: 200,
        headers: {},
        contentType: "video/mp4",
        stream: stream as unknown as http.IncomingMessage
      } satisfies SafeDownloadStreamResult)
    });
    const extractor: Extractor = {
      ...fixtureExtractor(),
      async download(url, _formatId, context) {
        return downloader(url, path.join(context.workDir, "source.mp4"), {
          maxBytes: MAX_BYTES,
          signal: context.signal,
          onProgress: context.onDownloadProgress
        }).then((downloaded) => ({
          path: path.join(context.workDir, "source.mp4"),
          filename: "fixture.mp4",
          contentType: downloaded.contentType ?? "video/mp4",
          sizeBytes: downloaded.sizeBytes
        }));
      }
    };
    const harness = createHarness(extractor);
    const enqueued = await harness.service.enqueueDownloadJob({
      url: "https://media.example.test/fixture.mp4",
      formatId: "direct-source",
      processingPreset: "compatible-mp4",
      rightsConfirmed: true
    });
    stream.write("partial");
    let running: MediaJobSnapshot | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      running = await harness.service.getDownloadJob(enqueued.jobId);
      if (running.status === "running" && running.progress >= 20) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(running?.status).toBe("running");
    await harness.service.cancelDownloadJob(enqueued.jobId);
    const cancelled = await waitForTerminal(() => harness.service.getDownloadJob(enqueued.jobId));
    expect(cancelled.status).toBe("cancelled");
    const jobDirectory = path.join(storageRoot, "jobs", enqueued.jobId);
    await expect(lstat(path.join(jobDirectory, "source.mp4.download"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels an active Vimeo download and removes its partial file", async () => {
    const stream = new PassThrough();
    const downloader = createSafeFileDownloader({
      requestDownload: async () => ({
        finalUrl: new URL("https://media.example.test/fresh-1080.mp4"),
        statusCode: 200,
        headers: {},
        contentType: "video/mp4",
        stream: stream as unknown as http.IncomingMessage
      } satisfies SafeDownloadStreamResult)
    });
    const extractor = createVimeoExtractor({
      metadataRunner: { extract: async () => vimeoMetadata },
      downloadToFile: downloader
    });
    const selected = selectVimeoProgressiveFormats(vimeoMetadata, MAX_BYTES)[0];
    const harness = createHarness(extractor);
    const enqueued = await harness.service.enqueueDownloadJob({
      url: "https://vimeo.com/123456789",
      formatId: selected.stableId,
      processingPreset: "compatible-mp4",
      rightsConfirmed: true
    });
    stream.write("partial");
    let running: MediaJobSnapshot | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      running = await harness.service.getDownloadJob(enqueued.jobId);
      if (running.status === "running" && running.progress >= 10) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(running?.status).toBe("running");
    await harness.service.cancelDownloadJob(enqueued.jobId);
    const cancelled = await waitForTerminal(() => harness.service.getDownloadJob(enqueued.jobId));
    expect(cancelled.status).toBe("cancelled");
    const jobDirectory = path.join(storageRoot, "jobs", enqueued.jobId);
    await expect(lstat(path.join(jobDirectory, "source.mp4.download"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(harness.registry.listRegisteredFiles().filter((file) => file.jobId === enqueued.jobId)).toEqual([]);
  });
});
