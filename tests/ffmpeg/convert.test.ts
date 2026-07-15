import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { createCompatibleMp4Converter } from "@/lib/ffmpeg/convert";
import { MediaProcessError } from "@/lib/ffmpeg/process-runner";
import type {
  MediaAudioStream,
  MediaProbeResult,
  MediaProcessResult,
  MediaProcessRunner,
  MediaProcessRunOptions,
  MediaVideoStream
} from "@/lib/ffmpeg/types";
import { API_ERROR_CODES } from "@/lib/types";

type VideoDescription = {
  codec?: string;
  width?: number;
  height?: number;
  attachedPicture?: boolean;
  frameRate?: number;
  pixelFormat?: string;
  rotationDegrees?: number;
};

type MetadataOptions = {
  videos?: VideoDescription[];
  audios?: string[];
  containerFormats?: string[];
  durationSeconds?: number;
};

type FakeConversionState = {
  inputMetadata: MediaProbeResult;
  outputMetadata: MediaProbeResult;
  processError?: Error;
  inputProbeError?: Error;
  outputProbeError?: Error;
  outputMode?: "file" | "missing" | "empty";
  outputContents?: string;
};

let temporaryRoot: string;
let allowedRoot: string;
let jobDirectory: string;
let inputPath: string;
let outputPath: string;
let outsideRoot: string;
let outsideOutputPath: string;

function createMetadata(options: MetadataOptions = {}): MediaProbeResult {
  const videos = options.videos ?? [{ codec: "h264", width: 1920, height: 1080, frameRate: 30 }];
  const audios = options.audios ?? ["aac"];
  const durationSeconds = options.durationSeconds ?? 12;
  const containerFormats = options.containerFormats ?? ["matroska", "webm"];
  const videoStreams: MediaVideoStream[] = videos.map((video, index) => ({
    index,
    codec: video.codec ?? "h264",
    width: video.width ?? 1920,
    height: video.height ?? 1080,
    attachedPicture: video.attachedPicture ?? false,
    frameRate: video.frameRate
      ? { numerator: video.frameRate, denominator: 1, value: video.frameRate }
      : undefined,
    pixelFormat: video.pixelFormat,
    rotationDegrees: video.rotationDegrees,
    durationSeconds
  }));
  const audioStreams: MediaAudioStream[] = audios.map((codec, index) => ({
    index: videoStreams.length + index,
    codec,
    sampleRate: 48_000,
    channels: 2,
    durationSeconds
  }));
  const primaryVideo = videoStreams.find((stream) => stream.attachedPicture !== true);
  const primaryAudio = audioStreams[0];
  const formatName = containerFormats.join(",") || "unknown";

  return {
    durationSeconds,
    formatName,
    containerFormats,
    sizeBytes: 5,
    bitRate: 4_000_000,
    hasVideo: videoStreams.length > 0,
    hasAudio: audioStreams.length > 0,
    videoStreams,
    audioStreams,
    width: primaryVideo?.width,
    height: primaryVideo?.height,
    videoCodec: primaryVideo?.codec,
    audioCodec: primaryAudio?.codec,
    frameRate: primaryVideo?.frameRate,
    format: {
      formatName,
      containerFormats,
      durationSeconds,
      sizeBytes: 5,
      bitRate: 4_000_000
    }
  };
}

function compatibleOutput(
  width = 1920,
  height = 1080,
  options: Omit<MetadataOptions, "videos"> & { video?: VideoDescription } = {}
): MediaProbeResult {
  return createMetadata({
    ...options,
    containerFormats: options.containerFormats ?? ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
    videos: [{
      codec: "h264",
      width,
      height,
      frameRate: 30,
      pixelFormat: "yuv420p",
      ...options.video
    }]
  });
}

function createDefaultState(): FakeConversionState {
  return {
    inputMetadata: createMetadata(),
    outputMetadata: compatibleOutput(),
    outputMode: "file",
    outputContents: "encoded"
  };
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-convert-test-"));
  allowedRoot = path.join(temporaryRoot, "storage");
  jobDirectory = path.join(allowedRoot, "jobs", "job_test");
  await mkdir(jobDirectory, { recursive: true });
  inputPath = path.join(jobDirectory, "source.webm");
  outputPath = path.join(jobDirectory, "compatible.mp4");
  await writeFile(inputPath, "media");

  outsideRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-convert-outside-"));
  outsideOutputPath = path.join(outsideRoot, "compatible.mp4");
});

afterEach(async () => {
  await Promise.all([
    rm(temporaryRoot, { recursive: true, force: true }),
    rm(outsideRoot, { recursive: true, force: true })
  ]);
});

