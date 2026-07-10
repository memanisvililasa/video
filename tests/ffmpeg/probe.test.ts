import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { createMediaProbe } from "@/lib/ffmpeg/probe";
import { MediaProcessError } from "@/lib/ffmpeg/process-runner";
import type {
  MediaProcessResult,
  MediaProcessRunner,
  MediaProcessRunOptions
} from "@/lib/ffmpeg/types";
import { API_ERROR_CODES } from "@/lib/types";

const VIDEO_AUDIO_PROBE = {
  streams: [
    {
      index: 0,
      codec_type: "video",
      codec_name: "h264",
      width: 1920,
      height: 1080,
      avg_frame_rate: "30000/1001",
      r_frame_rate: "30/1",
      bit_rate: "4000000",
      duration: "12.5",
      pix_fmt: "yuv420p",
      sample_aspect_ratio: "1:1",
      color_range: "tv",
      color_space: "bt709",
      color_transfer: "bt709",
      color_primaries: "bt709",
      side_data_list: [{ rotation: 90 }]
    },
    {
      index: 1,
      codec_type: "audio",
      codec_name: "aac",
      sample_rate: "48000",
      channels: 2,
      bit_rate: "192000",
      duration: "12.5"
    }
  ],
  format: {
    format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    duration: "12.5",
    size: "5",
    bit_rate: "4192000"
  }
};

type FakeRunnerState = {
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  error?: Error;
};

let temporaryRoot: string;
let allowedRoot: string;
let inputPath: string;
let outsideRoot: string;
let outsidePath: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-probe-test-"));
  allowedRoot = path.join(temporaryRoot, "storage");
  const jobRoot = path.join(allowedRoot, "jobs", "job_test");
  await mkdir(jobRoot, { recursive: true });
  inputPath = path.join(jobRoot, "source media;safe.mp4");
  await writeFile(inputPath, "media");

  outsideRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-probe-outside-"));
  outsidePath = path.join(outsideRoot, "outside.mp4");
  await writeFile(outsidePath, "media");
});

afterEach(async () => {
  await Promise.all([
    rm(temporaryRoot, { recursive: true, force: true }),
    rm(outsideRoot, { recursive: true, force: true })
  ]);
});

function createHarness(initialState: FakeRunnerState = {}) {
  const state = { ...initialState };
  const calls: MediaProcessRunOptions[] = [];
  const runProcess: MediaProcessRunner = vi.fn(async (options: MediaProcessRunOptions) => {
    calls.push(options);
    if (state.error) throw state.error;

    return {
      exitCode: 0,
      signal: null,
      stdout: state.stdout ?? JSON.stringify(VIDEO_AUDIO_PROBE),
      stderr: state.stderr ?? "",
      stdoutTruncated: state.stdoutTruncated ?? false,
      stderrTruncated: false,
      durationMs: 4
    } satisfies MediaProcessResult;
  });

  const probe = createMediaProbe({
    runProcess,
    getAllowedRoot: () => allowedRoot,
    timeoutMs: 15_000,
    maxDurationSeconds: 30 * 60
  });

  return { state, calls, runProcess, probe };
}

async function getAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
    throw new Error("Expected probe to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
}

