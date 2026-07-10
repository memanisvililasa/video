import type { SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ERROR_MESSAGES, API_ERROR_STATUS } from "@/lib/errors";
import {
  createMediaProcessRunner,
  MediaProcessError,
  type MediaProcessRunnerDependencies
} from "@/lib/ffmpeg/process-runner";
import type { MediaProcessRunOptions } from "@/lib/ffmpeg/types";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";
import { createSpawnRecorder, FakeChildProcess, type SpawnCall } from "../helpers/fake-child-process";

type Harness = ReturnType<typeof createHarness>;

function createHarness(overrides: Partial<MediaProcessRunnerDependencies> = {}) {
  const child = new FakeChildProcess();
  const calls: SpawnCall[] = [];
  const kills: NodeJS.Signals[] = [];
  const dependencies: MediaProcessRunnerDependencies = {
    spawnProcess: createSpawnRecorder(child, calls),
    killProcess: (_child, signal) => {
      kills.push(signal);
    },
    platform: "darwin",
    now: () => Date.now(),
    binaryPaths: {
      ffmpeg: "/trusted/bin/ffmpeg",
      ffprobe: "/trusted/bin/ffprobe"
    },
    nodeEnv: "test",
    pathValue: "/trusted/bin",
    killGraceMs: 50,
    ...overrides
  };

  const runner = createMediaProcessRunner(dependencies);
  const run = (options: Partial<MediaProcessRunOptions> = {}) => runner({
    tool: "ffmpeg",
    args: ["-hide_banner"],
    cwd: "/tmp/videosave-job",
    timeoutMs: 100,
    ...options
  });

  return { child, calls, kills, run };
}

