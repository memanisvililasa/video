import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type { Extractor } from "@/lib/extractors/types";
import type {
  AudioExtractionResult,
  CompatibleMp4Result,
  MediaProbeResult,
  RemuxMediaResult
} from "@/lib/ffmpeg/types";
import type { ProbeMediaFileOptions } from "@/lib/ffmpeg/probe";
import {
  createDownloadOrchestrationService,
  type DownloadOrchestrationDependencies,
  type EnqueueDownloadJobRequest
} from "@/lib/jobs/download-orchestrator";
import { createMediaJobQueue, type MediaJobQueue } from "@/lib/jobs/queue";
import type { FinalArtifactPlan, JobArtifactLifecycle, RegisteredSourceArtifact } from "@/lib/storage/job-artifacts";
import type { StoredFile } from "@/lib/storage/types";
import { validateVideoUrl } from "@/lib/security/url-validation";
import { API_ERROR_CODES } from "@/lib/types";

const INPUT_METADATA: MediaProbeResult = {
  durationSeconds: 12,
  formatName: "matroska,webm",
  containerFormats: ["matroska", "webm"],
  sizeBytes: 6,
  bitRate: 1_000_000,
  hasVideo: true,
  hasAudio: true,
  videoStreams: [{ index: 0, codec: "vp9", width: 1280, height: 720, attachedPicture: false }],
  audioStreams: [{ index: 1, codec: "opus", channels: 2, sampleRate: 48_000 }],
  width: 1280,
  height: 720,
  videoCodec: "vp9",
  audioCodec: "opus",
  format: {
    formatName: "matroska,webm",
    containerFormats: ["matroska", "webm"],
    durationSeconds: 12,
    sizeBytes: 6,
    bitRate: 1_000_000
  }
};

const MP4_METADATA: MediaProbeResult = {
  ...INPUT_METADATA,
  formatName: "mov,mp4,m4a,3gp,3g2,mj2",
  containerFormats: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
  videoStreams: [{ index: 0, codec: "h264", width: 1280, height: 720, attachedPicture: false }],
  audioStreams: [{ index: 1, codec: "aac", channels: 2, sampleRate: 48_000 }],
  videoCodec: "h264",
  audioCodec: "aac",
  format: {
    ...INPUT_METADATA.format,
    formatName: "mov,mp4,m4a,3gp,3g2,mj2",
    containerFormats: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"]
  }
};

const AUDIO_METADATA: MediaProbeResult = {
  ...MP4_METADATA,
  hasVideo: false,
  videoStreams: [],
  width: undefined,
  height: undefined,
  videoCodec: undefined
};

type FakeArtifactState = {
  discardCalls: number;
  completeCalls: number;
  sourceRegistered: boolean;
  finalRegistered: boolean;
  publishedOriginal: boolean;
  registeredFile?: StoredFile;
};

type HarnessOverrides = Partial<DownloadOrchestrationDependencies> & {
  jobs?: MediaJobQueue;
  storedFilename?: string;
};

function request(processingPreset: EnqueueDownloadJobRequest["processingPreset"] = "original"): EnqueueDownloadJobRequest {
  return {
    url: "https://public.example/video.mp4",
    formatId: "direct-source",
    processingPreset,
    rightsConfirmed: true
  };
}

function processorResult<T extends "remux" | "convert" | "audio">(
  type: T,
  outputPath: string
): T extends "remux" ? RemuxMediaResult : T extends "convert" ? CompatibleMp4Result : AudioExtractionResult {
  const common = {
    input: INPUT_METADATA,
    output: type === "audio" ? AUDIO_METADATA : MP4_METADATA,
    outputPath,
    sizeBytes: 6
  };
  if (type === "remux") {
    return { ...common, preset: "remux-to-mp4", copiedVideoStreams: 1, copiedAudioStreams: 1 } as never;
  }
  if (type === "convert") {
    return {
      ...common,
      preset: "compatible-mp4",
      targetWidth: 1280,
      targetHeight: 720,
      videoEncoder: "libx264",
      audioEncoder: "aac",
      threads: 2
    } as never;
  }
  return {
    ...common,
    preset: "audio-only",
    audioEncoder: "aac",
    bitRate: 192_000,
    sourceAudioStreamIndex: 1,
    channels: 2,
    threads: 2
  } as never;
}