describe("safe ffprobe wrapper", () => {
  it("normalizes video and audio metadata and uses only fixed local arguments", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const result = await harness.probe(inputPath, { signal: controller.signal });
    const canonicalInput = await realpath(inputPath);

    expect(result).toMatchObject({
      durationSeconds: 12.5,
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      containerFormats: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
      sizeBytes: 5,
      bitRate: 4_192_000,
      hasVideo: true,
      hasAudio: true,
      width: 1920,
      height: 1080,
      videoCodec: "h264",
      audioCodec: "aac",
      frameRate: { numerator: 30_000, denominator: 1001, value: 30_000 / 1001 }
    });
    expect(result.videoStreams[0]).toMatchObject({
      codec: "h264",
      bitRate: 4_000_000,
      pixelFormat: "yuv420p",
      sampleAspectRatio: { numerator: 1, denominator: 1, value: 1 },
      rotationDegrees: 90
    });
    expect(result.audioStreams[0]).toMatchObject({
      codec: "aac",
      sampleRate: 48_000,
      channels: 2,
      bitRate: 192_000
    });

    expect(harness.calls).toHaveLength(1);
    const call = harness.calls[0];
    expect(call.tool).toBe("ffprobe");
    expect(call.cwd).toBe(path.dirname(canonicalInput));
    expect(call.timeoutMs).toBe(15_000);
    expect(call.signal).toBe(controller.signal);
    expect(call.args.at(-1)).toBe(canonicalInput);
    expect(call.args).toContain("-show_format");
    expect(call.args).toContain("-show_streams");
    expect(call.args).toContain("-show_entries");
    expect(call.args[call.args.indexOf("-show_entries") + 1]).toContain("stream_disposition=attached_pic");
    expect(call.args.slice(call.args.indexOf("-protocol_whitelist"), call.args.indexOf("-protocol_whitelist") + 2)).toEqual([
      "-protocol_whitelist",
      "file"
    ]);
    expect(call.args.join(" ")).not.toContain("http://");
    expect(call.args.join(" ")).not.toContain("https://");
    expect(call.stdout).toEqual({ maxBytes: 1024 * 1024, overflow: "terminate" });
    expect(call.stderr).toEqual({ maxBytes: 64 * 1024, overflow: "truncate-tail" });
  });

  it("supports a video without audio", async () => {
    const harness = createHarness({
      stdout: JSON.stringify({
        streams: [{ index: 0, codec_type: "video", codec_name: "vp9", width: 1280, height: 720, duration: "4" }],
        format: { format_name: "matroska,webm", duration: "4", size: "5" }
      })
    });

    const result = await harness.probe(inputPath);
    expect(result).toMatchObject({ hasVideo: true, hasAudio: false, videoCodec: "vp9" });
    expect(result.audioCodec).toBeUndefined();
    expect(result.audioStreams).toEqual([]);
  });

  it("supports an audio-only file", async () => {
    const harness = createHarness({
      stdout: JSON.stringify({
        streams: [{ index: 0, codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 2, duration: "9" }],
        format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "9", size: "5" }
      })
    });

    const result = await harness.probe(inputPath);
    expect(result).toMatchObject({ hasVideo: false, hasAudio: true, audioCodec: "aac", durationSeconds: 9 });
    expect(result.width).toBeUndefined();
    expect(result.height).toBeUndefined();
    expect(result.videoStreams).toEqual([]);
  });

  it("marks attached pictures so video operations can exclude cover art", async () => {
    const harness = createHarness({
      stdout: JSON.stringify({
        streams: [
          {
            index: 0,
            codec_type: "video",
            codec_name: "mjpeg",
            width: 600,
            height: 600,
            duration: "9",
            disposition: { attached_pic: 1 }
          },
          { index: 1, codec_type: "audio", codec_name: "aac", duration: "9" }
        ],
        format: { format_name: "mov", duration: "9", size: "5" }
      })
    });

    const result = await harness.probe(inputPath);
    expect(result.videoStreams[0].attachedPicture).toBe(true);
  });

  it("preserves multiple video and audio streams while ignoring other stream types", async () => {
    const harness = createHarness({
      stdout: JSON.stringify({
        streams: [
          { index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, duration: "10" },
          { index: 1, codec_type: "audio", codec_name: "aac", duration: "10" },
          { index: 2, codec_type: "video", codec_name: "hevc", width: 1280, height: 720, duration: "10" },
          { index: 3, codec_type: "audio", codec_name: "opus", duration: "10" },
          { index: 4, codec_type: "subtitle", codec_name: "webvtt" }
        ],
        format: { format_name: "mov", duration: "10", size: "5" }
      })
    });

    const result = await harness.probe(inputPath);
    expect(result.videoStreams.map((stream) => stream.codec)).toEqual(["h264", "hevc"]);
    expect(result.audioStreams.map((stream) => stream.codec)).toEqual(["aac", "opus"]);
    expect(result.videoCodec).toBe("h264");
    expect(result.audioCodec).toBe("aac");
  });

  it("uses a safe rational average frame rate with r_frame_rate fallback", async () => {
    const harness = createHarness({
      stdout: JSON.stringify({
        streams: [{
          codec_type: "video",
          codec_name: "h264",
          width: 640,
          height: 360,
          avg_frame_rate: "0/0",
          r_frame_rate: "24000/1001",
          duration: "2"
        }],
        format: { format_name: "mov", duration: "2", size: "5" }
      })
    });

    const result = await harness.probe(inputPath);
    expect(result.frameRate).toEqual({ numerator: 24_000, denominator: 1001, value: 24_000 / 1001 });
  });

  it("handles missing optional fields and invalid numeric strings", async () => {
    const harness = createHarness({
      stdout: JSON.stringify({
        streams: [{
          codec_type: "video",
          width: 640,
          height: 360,
          duration: "8",
          avg_frame_rate: "NaN",
          bit_rate: "Infinity"
        }],
        format: { format_name: "future-container", bit_rate: "NaN" }
      })
    });

    const result = await harness.probe(inputPath);
    expect(result).toMatchObject({
      durationSeconds: 8,
      formatName: "future-container",
      sizeBytes: 5,
      videoCodec: "unknown"
    });
    expect(result.bitRate).toBeUndefined();
    expect(result.frameRate).toBeUndefined();
    expect(result.videoStreams[0].bitRate).toBeUndefined();
  });

  it("maps invalid JSON to FFPROBE_FAILED", async () => {
    const harness = createHarness({ stdout: "{not-json" });
    const error = await getAppError(harness.probe(inputPath));
    expect(error.code).toBe(API_ERROR_CODES.FFPROBE_FAILED);
  });

  it("maps a non-zero ffprobe exit to INVALID_MEDIA_FILE", async () => {
    const harness = createHarness({
      error: new MediaProcessError({
        reason: "non-zero-exit",
        tool: "ffprobe",
        exitCode: 1,
        stderr: "invalid data found"
      })
    });

    const error = await getAppError(harness.probe(inputPath));
    expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
  });

  it("maps a runner timeout to PROCESSING_TIMEOUT", async () => {
    const harness = createHarness({
      error: new MediaProcessError({ reason: "timeout", tool: "ffprobe", signal: "SIGKILL" })
    });

    const error = await getAppError(harness.probe(inputPath));
    expect(error.code).toBe(API_ERROR_CODES.PROCESSING_TIMEOUT);
  });

  it("rejects an oversized or truncated JSON result", async () => {
    const overflowHarness = createHarness({
      error: new MediaProcessError({ reason: "stdout-limit", tool: "ffprobe", stdoutTruncated: true })
    });
    const truncatedHarness = createHarness({ stdoutTruncated: true });

    await expect(getAppError(overflowHarness.probe(inputPath))).resolves.toMatchObject({
      code: API_ERROR_CODES.FFPROBE_FAILED
    });
    await expect(getAppError(truncatedHarness.probe(inputPath))).resolves.toMatchObject({
      code: API_ERROR_CODES.FFPROBE_FAILED
    });
  });

  it.each([
    { name: "no streams", value: { streams: [], format: { duration: "1" } } },
    { name: "missing duration", value: { streams: [{ codec_type: "audio", codec_name: "aac" }], format: {} } },
    { name: "video dimensions missing", value: { streams: [{ codec_type: "video", codec_name: "h264", duration: "1" }], format: {} } },
    { name: "too many streams", value: { streams: Array.from({ length: 17 }, () => ({ codec_type: "audio", duration: "1" })), format: {} } }
  ])("rejects a corrupted media response: $name", async ({ value }) => {
    const harness = createHarness({ stdout: JSON.stringify(value) });
    const error = await getAppError(harness.probe(inputPath));
    expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
  });

  it("rejects media exceeding the configured duration", async () => {
    const harness = createHarness({
      stdout: JSON.stringify({
        streams: [{ codec_type: "audio", codec_name: "aac", duration: "1800.01" }],
        format: { format_name: "mov", duration: "1800.01", size: "5" }
      })
    });

    const error = await getAppError(harness.probe(inputPath));
    expect(error.code).toBe(API_ERROR_CODES.VIDEO_TOO_LONG);
  });

  it.each([
    { width: 3000, height: 3000 },
    { width: 3841, height: 100 }
  ])("rejects video resolution $width x $height", async ({ width, height }) => {
    const harness = createHarness({
      stdout: JSON.stringify({
        streams: [{ codec_type: "video", codec_name: "h264", width, height, duration: "1" }],
        format: { format_name: "mov", duration: "1", size: "5" }
      })
    });

    const error = await getAppError(harness.probe(inputPath));
    expect(error.code).toBe(API_ERROR_CODES.VIDEO_RESOLUTION_TOO_HIGH);
  });

  it.each([
    { width: 3840, height: 2160 },
    { width: 2160, height: 3840 }
  ])("accepts the 4K input boundary $width x $height", async ({ width, height }) => {
    const harness = createHarness({
      stdout: JSON.stringify({
        streams: [{ codec_type: "video", codec_name: "h264", width, height, duration: "1800" }],
        format: { format_name: "mov", duration: "1800", size: "5" }
      })
    });

    await expect(harness.probe(inputPath)).resolves.toMatchObject({ width, height, durationSeconds: 1800 });
  });

  it.each(["https://example.com/video.mp4", "http://example.com/video.mp4", "file:///tmp/video.mp4"])(
    "rejects a URL instead of a local path: %s",
    async (url) => {
      const harness = createHarness();
      const error = await getAppError(harness.probe(url));
      expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
      expect(harness.calls).toHaveLength(0);
    }
  );

  it("rejects a path outside the allowed temporary root", async () => {
    const harness = createHarness();
    const error = await getAppError(harness.probe(outsidePath));
    expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
    expect(harness.calls).toHaveLength(0);
  });

  it.each(["missing", "directory"])("rejects a %s local input before ffprobe", async (kind) => {
    const localPath = path.join(path.dirname(inputPath), kind === "missing" ? "missing.mp4" : "directory.mp4");
    if (kind === "directory") await mkdir(localPath);
    const harness = createHarness();

    const error = await getAppError(harness.probe(localPath));
    expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects symlinks without invoking ffprobe", async () => {
    const linkPath = path.join(path.dirname(inputPath), "linked.mp4");
    await symlink(inputPath, linkPath);
    const harness = createHarness();

    const error = await getAppError(harness.probe(linkPath));
    expect(error.code).toBe(API_ERROR_CODES.INVALID_MEDIA_FILE);
    expect(harness.calls).toHaveLength(0);
  });

  it("does not expose stderr or local paths in public errors", async () => {
    const secretStderr = `failure while reading ${inputPath}`;
    const harness = createHarness({
      error: new MediaProcessError({
        reason: "non-zero-exit",
        tool: "ffprobe",
        exitCode: 1,
        stderr: secretStderr
      })
    });

    const error = await getAppError(harness.probe(inputPath));
    expect(error.message).not.toContain(inputPath);
    expect(error.message).not.toContain(secretStderr);
    expect(error.details).toBeUndefined();
  });
});
