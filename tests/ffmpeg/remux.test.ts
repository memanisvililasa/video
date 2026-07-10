import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { MediaProcessError } from "@/lib/ffmpeg/process-runner";
import { createMediaRemux } from "@/lib/ffmpeg/remux";
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
  codec: string;
  width?: number;
  height?: number;
  attachedPicture?: boolean;
  frameRate?: number;
};

type MetadataOptions = {
  videos?: VideoDescription[];
  audios?: string[];
  containerFormats?: string[];
  durationSeconds?: number;
};

type FakeRemuxState = {
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
    codec: video.codec,
    width: video.width ?? 1920,
    height: video.height ?? 1080,
    attachedPicture: video.attachedPicture ?? false,
    frameRate: video.frameRate
      ? { numerator: video.frameRate, denominator: 1, value: video.frameRate }
      : undefined,
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

function createDefaultState(): FakeRemuxState {
  return {
    inputMetadata: createMetadata(),
    outputMetadata: createMetadata({ containerFormats: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"] }),
    outputMode: "file",
    outputContents: "remuxed"
  };
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-remux-test-"));
  allowedRoot = path.join(temporaryRoot, "storage");
  jobDirectory = path.join(allowedRoot, "jobs", "job_test");
  await mkdir(jobDirectory, { recursive: true });
  inputPath = path.join(jobDirectory, "source.webm");
  outputPath = path.join(jobDirectory, "output.mp4");
  await writeFile(inputPath, "media");

  outsideRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-remux-outside-"));
  outsideOutputPath = path.join(outsideRoot, "output.mp4");
});

afterEach(async () => {
  await Promise.all([
    rm(temporaryRoot, { recursive: true, force: true }),
    rm(outsideRoot, { recursive: true, force: true })
  ]);
});

function createHarness(overrides: Partial<FakeRemuxState> = {}, maxOutputBytes = 500 * 1024 * 1024) {
  const state: FakeRemuxState = { ...createDefaultState(), ...overrides };
  const processCalls: MediaProcessRunOptions[] = [];
  const probeCalls: string[] = [];

  const runProcess: MediaProcessRunner = vi.fn(async (options: MediaProcessRunOptions) => {
    processCalls.push(options);
    const partialPath = options.args.at(-1);
    if (!partialPath) throw new Error("Missing fake partial path.");

    if (state.outputMode === "file") await writeFile(partialPath, state.outputContents ?? "remuxed");
    if (state.outputMode === "empty") await writeFile(partialPath, "");
    if (state.processError) throw state.processError;

    return {
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 5
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

  const remux = createMediaRemux({
    runProcess,
    probeMedia,
    getAllowedRoot: () => allowedRoot,
    timeoutMs: 900_000,
    maxOutputBytes
  });

  return { state, processCalls, probeCalls, runProcess, probeMedia, remux };
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
    throw new Error("Expected remux to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
}

describe("safe MP4 remux", () => {
  it("remuxes video and audio through fixed stream-copy arguments", async () => {
    const harness = createHarness();
    const result = await harness.remux({ inputPath, outputPath });

    expect(result).toMatchObject({
      preset: "remux-to-mp4",
      sizeBytes: 7,
      copiedVideoStreams: 1,
      copiedAudioStreams: 1
    });
    expect(result.output.containerFormats).toContain("mp4");
    expect(await readFile(outputPath, "utf8")).toBe("remuxed");
    expect(await readFile(inputPath, "utf8")).toBe("media");
    expect(await exists(path.join(jobDirectory, "output.partial.mp4"))).toBe(false);
    expect(harness.probeCalls).toHaveLength(2);
  });

  it("remuxes video without audio", async () => {
    const inputMetadata = createMetadata({ audios: [] });
    const outputMetadata = createMetadata({
      audios: [],
      containerFormats: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"]
    });
    const harness = createHarness({ inputMetadata, outputMetadata });

    await expect(harness.remux({ inputPath, outputPath })).resolves.toMatchObject({
      copiedVideoStreams: 1,
      copiedAudioStreams: 0
    });
  });

  it("copies multiple video and audio streams predictably", async () => {
    const videos = [
      { codec: "h264", width: 1920, height: 1080, frameRate: 30 },
      { codec: "hevc", width: 1280, height: 720, frameRate: 24 }
    ];
    const inputMetadata = createMetadata({ videos, audios: ["aac", "opus"] });
    const outputMetadata = createMetadata({
      videos,
      audios: ["aac", "opus"],
      containerFormats: ["mov", "mp4"]
    });
    const harness = createHarness({ inputMetadata, outputMetadata });

    await expect(harness.remux({ inputPath, outputPath })).resolves.toMatchObject({
      copiedVideoStreams: 2,
      copiedAudioStreams: 2
    });
  });

  it("uses a fixed local-only FFmpeg argument array without filters or encoding", async () => {
    const harness = createHarness();
    await harness.remux({ inputPath, outputPath });
    const call = harness.processCalls[0];
    const canonicalJobDirectory = await realpath(jobDirectory);
    const canonicalInputPath = await realpath(inputPath);
    const partialPath = path.join(canonicalJobDirectory, "output.partial.mp4");

    expect(call.tool).toBe("ffmpeg");
    expect(call.cwd).toBe(canonicalJobDirectory);
    expect(call.timeoutMs).toBe(900_000);
    expect(call.args).toEqual([
      "-nostdin",
      "-hide_banner",
      "-loglevel", "error",
      "-n",
      "-protocol_whitelist", "file",
      "-format_whitelist", "mov,matroska,webm",
      "-i", canonicalInputPath,
      "-map", "0:V?",
      "-map", "0:a?",
      "-map_metadata", "-1",
      "-map_chapters", "-1",
      "-c:v", "copy",
      "-c:a", "copy",
      "-sn",
      "-dn",
      "-movflags", "+faststart",
      "-f", "mp4",
      "-nostats",
      partialPath
    ]);
    expect(call.args).not.toContain("-filter_complex");
    expect(call.args).not.toContain("-vf");
    expect(call.args).not.toContain("-threads");
    expect(call).not.toHaveProperty("shell");
    expect(call.stdout).toEqual({ maxBytes: 64 * 1024, overflow: "truncate-tail" });
    expect(call.stderr).toEqual({ maxBytes: 64 * 1024, overflow: "truncate-tail" });
  });

  it("remuxes an MP4 source into a distinct no-overwrite output", async () => {
    const inputMetadata = createMetadata({ containerFormats: ["mov", "mp4"] });
    const outputMetadata = createMetadata({ containerFormats: ["mov", "mp4"] });
    const harness = createHarness({ inputMetadata, outputMetadata });

    await expect(harness.remux({ inputPath, outputPath })).resolves.toMatchObject({
      preset: "remux-to-mp4"
    });
  });

  it("excludes attached pictures from copied video streams", async () => {
    const videos = [
      { codec: "mjpeg", width: 600, height: 600, attachedPicture: true },
      { codec: "h264", width: 1920, height: 1080, frameRate: 30 }
    ];
    const inputMetadata = createMetadata({ videos });
    const outputMetadata = createMetadata({
      videos: [videos[1]],
      containerFormats: ["mov", "mp4"]
    });
    const harness = createHarness({ inputMetadata, outputMetadata });

    await expect(harness.remux({ inputPath, outputPath })).resolves.toMatchObject({
      copiedVideoStreams: 1
    });
  });

  it.each([
    "https://example.com/video.mp4",
    "http://example.com/video.mp4",
    "file:///tmp/video.mp4"
  ])("rejects a URL input before probing or processing: %s", async (url) => {
    const harness = createHarness();
    const error = await getAppError(harness.remux({ inputPath: url, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
    expect(harness.probeCalls).toHaveLength(0);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("rejects a relative input path", async () => {
    const harness = createHarness();
    const error = await getAppError(harness.remux({ inputPath: "source.webm", outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("rejects a directory input", async () => {
    const directoryInput = path.join(jobDirectory, "directory.webm");
    await mkdir(directoryInput);
    const harness = createHarness();
    const error = await getAppError(harness.remux({ inputPath: directoryInput, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("blocks a symlink input escaping the allowed storage", async () => {
    const outsideInput = path.join(outsideRoot, "outside.webm");
    await writeFile(outsideInput, "media");
    const linkedInput = path.join(jobDirectory, "linked.webm");
    await symlink(outsideInput, linkedInput);
    const harness = createHarness();

    const error = await getAppError(harness.remux({ inputPath: linkedInput, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("blocks an output outside the input job directory", async () => {
    const harness = createHarness();
    const error = await getAppError(harness.remux({ inputPath, outputPath: outsideOutputPath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(harness.processCalls).toHaveLength(0);
  });

  it.each([
    { name: "URL", value: "https://example.com/output.mp4" },
    { name: "relative path", value: "output.mp4" },
    { name: "non-MP4 extension", value: () => path.join(jobDirectory, "output.mov") },
    { name: "path traversal", value: () => `${jobDirectory}/nested/../output.mp4` }
  ])("rejects an invalid output path: $name", async ({ value }) => {
    const candidate = typeof value === "function" ? value() : value;
    const harness = createHarness();
    const error = await getAppError(harness.remux({ inputPath, outputPath: candidate }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("rejects input and output resolving to the same file", async () => {
    const samePath = path.join(jobDirectory, "same.mp4");
    await writeFile(samePath, "media");
    const harness = createHarness();

    const error = await getAppError(harness.remux({ inputPath: samePath, outputPath: samePath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await readFile(samePath, "utf8")).toBe("media");
    expect(harness.processCalls).toHaveLength(0);
  });

  it("rejects an input colliding with the derived partial path without deleting it", async () => {
    const partialInput = path.join(jobDirectory, "output.partial.mp4");
    await writeFile(partialInput, "media");
    const harness = createHarness();

    const error = await getAppError(harness.remux({ inputPath: partialInput, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await readFile(partialInput, "utf8")).toBe("media");
    expect(harness.processCalls).toHaveLength(0);
  });

  it("does not overwrite an existing output", async () => {
    await writeFile(outputPath, "existing");
    const harness = createHarness();
    const error = await getAppError(harness.remux({ inputPath, outputPath }));

    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await readFile(outputPath, "utf8")).toBe("existing");
    expect(harness.processCalls).toHaveLength(0);
  });

  it("does not overwrite an existing partial output", async () => {
    const partialPath = path.join(jobDirectory, "output.partial.mp4");
    await writeFile(partialPath, "existing-partial");
    const harness = createHarness();
    const error = await getAppError(harness.remux({ inputPath, outputPath }));

    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await readFile(partialPath, "utf8")).toBe("existing-partial");
    expect(harness.processCalls).toHaveLength(0);
  });

  it("cleans partial output after a non-zero FFmpeg exit and preserves input", async () => {
    const harness = createHarness({
      processError: new MediaProcessError({
        reason: "non-zero-exit",
        tool: "ffmpeg",
        exitCode: 1,
        stderr: "muxer failed"
      })
    });

    const error = await getAppError(harness.remux({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await exists(path.join(jobDirectory, "output.partial.mp4"))).toBe(false);
    expect(await readFile(inputPath, "utf8")).toBe("media");
  });

  it("maps an unavailable FFmpeg binary without exposing process details", async () => {
    const harness = createHarness({
      processError: new MediaProcessError({
        reason: "spawn",
        tool: "ffmpeg",
        spawnCode: "ENOENT"
      })
    });

    const error = await getAppError(harness.remux({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.FFMPEG_NOT_AVAILABLE);
    expect(await exists(path.join(jobDirectory, "output.partial.mp4"))).toBe(false);
  });

  it("cleans partial output and maps timeout", async () => {
    const harness = createHarness({
      processError: new MediaProcessError({ reason: "timeout", tool: "ffmpeg", signal: "SIGKILL" })
    });

    const error = await getAppError(harness.remux({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_TIMEOUT);
    expect(await exists(path.join(jobDirectory, "output.partial.mp4"))).toBe(false);
    expect(await readFile(inputPath, "utf8")).toBe("media");
  });

  it("forwards AbortSignal and cleans partial output after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = createHarness({
      processError: new MediaProcessError({ reason: "aborted", tool: "ffmpeg" })
    });

    const error = await getAppError(harness.remux({ inputPath, outputPath, signal: controller.signal }));
    expect(error.code).toBe(API_ERROR_CODES.JOB_CANCELLED);
    expect(harness.processCalls[0].signal).toBe(controller.signal);
    expect(await exists(path.join(jobDirectory, "output.partial.mp4"))).toBe(false);
  });

  it.each([
    { videos: [{ codec: "vp8" }], audios: ["aac"] },
    { videos: [{ codec: "h264" }], audios: ["vorbis"] }
  ])("rejects codecs incompatible with MP4 stream copy", async ({ videos, audios }) => {
    const harness = createHarness({ inputMetadata: createMetadata({ videos, audios }) });
    const error = await getAppError(harness.remux({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.UNSUPPORTED_CODEC);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("rejects an audio-only input", async () => {
    const harness = createHarness({ inputMetadata: createMetadata({ videos: [], audios: ["aac"] }) });
    const error = await getAppError(harness.remux({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
    expect(harness.processCalls).toHaveLength(0);
  });

  it.each([
    API_ERROR_CODES.INVALID_MEDIA_FILE,
    API_ERROR_CODES.VIDEO_TOO_LONG,
    API_ERROR_CODES.VIDEO_RESOLUTION_TOO_HIGH
  ])("preserves an input probe failure: %s", async (code) => {
    const harness = createHarness({ inputProbeError: new AppError(code) });
    const error = await getAppError(harness.remux({ inputPath, outputPath }));
    expect(error.code).toBe(code);
    expect(harness.processCalls).toHaveLength(0);
  });

  it("rejects a successful exit without an output file", async () => {
    const harness = createHarness({ outputMode: "missing" });
    const error = await getAppError(harness.remux({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await readFile(inputPath, "utf8")).toBe("media");
  });

  it("rejects and removes a zero-byte output", async () => {
    const harness = createHarness({ outputMode: "empty" });
    const error = await getAppError(harness.remux({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await exists(path.join(jobDirectory, "output.partial.mp4"))).toBe(false);
  });

  it("rejects and removes an output exceeding the size limit", async () => {
    const harness = createHarness({}, 4);
    const error = await getAppError(harness.remux({ inputPath, outputPath }));
    expect(error.code).toBe(API_ERROR_CODES.OUTPUT_TOO_LARGE);
    expect(await exists(path.join(jobDirectory, "output.partial.mp4"))).toBe(false);
    expect(await exists(outputPath)).toBe(false);
  });

  it("rejects and removes a remuxed file that is not MP4", async () => {
    const harness = createHarness({
      outputMetadata: createMetadata({ containerFormats: ["matroska", "webm"] })
    });
    const error = await getAppError(harness.remux({ inputPath, outputPath }));

    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await exists(outputPath)).toBe(false);
    expect(await exists(path.join(jobDirectory, "output.partial.mp4"))).toBe(false);
    expect(await readFile(inputPath, "utf8")).toBe("media");
  });

  it("rejects output with mismatched duration or copied stream properties", async () => {
    const harness = createHarness({
      outputMetadata: createMetadata({
        videos: [{ codec: "h264", width: 1280, height: 720, frameRate: 24 }],
        containerFormats: ["mov", "mp4"],
        durationSeconds: 20
      })
    });
    const error = await getAppError(harness.remux({ inputPath, outputPath }));

    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await exists(outputPath)).toBe(false);
  });

  it("rejects and removes output when post-probe duration does not match", async () => {
    const harness = createHarness({
      outputMetadata: createMetadata({
        containerFormats: ["mov", "mp4"],
        durationSeconds: 20
      })
    });
    const error = await getAppError(harness.remux({ inputPath, outputPath }));

    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_FAILED);
    expect(await exists(outputPath)).toBe(false);
    expect(await readFile(inputPath, "utf8")).toBe("media");
  });

  it("does not expose stderr, paths or command arguments in public errors", async () => {
    const secretStderr = `failed at ${inputPath} with -map 0:V?`;
    const harness = createHarness({
      processError: new MediaProcessError({
        reason: "non-zero-exit",
        tool: "ffmpeg",
        exitCode: 1,
        stderr: secretStderr
      })
    });

    const error = await getAppError(harness.remux({ inputPath, outputPath }));
    expect(error.message).not.toContain(inputPath);
    expect(error.message).not.toContain(outputPath);
    expect(error.message).not.toContain(secretStderr);
    expect(error.message).not.toContain("-map");
    expect(error.details).toBeUndefined();
  });
});
