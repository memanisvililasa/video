import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { createAudioExtractor } from "@/lib/ffmpeg/audio";
import { MediaProcessError } from "@/lib/ffmpeg/process-runner";
import type {
  AudioExtractionOptions,
  MediaAudioStream,
  MediaProbeResult,
  MediaProcessResult,
  MediaProcessRunner,
  MediaProcessRunOptions,
  MediaVideoStream
} from "@/lib/ffmpeg/types";
import { API_ERROR_CODES } from "@/lib/types";

type AudioDescription = {
  codec?: string;
  channels?: number;
  durationSeconds?: number;
  index?: number;
};

type VideoDescription = {
  codec?: string;
  width?: number;
  height?: number;
  attachedPicture?: boolean;
};

type MetadataOptions = {
  audios?: AudioDescription[];
  videos?: VideoDescription[];
  containerFormats?: string[];
  durationSeconds?: number;
};

type FakeAudioState = {
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
  const videos = options.videos ?? [{ codec: "h264", width: 1920, height: 1080 }];
  const audios = options.audios ?? [{ codec: "opus", channels: 2 }];
  const durationSeconds = options.durationSeconds ?? 12;
  const containerFormats = options.containerFormats ?? ["matroska", "webm"];
  const videoStreams: MediaVideoStream[] = videos.map((video, index) => ({
    index,
    codec: video.codec ?? "h264",
    width: video.width ?? 1920,
    height: video.height ?? 1080,
    attachedPicture: video.attachedPicture ?? false,
    durationSeconds
  }));
  const audioStreams: MediaAudioStream[] = audios.map((audio, index) => ({
    index: audio.index ?? videoStreams.length + index,
    codec: audio.codec ?? "opus",
    sampleRate: 48_000,
    channels: audio.channels,
    durationSeconds: audio.durationSeconds ?? durationSeconds
  }));
  const primaryVideo = videoStreams[0];
  const primaryAudio = audioStreams[0];
  const formatName = containerFormats.join(",") || "unknown";

  return {
    durationSeconds,
    formatName,
    containerFormats,
    sizeBytes: 5,
    bitRate: 1_000_000,
    hasVideo: videoStreams.length > 0,
    hasAudio: audioStreams.length > 0,
    videoStreams,
    audioStreams,
    width: primaryVideo?.width,
    height: primaryVideo?.height,
    videoCodec: primaryVideo?.codec,
    audioCodec: primaryAudio?.codec,
    format: {
      formatName,
      containerFormats,
      durationSeconds,
      sizeBytes: 5,
      bitRate: 1_000_000
    }
  };
}

function m4aOutput(options: MetadataOptions = {}): MediaProbeResult {
  return createMetadata({
    videos: [],
    audios: [{ codec: "aac", channels: 2 }],
    containerFormats: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
    ...options
  });
}

function createDefaultState(): FakeAudioState {
  return {
    inputMetadata: createMetadata(),
    outputMetadata: m4aOutput(),
    outputMode: "file",
    outputContents: "audio"
  };
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-audio-test-"));
  allowedRoot = path.join(temporaryRoot, "storage");
  jobDirectory = path.join(allowedRoot, "jobs", "job_test");
  await mkdir(jobDirectory, { recursive: true });
  inputPath = path.join(jobDirectory, "source.webm");
  outputPath = path.join(jobDirectory, "audio.m4a");
  await writeFile(inputPath, "media");

  outsideRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-audio-outside-"));
  outsideOutputPath = path.join(outsideRoot, "audio.m4a");
});

afterEach(async () => {
  await Promise.all([
    rm(temporaryRoot, { recursive: true, force: true }),
    rm(outsideRoot, { recursive: true, force: true })
  ]);
});