async function getProcessError(promise: Promise<unknown>): Promise<MediaProcessError> {
  try {
    await promise;
    throw new Error("Expected media process to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(MediaProcessError);
    return error as MediaProcessError;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("safe media process runner", () => {
  it("spawns a trusted binary with literal arguments and no shell", async () => {
    const harness = createHarness();
    const args = ["-i", "name with spaces;$(echo unsafe).mp4"];
    const pending = harness.run({ args });

    harness.child.emitClose(0);
    await expect(pending).resolves.toMatchObject({ exitCode: 0, signal: null });

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0].command).toBe("/trusted/bin/ffmpeg");
    expect(harness.calls[0].args).toEqual(args);
    expect(harness.calls[0].options).toMatchObject({
      shell: false,
      cwd: "/tmp/videosave-job",
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    } satisfies Partial<SpawnOptions>);
    expect(harness.calls[0].options.env).toEqual({ LANG: "C", LC_ALL: "C", NODE_ENV: "test" });
  });

  it("does not spawn when the signal is already aborted", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    controller.abort();

    const error = await getProcessError(harness.run({ signal: controller.signal }));
    expect(error.reason).toBe("aborted");
    expect(harness.calls).toHaveLength(0);
  });

  it("returns bounded stdout, stderr and timing on a successful close", async () => {
    let now = 10;
    const harness = createHarness({ now: () => now });
    const pending = harness.run();
    harness.child.writeStdout("ok");
    harness.child.writeStderr("warning");
    now = 35;
    harness.child.emitClose(0);

    const result = await pending;
    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      stdout: "ok",
      stderr: "warning",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 25
    });
    expect(result).not.toHaveProperty("args");
    expect(result).not.toHaveProperty("binaryPath");
  });

  it("returns a typed error for a non-zero exit", async () => {
    const harness = createHarness();
    const pending = harness.run();
    harness.child.writeStderr("codec failed");
    harness.child.emitClose(7);

    const error = await getProcessError(pending);
    expect(error).toMatchObject({
      reason: "non-zero-exit",
      exitCode: 7,
      signal: null,
      stderr: "codec failed"
    });
  });

  it.each(["ENOENT", "EACCES"])("returns a typed spawn error for %s", async (code) => {
    const harness = createHarness();
    harness.child.pid = undefined;
    const pending = harness.run();
    harness.child.emitFailure(code);
    harness.child.emitClose(null);

    const error = await getProcessError(pending);
    expect(error).toMatchObject({ reason: "spawn", spawnCode: code });
  });

  it("sends SIGTERM and then SIGKILL after a timeout", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const pending = harness.run({ timeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    expect(harness.kills).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(50);
    expect(harness.kills).toEqual(["SIGTERM", "SIGKILL"]);
    harness.child.emitClose(null, "SIGKILL");

    const error = await getProcessError(pending);
    expect(error.reason).toBe("timeout");
  });

  it("cancels an active process through AbortSignal", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const controller = new AbortController();
    const pending = harness.run({ signal: controller.signal });

    controller.abort();
    expect(harness.kills).toEqual(["SIGTERM"]);
    harness.child.emitClose(null, "SIGTERM");

    const error = await getProcessError(pending);
    expect(error.reason).toBe("aborted");
  });

  it("cancels the force-kill timer when the process closes after SIGTERM", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const controller = new AbortController();
    const pending = harness.run({ signal: controller.signal });

    controller.abort();
    harness.child.emitClose(null, "SIGTERM");
    await getProcessError(pending);
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.kills).toEqual(["SIGTERM"]);
  });

  it("terminates when stdout exceeds a hard limit", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const pending = harness.run({
      stdout: { maxBytes: 4, overflow: "terminate" }
    });

    harness.child.writeStdout("12345");
    expect(harness.kills).toEqual(["SIGTERM"]);
    harness.child.emitClose(null, "SIGTERM");

    const error = await getProcessError(pending);
    expect(error).toMatchObject({
      reason: "stdout-limit",
      stdout: "1234",
      stdoutTruncated: true
    });
  });

  it("keeps only bounded stdout and stderr tails", async () => {
    const harness = createHarness();
    const pending = harness.run({
      stdout: { maxBytes: 5, overflow: "truncate-tail" },
      stderr: { maxBytes: 4, overflow: "truncate-tail" }
    });
    harness.child.writeStdout("abcdef");
    harness.child.writeStderr("UVWXYZ");
    harness.child.emitClose(0);

    await expect(pending).resolves.toMatchObject({
      stdout: "bcdef",
      stderr: "WXYZ",
      stdoutTruncated: true,
      stderrTruncated: true
    });
  });

  it("decodes split UTF-8 lines without replacement characters", async () => {
    const harness = createHarness();
    const lines: string[] = [];
    const pending = harness.run({
      stdout: { maxBytes: 16, overflow: "truncate-tail", onLine: (line) => lines.push(line) }
    });
    harness.child.writeStdout(Buffer.from([0xe2]));
    harness.child.writeStdout(Buffer.from([0x82, 0xac, 0x0a]));
    harness.child.emitClose(0);

    const result = await pending;
    expect(result.stdout).toBe("€\n");
    expect(lines).toEqual(["€"]);
    expect(result.stdout).not.toContain("�");
  });

  it("drops an incomplete UTF-8 prefix after tail truncation", async () => {
    const harness = createHarness();
    const pending = harness.run({
      stdout: { maxBytes: 4, overflow: "truncate-tail" }
    });
    harness.child.writeStdout("€AB");
    harness.child.emitClose(0);

    const result = await pending;
    expect(result.stdout).toBe("AB");
    expect(result.stdout).not.toContain("�");
  });

  it("settles only once when abort and timeout race", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const controller = new AbortController();
    const pending = harness.run({ signal: controller.signal, timeoutMs: 100 });

    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    harness.child.emitClose(null, "SIGTERM");

    const error = await getProcessError(pending);
    expect(error.reason).toBe("aborted");
    expect(harness.kills.filter((signal) => signal === "SIGTERM")).toHaveLength(1);
  });

  it("removes process and stream listeners after close", async () => {
    const harness = createHarness();
    const pending = harness.run();
    harness.child.emitClose(0);
    await pending;

    expect(harness.child.listenerCount("error")).toBe(0);
    expect(harness.child.listenerCount("close")).toBe(0);
    expect(harness.child.stdout?.listenerCount("data")).toBe(0);
    expect(harness.child.stderr?.listenerCount("data")).toBe(0);
  });

  it.each([
    { name: "NUL", options: { args: ["bad\0arg"] } },
    { name: "one oversized argument", options: { args: ["x".repeat(4097)] } },
    { name: "too many arguments", options: { args: Array.from({ length: 257 }, () => "x") } },
    { name: "oversized total arguments", options: { args: Array.from({ length: 17 }, () => "x".repeat(4096)) } },
    { name: "relative cwd", options: { cwd: "relative/job" } },
    { name: "zero timeout", options: { timeoutMs: 0 } },
    { name: "invalid output limit", options: { stdout: { maxBytes: 0, overflow: "terminate" as const } } },
    { name: "terminating stderr policy", options: { stderr: { maxBytes: 16, overflow: "terminate" as const } } }
  ])("rejects $name before spawn", async ({ options }) => {
    const harness = createHarness();
    await expect(harness.run(options)).rejects.toBeInstanceOf(TypeError);
    expect(harness.calls).toHaveLength(0);
  });

  it("requires an absolute binary path in production without exposing it", async () => {
    const harness = createHarness({
      nodeEnv: "production",
      binaryPaths: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" }
    });

    const error = await getProcessError(harness.run({ args: ["secret-argument"] }));
    expect(error).toMatchObject({ reason: "spawn", spawnCode: "INVALID_BINARY_PATH" });
    expect(error.message).not.toContain("ffmpeg");
    expect(error.message).not.toContain("secret-argument");
    expect(harness.calls).toHaveLength(0);
  });

  it("normalizes a synchronous spawn exception", async () => {
    const calls: SpawnCall[] = [];
    const harness = createHarness({
      spawnProcess: (command, args, options) => {
        calls.push({ command, args, options });
        throw Object.assign(new Error("could not spawn /trusted/bin/ffmpeg"), { code: "EACCES" });
      }
    });

    const error = await getProcessError(harness.run({ args: ["private-argument"] }));
    expect(error).toMatchObject({ reason: "spawn", spawnCode: "EACCES" });
    expect(error.message).not.toContain("/trusted/bin/ffmpeg");
    expect(error.message).not.toContain("private-argument");
    expect(calls).toHaveLength(1);
  });

  it("ignores observer errors without changing process lifecycle", async () => {
    const harness = createHarness();
    const pending = harness.run({
      stdout: {
        maxBytes: 16,
        overflow: "truncate-tail",
        onLine: () => {
          throw new Error("observer failed");
        }
      }
    });
    harness.child.writeStdout("progress=1\n");
    harness.child.emitClose(0);

    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
  });
});