function createHarness(overrides: HarnessOverrides = {}) {
  let nextJobId = 1;
  const baseJobs = overrides.jobs ?? createMediaJobQueue({
    maxConcurrentJobs: 1,
    maxQueuedJobs: 10,
    terminalTtlMs: 60_000,
    now: () => Date.UTC(2026, 0, 1),
    createJobId: () => `job_${nextJobId++}`
  });
  const appliedProgress: number[] = [];
  const jobs: MediaJobQueue = {
    ...baseJobs,
    enqueue(options) {
      let lastProgress = 0;
      return baseJobs.enqueue({
        ...options,
        handler: (context, signal, updateProgress) => options.handler(context, signal, (value) => {
          updateProgress(value);
          if (!Number.isFinite(value)) return;
          const normalized = Math.min(100, Math.max(0, value));
          if (normalized < lastProgress) return;
          lastProgress = normalized;
          appliedProgress.push(normalized);
        })
      });
    }
  };
  const artifactStates: FakeArtifactState[] = [];
  const extract = vi.fn(async () => ({
    id: "metadata",
    originalUrl: "https://public.example/",
    title: "Public video",
    platform: "direct-media",
    formats: [{ id: "direct-source", label: "MP4 source", ext: "mp4" }]
  }));
  const download = vi.fn(async (_url: URL, _formatId: string, context) => {
    context.onDownloadProgress?.(3, 6);
    context.onDownloadProgress?.(6, 6);
    return {
      path: `${context.workDir}/source.mp4`,
      filename: "Public video.mp4",
      contentType: "video/mp4",
      sizeBytes: 6
    };
  });
  const extractor: Extractor = {
    id: "fake-direct",
    name: "Fake direct",
    supports: () => true,
    extract,
    download
  };
  const createArtifacts = vi.fn(async ({ jobId }: { jobId: string }) => {
    const state: FakeArtifactState = {
      discardCalls: 0,
      completeCalls: 0,
      sourceRegistered: false,
      finalRegistered: false,
      publishedOriginal: false
    };
    artifactStates.push(state);
    const source: RegisteredSourceArtifact = {
      registryId: `source_${jobId}`,
      path: `/safe/jobs/${jobId}/source.mp4`,
      filename: "Public video.mp4",
      contentType: "video/mp4",
      sizeBytes: 6,
      extension: "mp4"
    };
    let plan: FinalArtifactPlan | undefined;
    const lifecycle: JobArtifactLifecycle = {
      jobDirectory: `/safe/jobs/${jobId}`,
      async registerSource() {
        state.sourceRegistered = true;
        return source;
      },
      prepareFinal(preset) {
        const extension = preset === "audio-only" ? "m4a" : "mp4";
        plan = {
          path: `/safe/jobs/${jobId}/final.${extension}`,
          partialPath: `/safe/jobs/${jobId}/final.partial.${extension}`,
          extension,
          mimeType: extension === "m4a" ? "audio/mp4" : "video/mp4",
          downloadFilename: extension === "m4a" ? "Public video.m4a" : "Public video.mp4"
        };
        return plan;
      },
      async publishOriginal() {
        state.publishedOriginal = true;
      },
      async registerFinal(finalPlan) {
        state.finalRegistered = true;
        state.registeredFile = {
          id: `file_${jobId}`,
          jobId,
          path: finalPlan.path,
          relativePath: `jobs/${jobId}/${finalPlan.path.split("/").at(-1)}`,
          filename: overrides.storedFilename ?? finalPlan.downloadFilename,
          sizeBytes: 6,
          contentType: finalPlan.mimeType,
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T01:00:00.000Z",
          kind: "final"
        };
        return state.registeredFile;
      },
      async completeSuccess() {
        state.completeCalls += 1;
      },
      async discard() {
        state.discardCalls += 1;
      }
    };
    return lifecycle;
  });
  const probeMedia = vi.fn(async (candidate: string, _options?: ProbeMediaFileOptions) => candidate.endsWith("final.m4a") ? AUDIO_METADATA : candidate.includes("final") ? MP4_METADATA : INPUT_METADATA);
  const remuxMedia = vi.fn(async (options) => processorResult("remux", options.outputPath));
  const convertMedia = vi.fn(async (options) => processorResult("convert", options.outputPath));
  const extractAudio = vi.fn(async (options) => processorResult("audio", options.outputPath));
  const dependencies: DownloadOrchestrationDependencies = {
    validateUrl: validateVideoUrl,
    getExtractor: () => extractor,
    cleanupExpiredFiles: vi.fn(async () => undefined),
    createArtifacts,
    probeMedia,
    remuxMedia,
    convertMedia,
    extractAudio,
    maxFileSizeBytes: 500 * 1024 * 1024,
    maxDurationSeconds: 30 * 60,
    metadataTimeoutSeconds: 10,
    downloadTimeoutSeconds: 120,
    ...overrides,
    jobs
  };
  const service = createDownloadOrchestrationService(dependencies);
  return {
    service,
    queue: jobs,
    extractor,
    extract,
    download,
    createArtifacts,
    probeMedia,
    remuxMedia,
    convertMedia,
    extractAudio,
    artifactStates,
    appliedProgress
  };
}