function createHarness(
  overrides: Partial<FakeAudioState> = {},
  options: { maxOutputBytes?: number; threads?: number; maxDurationSeconds?: number } = {}
) {
  const state: FakeAudioState = { ...createDefaultState(), ...overrides };
  const processCalls: MediaProcessRunOptions[] = [];
  const probeCalls: string[] = [];

  const runProcess: MediaProcessRunner = vi.fn(async (runOptions: MediaProcessRunOptions) => {
    processCalls.push(runOptions);
    const partialPath = runOptions.args.at(-1);
    if (!partialPath) throw new Error("Missing fake partial path.");

    if (state.outputMode === "file") await writeFile(partialPath, state.outputContents ?? "audio");
    if (state.outputMode === "empty") await writeFile(partialPath, "");
    if (state.processError) throw state.processError;

    return {
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 8
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

  const extract = createAudioExtractor({
    runProcess,
    probeMedia,
    getAllowedRoot: () => allowedRoot,
    timeoutMs: 900_000,
    maxOutputBytes: options.maxOutputBytes ?? 500 * 1024 * 1024,
    maxDurationSeconds: options.maxDurationSeconds ?? 30 * 60,
    threads: options.threads ?? 2
  });

  return { state, processCalls, probeCalls, runProcess, probeMedia, extract };
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
    throw new Error("Expected audio extraction to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
}

function argumentValue(call: MediaProcessRunOptions, option: string): string | undefined {
  const index = call.args.indexOf(option);
  return index >= 0 ? call.args[index + 1] : undefined;
}

describe("safe M4A audio extraction", () => {
  it("extracts audio from video and publishes only the validated M4A", async () => {
    const harness = createHarness();
    const result = await harness.extract({ inputPath, outputPath });

    expect(result).toMatchObject({
      preset: "audio-only",
      sizeBytes: 5,
      audioEncoder: "aac",
      bitRate: 192_000,
      sourceAudioStreamIndex: 1,
      channels: 2,
      threads: 2
    });
    expect(result.output.containerFormats).toEqual(expect.arrayContaining(["mp4", "m4a"]));
    expect(await readFile(outputPath, "utf8")).toBe("audio");
    expect(await readFile(inputPath, "utf8")).toBe("media");
    expect(await exists(path.join(jobDirectory, "audio.partial.m4a"))).toBe(false);
    expect(harness.probeCalls[1]).toBe(path.join(await realpath(jobDirectory), "audio.partial.m4a"));
  });

  it("extracts from an audio-only input", async () => {
    const harness = createHarness({
      inputMetadata: createMetadata({ videos: [], audios: [{ codec: "flac", channels: 2 }] })
    });
    await expect(harness.extract({ inputPath, outputPath })).resolves.toMatchObject({
      preset: "audio-only",
      audioEncoder: "aac"
    });
  });

  it("returns a typed safe error when input has no audio stream", async () => {
    const harness = createHarness({ inputMetadata: createMetadata({ audios: [] }) });
    const error = await getAppError(harness.extract({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.AUDIO_STREAM_NOT_FOUND);
    expect(error.message).not.toContain(inputPath);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("selects only the first audio stream", async () => {
    const harness = createHarness({
      inputMetadata: createMetadata({
        audios: [
          { codec: "opus", channels: 2, index: 4 },
          { codec: "aac", channels: 6, index: 7 }
        ]
      })
    });
    const result = await harness.extract({ inputPath, outputPath });
    expect(result.sourceAudioStreamIndex).toBe(4);
    expect(argumentValue(harness.processCalls[0], "-map")).toBe("0:a:0");
  });

  it("uses a fixed local-only AAC/M4A argument array", async () => {
    const harness = createHarness({}, { threads: 3 });
    await harness.extract({ inputPath, outputPath });

    const call = harness.processCalls[0];
    const canonicalJobDirectory = await realpath(jobDirectory);
    const canonicalInputPath = await realpath(inputPath);
    const partialPath = path.join(canonicalJobDirectory, "audio.partial.m4a");
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
      "-protocol_whitelist", "file",
      "-format_whitelist", "mov,matroska,webm",
      "-i", canonicalInputPath,
      "-map", "0:a:0",
      "-map_metadata", "-1",
      "-map_chapters", "-1",
      "-vn",
      "-sn",
      "-dn",
      "-c:a", "aac",
      "-b:a", "192k",
      "-threads:a", "3",
      "-movflags", "+faststart",
      "-f", "ipod",
      "-nostats",
      partialPath
    ]);
    expect(call.args.join(" ")).not.toContain("mp3");
    expect(call.args).not.toContain("-filter_complex");
    expect(call.args).not.toContain("-vf");
    expect(call.args).not.toContain("0:v");
  });

  it("ignores unrecognized option properties instead of accepting user media flags", async () => {
    const harness = createHarness();
    const untrustedOptions = {
      inputPath,
      outputPath,
      codec: "mp3",
      bitrate: "9999k",
      channels: 64,
      sampleRate: 1,
      filters: "volume=100",
      args: ["-y"]
    } as AudioExtractionOptions;

    await harness.extract(untrustedOptions);
    const call = harness.processCalls[0];
    expect(argumentValue(call, "-c:a")).toBe("aac");
    expect(argumentValue(call, "-b:a")).toBe("192k");
    expect(call.args).not.toContain("mp3");
    expect(call.args).not.toContain("9999k");
    expect(call.args).not.toContain("volume=100");
    expect(call.args).not.toContain("-y");
  });

  it("does not treat attached cover art as a real output video stream", async () => {
    const harness = createHarness({
      outputMetadata: m4aOutput({
        videos: [{ codec: "mjpeg", width: 600, height: 600, attachedPicture: true }]
      })
    });
    await expect(harness.extract({ inputPath, outputPath })).resolves.toMatchObject({
      preset: "audio-only"
    });
  });

  it("caps configured AAC threads at six", async () => {
    const harness = createHarness({}, { threads: 20 });
    const result = await harness.extract({ inputPath, outputPath });
    expect(result.threads).toBe(6);
    expect(argumentValue(harness.processCalls[0], "-threads:a")).toBe("6");
  });

  it.each([
    "https://example.com/video.mp4",
    "http://example.com/video.mp4",
    "file:///tmp/video.mp4",
    "source.webm"
  ])("rejects a URL or relative input before probing: %s", async (candidate) => {
    const harness = createHarness();
    const error = await getAppError(harness.extract({ inputPath: candidate, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
    expect(harness.probeCalls).toHaveLength(0);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("rejects a directory input", async () => {
    const directoryInput = path.join(jobDirectory, "directory.webm");
    await mkdir(directoryInput);
    const harness = createHarness();
    const error = await getAppError(harness.extract({ inputPath: directoryInput, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("blocks a symlink input escaping allowed storage", async () => {
    const outsideInput = path.join(outsideRoot, "outside.webm");
    await writeFile(outsideInput, "media");
    const linkedInput = path.join(jobDirectory, "linked.webm");
    await symlink(outsideInput, linkedInput);
    const harness = createHarness();

    const error = await getAppError(harness.extract({ inputPath: linkedInput, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("blocks output outside the input job directory", async () => {
    const harness = createHarness();
    const error = await getAppError(harness.extract({ inputPath, outputPath: outsideOutputPath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("rejects input and output resolving to the same file", async () => {
    const samePath = path.join(jobDirectory, "same.m4a");
    await writeFile(samePath, "media");
    const harness = createHarness();
    const error = await getAppError(harness.extract({ inputPath: samePath, outputPath: samePath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await readFile(samePath, "utf8")).toBe("media");
  });

  it("rejects a non-M4A output path", async () => {
    const harness = createHarness();
    const error = await getAppError(harness.extract({
      inputPath,
      outputPath: path.join(jobDirectory, "audio.mp4")
    }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("does not overwrite an existing final or partial output", async () => {
    await writeFile(outputPath, "existing");
    const harness = createHarness();
    let error = await getAppError(harness.extract({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await readFile(outputPath, "utf8")).toBe("existing");

    await rm(outputPath);
    const partialPath = path.join(jobDirectory, "audio.partial.m4a");
    await writeFile(partialPath, "existing-partial");
    error = await getAppError(harness.extract({ inputPath, outputPath }));
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
        stderr: "private FFmpeg details"
      })
    });
    const error = await getAppError(harness.extract({ inputPath, outputPath }));
    expect(error.code).toBe(code);
    expect(await exists(path.join(jobDirectory, "audio.partial.m4a"))).toBe(false);
    expect(await readFile(inputPath, "utf8")).toBe("media");
  });

  it("forwards AbortSignal and cleans partial output after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = createHarness({
      processError: new MediaProcessError({ reason: "aborted", tool: "ffmpeg" })
    });
    const error = await getAppError(harness.extract({ inputPath, outputPath, signal: controller.signal }));
    expect(error.code).toBe(API_ERROR_CODES.JOB_CANCELLED);
    expect(harness.processCalls[0].signal).toBe(controller.signal);
    expect(await exists(path.join(jobDirectory, "audio.partial.m4a"))).toBe(false);
  });

  it.each([
    { mode: "missing" as const, maxBytes: 100, code: API_ERROR_CODES.PROCESSING_FAILED },
    { mode: "empty" as const, maxBytes: 100, code: API_ERROR_CODES.PROCESSING_FAILED },
    { mode: "file" as const, maxBytes: 4, code: API_ERROR_CODES.OUTPUT_TOO_LARGE }
  ])("rejects a $mode or oversized output and removes partial data", async ({ mode, maxBytes, code }) => {
    const harness = createHarness({ outputMode: mode }, { maxOutputBytes: maxBytes });
    const error = await getAppError(harness.extract({ inputPath, outputPath }));
    expect(error.code).toBe(code);
    expect(await exists(path.join(jobDirectory, "audio.partial.m4a"))).toBe(false);
    expect(await exists(outputPath)).toBe(false);
  });

  it.each([
    {
      name: "no audio stream",
      metadata: m4aOutput({ audios: [] })
    },
    {
      name: "unsupported audio codec",
      metadata: m4aOutput({ audios: [{ codec: "opus", channels: 2 }] })
    },
    {
      name: "a real video stream",
      metadata: m4aOutput({ videos: [{ codec: "h264", width: 640, height: 360 }] })
    },
    {
      name: "a non-M4A container",
      metadata: m4aOutput({ containerFormats: ["matroska", "webm"] })
    },
    {
      name: "multiple audio streams",
      metadata: m4aOutput({
        audios: [{ codec: "aac", channels: 2 }, { codec: "aac", channels: 2 }]
      })
    }
  ])("rejects invalid audio output containing $name", async ({ metadata }) => {
    const harness = createHarness({ outputMetadata: metadata });
    const error = await getAppError(harness.extract({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await exists(outputPath)).toBe(false);
    expect(await exists(path.join(jobDirectory, "audio.partial.m4a"))).toBe(false);
  });

  it("uses the selected audio stream duration for output validation", async () => {
    const harness = createHarness({
      inputMetadata: createMetadata({
        durationSeconds: 20,
        audios: [{ codec: "opus", channels: 2, durationSeconds: 12 }]
      }),
      outputMetadata: m4aOutput({ durationSeconds: 12 })
    });
    await expect(harness.extract({ inputPath, outputPath })).resolves.toMatchObject({
      preset: "audio-only"
    });
  });

  it("rejects a corrupted post-extraction probe result", async () => {
    const harness = createHarness({
      outputProbeError: new AppError(API_ERROR_CODES.INVALID_MEDIA_FILE, `invalid ${inputPath}`)
    });
    const error = await getAppError(harness.extract({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(error.message).not.toContain(inputPath);
    expect(await exists(path.join(jobDirectory, "audio.partial.m4a"))).toBe(false);
  });

  it("enforces the configured input duration limit", async () => {
    const harness = createHarness({
      inputMetadata: createMetadata({ durationSeconds: 1801 })
    });
    const error = await getAppError(harness.extract({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.VIDEO_TOO_LONG);
    expect(harness.processCalls).toHaveLength(0);
  });

  it.each([
    createMetadata({ audios: [{ codec: "unknown", channels: 2 }] }),
    createMetadata({ audios: [{ codec: "aac", channels: 64 }] })
  ])("rejects an unsupported first input audio stream", async (inputMetadata) => {
    const harness = createHarness({ inputMetadata });
    const error = await getAppError(harness.extract({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.UNSUPPORTED_CODEC);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("cleans only owned output while preserving input and neighboring files", async () => {
    const neighborPath = path.join(jobDirectory, "neighbor.txt");
    await writeFile(neighborPath, "keep");
    const harness = createHarness({
      outputMetadata: m4aOutput({ durationSeconds: 40 })
    });
    const error = await getAppError(harness.extract({ inputPath, outputPath }));

    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await exists(path.join(jobDirectory, "audio.partial.m4a"))).toBe(false);
    expect(await exists(outputPath)).toBe(false);
    expect(await readFile(inputPath, "utf8")).toBe("media");
    expect(await readFile(neighborPath, "utf8")).toBe("keep");
  });

  it("does not expose stderr, paths, FFmpeg arguments or stack details", async () => {
    const secretStderr = `failed at ${inputPath} with -map 0:a:0`;
    const harness = createHarness({
      processError: new MediaProcessError({
        reason: "non-zero-exit",
        tool: "ffmpeg",
        exitCode: 1,
        stderr: secretStderr
      })
    });
    const error = await getAppError(harness.extract({ inputPath, outputPath }));

    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(error.message).not.toContain(inputPath);
    expect(error.message).not.toContain(outputPath);
    expect(error.message).not.toContain(secretStderr);
    expect(error.message).not.toContain("-map");
    expect(error.details).toBeUndefined();
  });
});