describe("stage 5.1 API error mappings", () => {
  it("defines a message and HTTP status for every new media error", () => {
    const expectedStatuses: Partial<Record<ApiErrorCode, number>> = {
      [API_ERROR_CODES.FFMPEG_NOT_AVAILABLE]: 503,
      [API_ERROR_CODES.FFPROBE_FAILED]: 500,
      [API_ERROR_CODES.INVALID_MEDIA_FILE]: 422,
      [API_ERROR_CODES.AUDIO_STREAM_NOT_FOUND]: 422,
      [API_ERROR_CODES.UNSUPPORTED_CODEC]: 415,
      [API_ERROR_CODES.PROCESSING_FAILED]: 500,
      [API_ERROR_CODES.PROCESSING_TIMEOUT]: 504,
      [API_ERROR_CODES.OUTPUT_TOO_LARGE]: 413,
      [API_ERROR_CODES.VIDEO_TOO_LONG]: 422,
      [API_ERROR_CODES.VIDEO_RESOLUTION_TOO_HIGH]: 422,
      [API_ERROR_CODES.JOB_CANCELLED]: 409,
      [API_ERROR_CODES.JOB_NOT_FOUND]: 404,
      [API_ERROR_CODES.QUEUE_FULL]: 503,
      [API_ERROR_CODES.INVALID_JOB_STATE]: 409
    };

    for (const [code, status] of Object.entries(expectedStatuses) as Array<[ApiErrorCode, number]>) {
      expect(API_ERROR_STATUS[code]).toBe(status);
      expect(API_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });
});