function createHarness(
  overrides: Partial<FakeConversionState> = {},
  options: { maxOutputBytes?: number; threads?: number; maxDurationSeconds?: number } = {}
) {
  const state: FakeConversionState = { ...createDefaultState(), ...overrides };
  const processCalls: MediaProcessRunOptions[] = [];
  const probeCalls: string[] = [];

  const runProcess: MediaProcessRunner = vi.fn(async (runOptions: MediaProcessRunOptions) => {
    processCalls.push(runOptions);
    const partialPath = runOptions.args.at(-1);
    if (!partialPath) throw new Error("Missing fake partial path.");

    if (state.outputMode === "file") await writeFile(partialPath, state.outputContents ?? "encoded");
    if (state.outputMode === "empty") await writeFile(partialPath, "");
    if (state.processError) throw state.processError;

    return {
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 10
    } satisfies MediaProcessResult;
  });

  const probeMedia = vi.fn(async (candidate: string) => {
    probeCalls.push(candidate);
    if (probeCalls.length === 1) {
      if (state.inputProbeError) throw state.inputProbeError;
      return state.inputMetadata;
    }
    if (state.outputProbeError) throw state.outputProbeError;
    return state.outputMetadata;
  });

  const convert = createCompatibleMp4Converter({
    runProcess,
    probeMedia,
    getAllowedRoot: () => allowedRoot,
    timeoutMs: 900_000,
    maxOutputBytes: options.maxOutputBytes ?? 500 * 1024 * 1024,
    maxDurationSeconds: options.maxDurationSeconds ?? 30 * 60,
    threads: options.threads ?? 2
  });

  return { state, processCalls, probeCalls, runProcess, probeMedia, convert };
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function getAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
    throw new Error("Expected conversion to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
}

function argumentValue(call: MediaProcessRunOptions, option: string): string | undefined {
  const index = call.args.indexOf(option);
  return index >= 0 ? call.args[index + 1] : undefined;
}

describe("safe compatible MP4 conversion", () => {
  it("converts video and audio and publishes only the validated output", async () => {
    const harness = createHarness();
    const result = await harness.convert({ inputPath, outputPath });

    expect(result).toMatchObject({
      preset: "compatible-mp4",
      sizeBytes: 7,
      targetWidth: 1920,
      targetHeight: 1080,
      videoEncoder: "libx264",
      audioEncoder: "aac",
      threads: 2
    });
    expect(result.output.containerFormats).toContain("mp4");
    expect(await readFile(outputPath, "utf8")).toBe("encoded");
    expect(await readFile(inputPath, "utf8")).toBe("media");
    expect(await exists(path.join(jobDirectory, "compatible.partial.mp4"))).toBe(false);
    expect(harness.probeCalls[1]).toBe(path.join(await realpath(jobDirectory), "compatible.partial.mp4"));
  });

  it("converts video without creating an audio stream", async () => {
    const harness = createHarness({
      inputMetadata: createMetadata({ audios: [] }),
      outputMetadata: compatibleOutput(1920, 1080, { audios: [] })
    });

    await expect(harness.convert({ inputPath, outputPath })).resolves.toMatchObject({
      audioEncoder: null
    });
  });

  it("uses a fixed local-only H.264/AAC argument array", async () => {
    const harness = createHarness({}, { threads: 3 });
    await harness.convert({ inputPath, outputPath });

    const call = harness.processCalls[0];
    const canonicalJobDirectory = await realpath(jobDirectory);
    const canonicalInputPath = await realpath(inputPath);
    const partialPath = path.join(canonicalJobDirectory, "compatible.partial.mp4");
    expect(call).toMatchObject({
      tool: "ffmpeg",
      cwd: canonicalJobDirectory,
      timeoutMs: 900_000,
      stdout: { maxBytes: 64 * 1024, overflow: "truncate-tail" },
      stderr: { maxBytes: 64 * 1024, overflow: "truncate-tail" }
    });
    expect(call).not.toHaveProperty("shell");
    expect(call.args).toEqual([
      "-nostdin",
      "-hide_banner",
      "-loglevel", "error",
      "-n",
      "-filter_threads", "3",
      "-protocol_whitelist", "file",
      "-format_whitelist", "mov,matroska,webm",
      "-i", canonicalInputPath,
      "-map", "0:V:0",
      "-map", "0:a:0?",
      "-map_metadata", "-1",
      "-map_chapters", "-1",
      "-c:v", "libx264",
      "-preset:v", "medium",
      "-crf:v", "23",
      "-pix_fmt:v", "yuv420p",
      "-vf", "scale=1920:1080:flags=lanczos,setsar=1",
      "-threads:v", "3",
      "-c:a", "aac",
      "-b:a", "160k",
      "-sn",
      "-dn",
      "-movflags", "+faststart",
      "-f", "mp4",
      "-nostats",
      partialPath
    ]);
    expect(call.args).not.toContain("-filter_complex");
    expect(call.args).not.toContain("0:s");
    expect(call.args).not.toContain("0:d");
    expect(call.args).not.toContain("0:t");
  });

  it("uses the cross-version default autorotation without an incompatible boolean form", async () => {
    const harness = createHarness();
    await harness.convert({ inputPath, outputPath });

    const args = harness.processCalls[0].args;
    const input = args.indexOf("-i");
    expect(args).not.toContain("-autorotate");
    expect(input).toBe(args.indexOf("-format_whitelist") + 2);
    expect(args[input + 1]).toBe(await realpath(inputPath));
  });

  it("downscales landscape 4K to at most 1920x1080", async () => {
    const harness = createHarness({
      inputMetadata: createMetadata({ videos: [{ width: 3840, height: 2160, frameRate: 30 }] }),
      outputMetadata: compatibleOutput(1920, 1080)
    });
    const result = await harness.convert({ inputPath, outputPath });
    expect(result).toMatchObject({ targetWidth: 1920, targetHeight: 1080 });
    expect(argumentValue(harness.processCalls[0], "-vf")).toContain("scale=1920:1080");
  });

  it("downscales portrait 4K to at most 1080x1920", async () => {
    const harness = createHarness({
      inputMetadata: createMetadata({ videos: [{ width: 2160, height: 3840, frameRate: 30 }] }),
      outputMetadata: compatibleOutput(1080, 1920)
    });
    const result = await harness.convert({ inputPath, outputPath });
    expect(result).toMatchObject({ targetWidth: 1080, targetHeight: 1920 });
    expect(argumentValue(harness.processCalls[0], "-vf")).toContain("scale=1080:1920");
  });

  it("does not upscale 720p video", async () => {
    const harness = createHarness({
      inputMetadata: createMetadata({ videos: [{ width: 1280, height: 720, frameRate: 30 }] }),
      outputMetadata: compatibleOutput(1280, 720)
    });
    await expect(harness.convert({ inputPath, outputPath })).resolves.toMatchObject({
      targetWidth: 1280,
      targetHeight: 720
    });
  });

  it("makes odd dimensions even while preserving aspect ratio within rounding tolerance", async () => {
    const harness = createHarness({
      inputMetadata: createMetadata({ videos: [{ width: 1279, height: 719, frameRate: 30 }] }),
      outputMetadata: compatibleOutput(1278, 718)
    });
    const result = await harness.convert({ inputPath, outputPath });

    expect(result.targetWidth % 2).toBe(0);
    expect(result.targetHeight % 2).toBe(0);
    expect(result.targetWidth / result.targetHeight).toBeCloseTo(1279 / 719, 2);
  });

  it("uses rotation metadata when selecting portrait output dimensions", async () => {
    const harness = createHarness({
      inputMetadata: createMetadata({
        videos: [{ width: 3840, height: 2160, frameRate: 30, rotationDegrees: 90 }]
      }),
      outputMetadata: compatibleOutput(1080, 1920)
    });
    const result = await harness.convert({ inputPath, outputPath });

    expect(result).toMatchObject({ targetWidth: 1080, targetHeight: 1920 });
    expect(harness.processCalls[0].args).not.toContain("-autorotate");
  });

  it("caps configured encoding and filter threads at six", async () => {
    const harness = createHarness({}, { threads: 32 });
    const result = await harness.convert({ inputPath, outputPath });
    expect(result.threads).toBe(6);
    expect(argumentValue(harness.processCalls[0], "-threads:v")).toBe("6");
    expect(argumentValue(harness.processCalls[0], "-filter_threads")).toBe("6");
  });

  it("ignores cover art and maps only the first primary video and optional first audio", async () => {
    const harness = createHarness({
      inputMetadata: createMetadata({
        videos: [
          { codec: "mjpeg", width: 600, height: 600, attachedPicture: true },
          { codec: "vp9", width: 1280, height: 720, frameRate: 30 },
          { codec: "h264", width: 640, height: 360, frameRate: 30 }
        ],
        audios: ["opus", "aac"]
      }),
      outputMetadata: compatibleOutput(1280, 720)
    });

    await harness.convert({ inputPath, outputPath });
    const mappings = harness.processCalls[0].args.filter((_, index, args) => args[index - 1] === "-map");
    expect(mappings).toEqual(["0:V:0", "0:a:0?"]);
    expect(harness.processCalls[0].args).toEqual(expect.arrayContaining(["-sn", "-dn"]));
  });

  it("rejects audio-only or cover-art-only input", async () => {
    const harness = createHarness({
      inputMetadata: createMetadata({
        videos: [{ codec: "mjpeg", width: 600, height: 600, attachedPicture: true }]
      })
    });
    const error = await getAppError(harness.convert({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
    expect(harness.processCalls).toHaveLength(0);
  });

  it.each([
    "https://example.com/video.mp4",
    "http://example.com/video.mp4",
    "file:///tmp/video.mp4",
    "source.webm"
  ])("rejects a URL or relative input before probing: %s", async (candidate) => {
    const harness = createHarness();
    const error = await getAppError(harness.convert({ inputPath: candidate, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
    expect(harness.probeCalls).toHaveLength(0);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("rejects a directory input", async () => {
    const directoryInput = path.join(jobDirectory, "directory.webm");
    await mkdir(directoryInput);
    const harness = createHarness();
    const error = await getAppError(harness.convert({ inputPath: directoryInput, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("blocks a symlink escaping allowed storage", async () => {
    const outsideInput = path.join(outsideRoot, "outside.webm");
    await writeFile(outsideInput, "media");
    const linkedInput = path.join(jobDirectory, "linked.webm");
    await symlink(outsideInput, linkedInput);
    const harness = createHarness();

    const error = await getAppError(harness.convert({ inputPath: linkedInput, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("blocks an output outside the input job directory", async () => {
    const harness = createHarness();
    const error = await getAppError(harness.convert({ inputPath, outputPath: outsideOutputPath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("rejects an output whose job directory does not exist", async () => {
    const missingOutput = path.join(allowedRoot, "jobs", "missing", "compatible.mp4");
    const harness = createHarness();
    const error = await getAppError(harness.convert({ inputPath, outputPath: missingOutput }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(harness.processCalls).toHaveLength(0);
    expect(await exists(missingOutput)).toBe(false);
  });

  it("rejects input and output resolving to the same file", async () => {
    const samePath = path.join(jobDirectory, "same.mp4");
    await writeFile(samePath, "media");
    const harness = createHarness();
    const error = await getAppError(harness.convert({ inputPath: samePath, outputPath: samePath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await readFile(samePath, "utf8")).toBe("media");
  });

  it("does not overwrite an existing final or partial output", async () => {
    await writeFile(outputPath, "existing");
    const harness = createHarness();
    let error = await getAppError(harness.convert({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await readFile(outputPath, "utf8")).toBe("existing");

    await rm(outputPath);
    const partialPath = path.join(jobDirectory, "compatible.partial.mp4");
    await writeFile(partialPath, "existing-partial");
    error = await getAppError(harness.convert({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await readFile(partialPath, "utf8")).toBe("existing-partial");
  });

  it.each([
    { reason: "non-zero-exit" as const, code: API_ERROR_CODES.PROCESSING_FAILED },
    { reason: "timeout" as const, code: API_ERROR_CODES.PROCESSING_TIMEOUT },
    { reason: "spawn" as const, code: API_ERROR_CODES.FFMPEG_NOT_AVAILABLE }
  ])("cleans partial output after $reason", async ({ reason, code }) => {
    const harness = createHarness({
      processError: new MediaProcessError({
        reason,
        tool: "ffmpeg",
        exitCode: reason === "non-zero-exit" ? 1 : undefined,
        stderr: "private process failure"
      })
    });
    const error = await getAppError(harness.convert({ inputPath, outputPath }));
    expect(error.code).toBe(code);
    expect(await exists(path.join(jobDirectory, "compatible.partial.mp4"))).toBe(false);
    expect(await readFile(inputPath, "utf8")).toBe("media");
  });

  it("forwards AbortSignal and cleans partial output after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = createHarness({
      processError: new MediaProcessError({ reason: "aborted", tool: "ffmpeg" })
    });
    const error = await getAppError(harness.convert({ inputPath, outputPath, signal: controller.signal }));
    expect(error.code).toBe(API_ERROR_CODES.JOB_CANCELLED);
    expect(harness.processCalls[0].signal).toBe(controller.signal);
    expect(await exists(path.join(jobDirectory, "compatible.partial.mp4"))).toBe(false);
  });

  it.each([
    { mode: "missing" as const, maxBytes: 100, code: API_ERROR_CODES.PROCESSING_FAILED },
    { mode: "empty" as const, maxBytes: 100, code: API_ERROR_CODES.PROCESSING_FAILED },
    { mode: "file" as const, maxBytes: 4, code: API_ERROR_CODES.OUTPUT_TOO_LARGE }
  ])("rejects a $mode or oversized output and removes partial data", async ({ mode, maxBytes, code }) => {
    const harness = createHarness({ outputMode: mode }, { maxOutputBytes: maxBytes });
    const error = await getAppError(harness.convert({ inputPath, outputPath }));
    expect(error.code).toBe(code);
    expect(await exists(path.join(jobDirectory, "compatible.partial.mp4"))).toBe(false);
    expect(await exists(outputPath)).toBe(false);
  });

  it.each([
    {
      name: "non-MP4 container",
      metadata: compatibleOutput(1920, 1080, { containerFormats: ["matroska", "webm"] })
    },
    {
      name: "non-H.264 video",
      metadata: compatibleOutput(1920, 1080, { video: { codec: "hevc" } })
    },
    {
      name: "non-AAC audio",
      metadata: compatibleOutput(1920, 1080, { audios: ["opus"] })
    },
    {
      name: "non-yuv420p pixels",
      metadata: compatibleOutput(1920, 1080, { video: { pixelFormat: "yuv444p" } })
    },
    {
      name: "resolution above compatible limit",
      metadata: compatibleOutput(2000, 1124)
    }
  ])("rejects invalid compatible output: $name", async ({ metadata }) => {
    const harness = createHarness({ outputMetadata: metadata });
    const error = await getAppError(harness.convert({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await exists(outputPath)).toBe(false);
    expect(await exists(path.join(jobDirectory, "compatible.partial.mp4"))).toBe(false);
  });

  it("detects accidental upscale", async () => {
    const harness = createHarness({
      inputMetadata: createMetadata({ videos: [{ width: 1280, height: 720, frameRate: 30 }] }),
      outputMetadata: compatibleOutput(1920, 1080)
    });
    const error = await getAppError(harness.convert({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await exists(outputPath)).toBe(false);
  });

  it("rejects a corrupted post-conversion probe response and removes partial output", async () => {
    const harness = createHarness({
      outputProbeError: new AppError(API_ERROR_CODES.INVALID_MEDIA_FILE, `invalid ${inputPath}`)
    });
    const error = await getAppError(harness.convert({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(error.message).not.toContain(inputPath);
    expect(await exists(path.join(jobDirectory, "compatible.partial.mp4"))).toBe(false);
    expect(await exists(outputPath)).toBe(false);
  });

  it.each([
    {
      code: API_ERROR_CODES.VIDEO_TOO_LONG,
      metadata: createMetadata({ durationSeconds: 1801 })
    },
    {
      code: API_ERROR_CODES.VIDEO_RESOLUTION_TOO_HIGH,
      metadata: createMetadata({ videos: [{ width: 4000, height: 2160 }] })
    }
  ])("enforces input media limits: $code", async ({ code, metadata }) => {
    const harness = createHarness({ inputMetadata: metadata });
    const error = await getAppError(harness.convert({ inputPath, outputPath }));
    expect(error.code).toBe(code);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("rejects unknown primary codecs before starting FFmpeg", async () => {
    const harness = createHarness({
      inputMetadata: createMetadata({ videos: [{ codec: "unknown" }] })
    });
    const error = await getAppError(harness.convert({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.UNSUPPORTED_CODEC);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("removes invalid partial output while preserving input and neighboring files", async () => {
    const neighborPath = path.join(jobDirectory, "neighbor.txt");
    await writeFile(neighborPath, "keep");
    const harness = createHarness({
      outputMetadata: compatibleOutput(1920, 1080, { durationSeconds: 40 })
    });
    const error = await getAppError(harness.convert({ inputPath, outputPath }));

    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await exists(path.join(jobDirectory, "compatible.partial.mp4"))).toBe(false);
    expect(await exists(outputPath)).toBe(false);
    expect(await readFile(inputPath, "utf8")).toBe("media");
    expect(await readFile(neighborPath, "utf8")).toBe("keep");
  });

  it("does not expose stderr, paths, command arguments or stack details", async () => {
    const secretStderr = `failed at ${inputPath} with -vf private-filter`;
    const harness = createHarness({
      processError: new MediaProcessError({
        reason: "non-zero-exit",
        tool: "ffmpeg",
        exitCode: 1,
        stderr: secretStderr
      })
    });
    const error = await getAppError(harness.convert({ inputPath, outputPath }));

    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(error.message).not.toContain(inputPath);
    expect(error.message).not.toContain(outputPath);
    expect(error.message).not.toContain(secretStderr);
    expect(error.message).not.toContain("-vf");
    expect(error.details).toBeUndefined();
  });
});