async function settleJob(queue: MediaJobQueue, jobId: string, rounds = 30) {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
    const snapshot = await queue.getJob(jobId);
    if (snapshot.status !== "queued" && snapshot.status !== "running") return snapshot;
  }
  return queue.getJob(jobId);
}

function syncError(operation: () => unknown): AppError {
  try {
    operation();
    throw new Error("Expected AppError.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
}

describe("download orchestration service", () => {
  it.each([
    ["original", "original"],
    ["remux-to-mp4", "remux"],
    ["compatible-mp4", "convert"],
    ["audio-only", "audio"]
  ] as const)("completes the %s preset", async (preset, processor) => {
    const harness = createHarness();
    const enqueued = await harness.service.enqueueDownloadJob(request(preset));
    const snapshot = await settleJob(harness.queue, enqueued.jobId);

    expect(snapshot).toMatchObject({
      status: "ready",
      progress: 100,
      processingPreset: preset,
      result: {
        fileId: `file_${enqueued.jobId}`,
        processingPreset: preset,
        expiresAt: "2026-01-01T01:00:00.000Z"
      }
    });
    expect(harness.artifactStates[0]).toMatchObject({
      sourceRegistered: true,
      finalRegistered: true,
      completeCalls: 1,
      discardCalls: 0
    });
    expect(harness.remuxMedia).toHaveBeenCalledTimes(processor === "remux" ? 1 : 0);
    expect(harness.convertMedia).toHaveBeenCalledTimes(processor === "convert" ? 1 : 0);
    expect(harness.extractAudio).toHaveBeenCalledTimes(processor === "audio" ? 1 : 0);
    expect(harness.artifactStates[0].publishedOriginal).toBe(processor === "original");
    expect(await harness.queue.jobRepository.get(enqueued.jobId)).toMatchObject({
      sourceMetadata: {
        sourceId: `source_${enqueued.jobId}`,
        filename: "Public video.mp4",
        sizeBytes: 6,
        contentType: "video/mp4"
      },
      finalMetadata: { fileId: `file_${enqueued.jobId}` }
    });
  });

  it("does not call any FFmpeg processor for original", async () => {
    const harness = createHarness();
    const job = await harness.service.enqueueDownloadJob(request("original"));
    await settleJob(harness.queue, job.jobId);
    expect(harness.remuxMedia).not.toHaveBeenCalled();
    expect(harness.convertMedia).not.toHaveBeenCalled();
    expect(harness.extractAudio).not.toHaveBeenCalled();
    expect(harness.probeMedia).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported preset, missing rights and malformed formatId before enqueue", async () => {
    const harness = createHarness();
    expect(syncError(() => harness.service.enqueueDownloadJob({
      ...request(),
      processingPreset: "unknown" as never
    })).code).toBe(API_ERROR_CODES.INVALID_URL);
    expect(syncError(() => harness.service.enqueueDownloadJob({
      ...request(),
      rightsConfirmed: false
    })).code).toBe(API_ERROR_CODES.INVALID_URL);
    expect(syncError(() => harness.service.enqueueDownloadJob({
      ...request(),
      formatId: "../../private"
    })).code).toBe(API_ERROR_CODES.INVALID_URL);
    expect((await harness.queue.getStats()).totalJobs).toBe(0);
  });

  it("rejects the disabled TikTok placeholder before creating a job", async () => {
    const placeholder: Extractor = {
      id: "tiktok",
      name: "TikTok",
      supports: () => true,
      extract: vi.fn(async () => { throw new AppError(API_ERROR_CODES.UNSUPPORTED_URL); }),
      download: vi.fn(async () => { throw new AppError(API_ERROR_CODES.UNSUPPORTED_URL); })
    };
    const harness = createHarness({ getExtractor: () => placeholder });
    const error = syncError(() => harness.service.enqueueDownloadJob({
      url: "https://www.tiktok.com/@synthetic/video/7000000000000000001",
      formatId: "synthetic-format",
      processingPreset: "original",
      rightsConfirmed: true
    }));
    expect(error.code).toBe(API_ERROR_CODES.UNSUPPORTED_URL);
    expect((await harness.queue.getStats()).totalJobs).toBe(0);
    expect(placeholder.extract).not.toHaveBeenCalled();
    expect(placeholder.download).not.toHaveBeenCalled();
  });

  it("rejects the disabled Instagram placeholder before creating a job", async () => {
    const placeholder: Extractor = {
      id: "instagram",
      name: "Instagram",
      supports: () => true,
      extract: vi.fn(async () => { throw new AppError(API_ERROR_CODES.UNSUPPORTED_URL); }),
      download: vi.fn(async () => { throw new AppError(API_ERROR_CODES.UNSUPPORTED_URL); })
    };
    const harness = createHarness({ getExtractor: () => placeholder });
    const error = syncError(() => harness.service.enqueueDownloadJob({
      url: "https://www.instagram.com/reel/Synth_01/",
      formatId: "synthetic-format",
      processingPreset: "original",
      rightsConfirmed: true
    }));
    expect(error.code).toBe(API_ERROR_CODES.UNSUPPORTED_URL);
    expect((await harness.queue.getStats()).totalJobs).toBe(0);
    expect(placeholder.extract).not.toHaveBeenCalled();
    expect(placeholder.download).not.toHaveBeenCalled();
  });

  it("rejects the disabled Facebook placeholder before creating a job", async () => {
    const placeholder: Extractor = {
      id: "facebook",
      name: "Facebook",
      supports: () => true,
      extract: vi.fn(async () => { throw new AppError(API_ERROR_CODES.UNSUPPORTED_URL); }),
      download: vi.fn(async () => { throw new AppError(API_ERROR_CODES.UNSUPPORTED_URL); })
    };
    const harness = createHarness({ getExtractor: () => placeholder });
    const error = syncError(() => harness.service.enqueueDownloadJob({
      url: "https://www.facebook.com/watch/?v=700000000000001",
      formatId: "synthetic-format",
      processingPreset: "original",
      rightsConfirmed: true
    }));
    expect(error.code).toBe(API_ERROR_CODES.UNSUPPORTED_URL);
    expect((await harness.queue.getStats()).totalJobs).toBe(0);
    expect(placeholder.extract).not.toHaveBeenCalled();
    expect(placeholder.download).not.toHaveBeenCalled();
  });

  it("fails safely when formatId is absent from fresh server metadata", async () => {
    const harness = createHarness();
    harness.extract.mockResolvedValueOnce({
      id: "metadata",
      originalUrl: "https://public.example/",
      title: "Public video",
      platform: "direct-media",
      formats: [{ id: "changed-format", label: "Changed", ext: "mp4" }]
    });
    const job = await harness.service.enqueueDownloadJob(request());
    const snapshot = await settleJob(harness.queue, job.jobId);
    expect(snapshot).toMatchObject({ status: "failed", error: { code: API_ERROR_CODES.UNSUPPORTED_URL } });
    expect(harness.download).not.toHaveBeenCalled();
  });

  it("canonicalizes Shorts server-side and maps a stale YouTube format to SOURCE_EXPIRED", async () => {
    const extract = vi.fn(async () => ({
      id: "youtube-metadata",
      originalUrl: "https://www.youtube.com/",
      title: "Short",
      platform: "YouTube",
      formats: [{ id: "fresh-format", label: "720p MP4", ext: "mp4" }]
    }));
    const download = vi.fn();
    const extractor: Extractor = {
      id: "youtube",
      name: "YouTube",
      supports: () => true,
      extract,
      download
    };
    const harness = createHarness({ getExtractor: () => extractor });
    const job = await harness.service.enqueueDownloadJob({
      url: "https://youtube.com/shorts/AbCdEfGhI_1?si=tracking",
      formatId: "stale-format",
      processingPreset: "original",
      rightsConfirmed: true
    });
    const snapshot = await settleJob(harness.queue, job.jobId);
    expect(snapshot).toMatchObject({ status: "failed", error: { code: API_ERROR_CODES.SOURCE_EXPIRED } });
    expect(extract).toHaveBeenCalledWith(
      new URL("https://www.youtube.com/watch?v=AbCdEfGhI_1"),
      expect.objectContaining({ maxDurationSeconds: 1800 })
    );
    expect(download).not.toHaveBeenCalled();
  });

  it("maps a stale dependency-injected Reddit format to SOURCE_EXPIRED", async () => {
    const extract = vi.fn(async () => ({
      id: "reddit-metadata",
      originalUrl: "https://www.reddit.com/",
      title: "Synthetic Reddit video",
      platform: "Reddit",
      formats: [{ id: "rf_fresh", label: "720p MP4", ext: "mp4" }]
    }));
    const download = vi.fn();
    const extractor: Extractor = {
      id: "reddit",
      name: "Reddit",
      supports: () => true,
      extract,
      download
    };
    const harness = createHarness({ getExtractor: () => extractor });
    const job = await harness.service.enqueueDownloadJob({
      url: "https://www.reddit.com/r/videos/comments/abc123/synthetic_post/?utm_source=synthetic",
      formatId: "rf_stale",
      processingPreset: "original",
      rightsConfirmed: true
    });
    const snapshot = await settleJob(harness.queue, job.jobId);
    expect(snapshot).toMatchObject({ status: "failed", error: { code: API_ERROR_CODES.SOURCE_EXPIRED } });
    expect(extract).toHaveBeenCalledWith(
      new URL("https://www.reddit.com/comments/abc123/"),
      expect.objectContaining({ maxDurationSeconds: 1800 })
    );
    expect(download).not.toHaveBeenCalled();
  });

  it.each([
    ["extractor", API_ERROR_CODES.EXTRACTION_FAILED],
    ["download", API_ERROR_CODES.DOWNLOAD_FAILED],
    ["too-large", API_ERROR_CODES.FILE_TOO_LARGE],
    ["probe", API_ERROR_CODES.FFPROBE_FAILED],
    ["processor", API_ERROR_CODES.PROCESSING_FAILED]
  ] as const)("cleans artifacts after a %s failure", async (stage, code) => {
    const harness = createHarness();
    if (stage === "extractor") harness.extract.mockRejectedValueOnce(new AppError(code));
    if (stage === "download" || stage === "too-large") harness.download.mockRejectedValueOnce(new AppError(code));
    if (stage === "probe") harness.probeMedia.mockRejectedValueOnce(new AppError(code));
    if (stage === "processor") harness.convertMedia.mockRejectedValueOnce(new AppError(code));
    const job = await harness.service.enqueueDownloadJob(request(stage === "processor" ? "compatible-mp4" : "original"));
    const snapshot = await settleJob(harness.queue, job.jobId);

    expect(snapshot).toMatchObject({ status: "failed", error: { code } });
    if (harness.artifactStates[0]) expect(harness.artifactStates[0].discardCalls).toBeGreaterThan(0);
  });

  it("enforces media limits even when probe is dependency-injected", async () => {
    const harness = createHarness();
    harness.probeMedia.mockResolvedValueOnce({ ...INPUT_METADATA, durationSeconds: 1900, format: { ...INPUT_METADATA.format, durationSeconds: 1900 } });
    const job = await harness.service.enqueueDownloadJob(request());
    const snapshot = await settleJob(harness.queue, job.jobId);
    expect(snapshot).toMatchObject({ status: "failed", error: { code: API_ERROR_CODES.VIDEO_TOO_LONG } });
    expect(harness.artifactStates[0].discardCalls).toBeGreaterThan(0);
  });

  it("cancels a queued download without starting its extractor", async () => {
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const harness = createHarness();
    harness.extract.mockImplementationOnce(async () => {
      await firstGate;
      return {
        id: "metadata",
        originalUrl: "https://public.example/",
        title: "First",
        platform: "direct-media",
        formats: [{ id: "direct-source", label: "Source", ext: "mp4" }]
      };
    });
    const first = await harness.service.enqueueDownloadJob(request());
    const second = await harness.service.enqueueDownloadJob({ ...request(), url: "https://public.example/second.mp4" });
    await Promise.resolve();
    const cancelled = await harness.service.cancelDownloadJob(second.jobId);

    expect(cancelled.status).toBe("cancelled");
    expect(harness.extract).toHaveBeenCalledTimes(1);
    resolveFirst();
    await settleJob(harness.queue, first.jobId);
  });

  it.each(["download", "probe", "processing"] as const)("cancels safely during %s", async (stage) => {
    const harness = createHarness();
    const waitForAbort = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new AppError(API_ERROR_CODES.JOB_CANCELLED)), { once: true });
    });
    if (stage === "download") {
      harness.download.mockImplementationOnce((_url, _format, context) => waitForAbort(context.signal as AbortSignal));
    }
    if (stage === "probe") {
      harness.probeMedia.mockImplementationOnce((_path, options) => waitForAbort(options?.signal as AbortSignal));
    }
    if (stage === "processing") {
      harness.convertMedia.mockImplementationOnce((options) => waitForAbort(options.signal as AbortSignal));
    }
    const job = await harness.service.enqueueDownloadJob(request(stage === "processing" ? "compatible-mp4" : "original"));
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    const snapshot = await harness.service.cancelDownloadJob(job.jobId);

    expect(snapshot.status).toBe("cancelled");
    if (harness.artifactStates[0]) expect(harness.artifactStates[0].discardCalls).toBeGreaterThan(0);
  });

  it("uses onDiscard when completion result cannot be published to the snapshot", async () => {
    const harness = createHarness({ storedFilename: "/private/final.mp4" });
    const job = await harness.service.enqueueDownloadJob(request());
    const snapshot = await settleJob(harness.queue, job.jobId);

    expect(snapshot).toMatchObject({ status: "failed", error: { code: API_ERROR_CODES.INTERNAL_ERROR } });
    expect(harness.artifactStates[0]).toMatchObject({ finalRegistered: true, completeCalls: 1 });
    expect(harness.artifactStates[0].discardCalls).toBeGreaterThan(0);
  });

  it("rolls back when final registration fails", async () => {
    const harness = createHarness();
    const originalFactory = harness.createArtifacts.getMockImplementation();
    harness.createArtifacts.mockImplementationOnce(async (options) => {
      const lifecycle = await originalFactory?.(options);
      if (!lifecycle) throw new Error("missing lifecycle");
      return {
        ...lifecycle,
        registerFinal: async () => { throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED, "/private/registry"); }
      };
    });
    const job = await harness.service.enqueueDownloadJob(request());
    const snapshot = await settleJob(harness.queue, job.jobId);
    expect(snapshot).toMatchObject({ status: "failed", error: { code: API_ERROR_CODES.DOWNLOAD_FAILED } });
    expect(harness.artifactStates[0].discardCalls).toBeGreaterThan(0);
  });

  it("rolls back a registered final when cancellation races with completion", async () => {
    let registrationCompleted!: () => void;
    let releaseRegistration!: () => void;
    const registered = new Promise<void>((resolve) => { registrationCompleted = resolve; });
    const registrationGate = new Promise<void>((resolve) => { releaseRegistration = resolve; });
    const harness = createHarness();
    const originalFactory = harness.createArtifacts.getMockImplementation();
    harness.createArtifacts.mockImplementationOnce(async (options) => {
      const lifecycle = await originalFactory?.(options);
      if (!lifecycle) throw new Error("missing lifecycle");
      return {
        ...lifecycle,
        async registerFinal(finalPlan, sizeBytes) {
          const stored = await lifecycle.registerFinal(finalPlan, sizeBytes);
          registrationCompleted();
          await registrationGate;
          return stored;
        }
      };
    });

    const job = await harness.service.enqueueDownloadJob(request());
    await registered;
    const cancellation = harness.service.cancelDownloadJob(job.jobId);
    releaseRegistration();
    const snapshot = await cancellation;

    expect(snapshot.status).toBe("cancelled");
    expect(snapshot.result).toBeUndefined();
    expect(harness.artifactStates[0].finalRegistered).toBe(true);
    expect(harness.artifactStates[0].discardCalls).toBeGreaterThan(0);
  });

  it("returns only safe public result fields and monotonic progress", async () => {
    const harness = createHarness();
    const job = await harness.service.enqueueDownloadJob(request("compatible-mp4"));
    const snapshot = await settleJob(harness.queue, job.jobId);
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.result).toMatchObject({
      mimeType: "video/mp4",
      processingPreset: "compatible-mp4",
      media: { durationSeconds: 12, hasVideo: true, hasAudio: true }
    });
    expect(serialized).not.toContain("https://public.example/video.mp4");
    expect(serialized).not.toContain("/safe/jobs/");
    expect(serialized).not.toContain("stderr");
    expect(harness.appliedProgress.every((value, index, values) => index === 0 || value >= values[index - 1])).toBe(true);
    expect(snapshot.progress).toBe(100);
  });

  it("continues FIFO processing after one download job fails", async () => {
    const harness = createHarness();
    harness.extract.mockRejectedValueOnce(new AppError(API_ERROR_CODES.EXTRACTION_FAILED));
    const first = await harness.service.enqueueDownloadJob(request());
    const second = await harness.service.enqueueDownloadJob({ ...request(), url: "https://public.example/next.mp4" });
    const firstSnapshot = await settleJob(harness.queue, first.jobId);
    const secondSnapshot = await settleJob(harness.queue, second.jobId);

    expect(firstSnapshot.status).toBe("failed");
    expect(secondSnapshot.status).toBe("ready");
    expect(harness.extract).toHaveBeenCalledTimes(2);
  });

  it("does not create unhandled rejections from orchestration failures", async () => {
    const harness = createHarness();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      harness.download.mockRejectedValueOnce(new Error("private failure"));
      const job = await harness.service.enqueueDownloadJob(request());
      const snapshot = await settleJob(harness.queue, job.jobId);
      expect(snapshot.status).toBe("failed");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});
