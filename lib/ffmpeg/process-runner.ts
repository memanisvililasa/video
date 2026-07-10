import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { env } from "@/lib/config/env";
import type {
  MediaProcessFailureReason,
  MediaProcessOutputPolicy,
  MediaProcessResult,
  MediaProcessRunOptions,
  MediaTool
} from "@/lib/ffmpeg/types";

const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 4 * 1024;
const MAX_TOTAL_ARGUMENT_BYTES = 64 * 1024;
const MAX_CAPTURE_POLICY_BYTES = 16 * 1024 * 1024;

export const MEDIA_PROCESS_OUTPUT_LIMITS = Object.freeze({
  ffprobeStdoutBytes: 1024 * 1024,
  ffmpegStdoutBytes: 64 * 1024,
  stderrBytes: 64 * 1024
});

type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type KillProcess = (child: ChildProcess, signal: NodeJS.Signals, detached: boolean) => void;

export type MediaProcessRunnerDependencies = {
  spawnProcess: SpawnProcess;
  killProcess: KillProcess;
  platform: NodeJS.Platform;
  now: () => number;
  binaryPaths: Readonly<Record<MediaTool, string>>;
  nodeEnv: string;
  pathValue?: string;
  killGraceMs: number;
};

type MediaProcessErrorOptions = {
  reason: MediaProcessFailureReason;
  tool: MediaTool;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  durationMs?: number;
  spawnCode?: string;
};

const FAILURE_MESSAGES: Record<MediaProcessFailureReason, string> = {
  spawn: "Media process could not be started.",
  "non-zero-exit": "Media process exited unsuccessfully.",
  timeout: "Media process exceeded its time limit.",
  aborted: "Media process was cancelled.",
  "stdout-limit": "Media process exceeded its output limit."
};

export class MediaProcessError extends Error {
  public readonly reason: MediaProcessFailureReason;
  public readonly tool: MediaTool;
  public readonly exitCode: number | null;
  public readonly signal: NodeJS.Signals | null;
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly stdoutTruncated: boolean;
  public readonly stderrTruncated: boolean;
  public readonly durationMs: number;
  public readonly spawnCode?: string;

  constructor(options: MediaProcessErrorOptions) {
    super(FAILURE_MESSAGES[options.reason]);
    this.name = "MediaProcessError";
    this.reason = options.reason;
    this.tool = options.tool;
    this.exitCode = options.exitCode ?? null;
    this.signal = options.signal ?? null;
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
    this.stdoutTruncated = options.stdoutTruncated ?? false;
    this.stderrTruncated = options.stderrTruncated ?? false;
    this.durationMs = options.durationMs ?? 0;
    this.spawnCode = options.spawnCode;
  }
}

function defaultStdoutPolicy(tool: MediaTool): MediaProcessOutputPolicy {
  return tool === "ffprobe"
    ? { maxBytes: MEDIA_PROCESS_OUTPUT_LIMITS.ffprobeStdoutBytes, overflow: "terminate" }
    : { maxBytes: MEDIA_PROCESS_OUTPUT_LIMITS.ffmpegStdoutBytes, overflow: "truncate-tail" };
}

function defaultStderrPolicy(): MediaProcessOutputPolicy {
  return { maxBytes: MEDIA_PROCESS_OUTPUT_LIMITS.stderrBytes, overflow: "truncate-tail" };
}

function validateOutputPolicy(policy: MediaProcessOutputPolicy, label: string): void {
  if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes <= 0 || policy.maxBytes > MAX_CAPTURE_POLICY_BYTES) {
    throw new TypeError(`${label}.maxBytes must be a positive integer no greater than ${MAX_CAPTURE_POLICY_BYTES}.`);
  }

  if (policy.overflow !== "terminate" && policy.overflow !== "truncate-tail") {
    throw new TypeError(`${label}.overflow is invalid.`);
  }

  if (policy.onLine !== undefined && typeof policy.onLine !== "function") {
    throw new TypeError(`${label}.onLine must be a function.`);
  }
}

function validateArguments(args: readonly string[]): void {
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS) {
    throw new TypeError(`Media process args must contain at most ${MAX_ARGUMENTS} entries.`);
  }

  let totalBytes = 0;
  for (const argument of args) {
    if (typeof argument !== "string" || argument.includes("\0")) {
      throw new TypeError("Media process arguments must be strings without NUL bytes.");
    }

    const bytes = Buffer.byteLength(argument);
    if (bytes > MAX_ARGUMENT_BYTES) {
      throw new TypeError(`A media process argument exceeds ${MAX_ARGUMENT_BYTES} bytes.`);
    }

    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_ARGUMENT_BYTES) {
      throw new TypeError(`Media process arguments exceed ${MAX_TOTAL_ARGUMENT_BYTES} bytes in total.`);
    }
  }
}

function validateRunOptions(options: MediaProcessRunOptions): void {
  if (options.tool !== "ffmpeg" && options.tool !== "ffprobe") {
    throw new TypeError("Media process tool is invalid.");
  }

  validateArguments(options.args);

  if (!path.isAbsolute(options.cwd) || options.cwd.includes("\0")) {
    throw new TypeError("Media process cwd must be an absolute path without NUL bytes.");
  }

  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new TypeError("Media process timeoutMs must be a positive integer.");
  }

  validateOutputPolicy(options.stdout ?? defaultStdoutPolicy(options.tool), "stdout");
  const stderrPolicy = options.stderr ?? defaultStderrPolicy();
  validateOutputPolicy(stderrPolicy, "stderr");
  if (stderrPolicy.overflow !== "truncate-tail") {
    throw new TypeError("Media process stderr must use truncate-tail overflow handling.");
  }
}

function getSpawnCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function validateBinaryPath(tool: MediaTool, binaryPath: string, nodeEnv: string): void {
  if (typeof binaryPath !== "string") {
    throw new MediaProcessError({ reason: "spawn", tool, spawnCode: "INVALID_BINARY_PATH" });
  }

  const allowedBasename = tool;
  const isAbsolute = path.isAbsolute(binaryPath);
  const isAllowedDevelopmentBasename = nodeEnv !== "production" && binaryPath === allowedBasename;

  if (!binaryPath || binaryPath.includes("\0") || (!isAbsolute && !isAllowedDevelopmentBasename)) {
    throw new MediaProcessError({
      reason: "spawn",
      tool,
      spawnCode: "INVALID_BINARY_PATH"
    });
  }
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

function decodeUtf8Tail(buffer: Buffer): string {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
}

class BoundedOutputCapture {
  private buffer = Buffer.alloc(0);
  private readonly decoder?: StringDecoder;
  private lineRemainder = "";
  private overflowSignalled = false;
  public truncated = false;

  constructor(
    private readonly policy: MediaProcessOutputPolicy,
    private readonly onOverflow: () => void
  ) {
    this.decoder = policy.onLine ? new StringDecoder("utf8") : undefined;
  }

  append(value: unknown): void {
    const chunk = toBuffer(value);
    this.consumeLines(chunk);

    if (this.policy.overflow === "terminate") {
      const remaining = Math.max(0, this.policy.maxBytes - this.buffer.length);
      if (remaining > 0) this.buffer = Buffer.concat([this.buffer, chunk.subarray(0, remaining)]);

      if (chunk.length > remaining) {
        this.truncated = true;
        if (!this.overflowSignalled) {
          this.overflowSignalled = true;
          this.onOverflow();
        }
      }
      return;
    }

    if (chunk.length >= this.policy.maxBytes) {
      this.truncated = this.truncated || this.buffer.length > 0 || chunk.length > this.policy.maxBytes;
      this.buffer = Buffer.from(chunk.subarray(chunk.length - this.policy.maxBytes));
      return;
    }

    if (this.buffer.length + chunk.length > this.policy.maxBytes) {
      this.truncated = true;
      const retainedBytes = this.policy.maxBytes - chunk.length;
      this.buffer = Buffer.concat([this.buffer.subarray(this.buffer.length - retainedBytes), chunk]);
      return;
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  finish(): void {
    if (!this.decoder) return;
    const finalText = this.decoder.end();
    if (finalText) this.consumeDecodedLines(finalText);
    if (this.lineRemainder) this.emitLine(this.lineRemainder);
    this.lineRemainder = "";
  }

  text(): string {
    return decodeUtf8Tail(this.buffer);
  }

  private consumeLines(chunk: Buffer): void {
    if (!this.decoder) return;
    const decoded = this.decoder.write(chunk);
    if (decoded) this.consumeDecodedLines(decoded);
  }

  private consumeDecodedLines(decoded: string): void {
    const lines = `${this.lineRemainder}${decoded}`.split(/\r?\n/);
    this.lineRemainder = lines.pop() ?? "";

    const remainderBytes = Buffer.from(this.lineRemainder);
    if (remainderBytes.length > this.policy.maxBytes) {
      this.lineRemainder = decodeUtf8Tail(remainderBytes.subarray(remainderBytes.length - this.policy.maxBytes));
    }

    for (const line of lines) this.emitLine(line);
  }

  private emitLine(line: string): void {
    try {
      this.policy.onLine?.(line);
    } catch {
      // Progress observers must not affect process lifecycle.
    }
  }
}

function defaultKillProcess(child: ChildProcess, signal: NodeJS.Signals, detached: boolean): void {
  if (detached && typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (getSpawnCode(error) === "ESRCH") return;
    }
  }

  child.kill(signal);
}

/** @internal Exported for deterministic lifecycle tests. */
export function createMediaProcessRunner(dependencies: MediaProcessRunnerDependencies) {
  if (!Number.isSafeInteger(dependencies.killGraceMs) || dependencies.killGraceMs <= 0) {
    throw new TypeError("Media process killGraceMs must be a positive integer.");
  }

  return async function run(options: MediaProcessRunOptions): Promise<MediaProcessResult> {
    const startedAt = dependencies.now();
    validateRunOptions(options);

    const binaryPath = dependencies.binaryPaths[options.tool];
    validateBinaryPath(options.tool, binaryPath, dependencies.nodeEnv);

    if (options.signal?.aborted) {
      throw new MediaProcessError({ reason: "aborted", tool: options.tool });
    }

    const detached = dependencies.platform !== "win32";
    const childNodeEnv = dependencies.nodeEnv === "production"
      ? "production"
      : dependencies.nodeEnv === "test"
        ? "test"
        : "development";
    const childEnvironment: NodeJS.ProcessEnv = {
      LANG: "C",
      LC_ALL: "C",
      NODE_ENV: childNodeEnv
    };
    if (!path.isAbsolute(binaryPath) && dependencies.pathValue) childEnvironment.PATH = dependencies.pathValue;

    let child: ChildProcess;
    try {
      child = dependencies.spawnProcess(binaryPath, options.args, {
        shell: false,
        cwd: options.cwd,
        detached,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnvironment
      });
    } catch (error) {
      throw new MediaProcessError({
        reason: "spawn",
        tool: options.tool,
        durationMs: Math.max(0, dependencies.now() - startedAt),
        spawnCode: getSpawnCode(error)
      });
    }

    return new Promise<MediaProcessResult>((resolve, reject) => {
      let settled = false;
      let failureReason: MediaProcessFailureReason | undefined;
      let spawnCode: string | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;

      const stdoutPolicy = options.stdout ?? defaultStdoutPolicy(options.tool);
      const stderrPolicy = options.stderr ?? defaultStderrPolicy();
      const stdoutCapture = new BoundedOutputCapture(stdoutPolicy, () => requestTermination("stdout-limit"));
      const stderrCapture = new BoundedOutputCapture(stderrPolicy, () => undefined);

      const onStdoutData = (chunk: unknown) => stdoutCapture.append(chunk);
      const onStderrData = (chunk: unknown) => stderrCapture.append(chunk);

      const sendSignal = (signal: NodeJS.Signals) => {
        try {
          dependencies.killProcess(child, signal, detached);
        } catch {
          // A close event or the force-kill timer remains authoritative.
        }
      };

      function requestTermination(reason: MediaProcessFailureReason): void {
        if (settled || failureReason) return;
        failureReason = reason;
        sendSignal("SIGTERM");
        if (!settled) forceKillTimeout = setTimeout(() => sendSignal("SIGKILL"), dependencies.killGraceMs);
      }

      const onAbort = () => requestTermination("aborted");

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        if (forceKillTimeout) clearTimeout(forceKillTimeout);
        options.signal?.removeEventListener("abort", onAbort);
        child.off("error", onError);
        child.off("close", onClose);
        child.stdout?.off("data", onStdoutData);
        child.stderr?.off("data", onStderrData);
      };

      const durationMs = () => Math.max(0, dependencies.now() - startedAt);

      const createFailure = (
        reason: MediaProcessFailureReason,
        exitCode: number | null,
        signal: NodeJS.Signals | null
      ) => new MediaProcessError({
        reason,
        tool: options.tool,
        exitCode,
        signal,
        stdout: stdoutCapture.text(),
        stderr: stderrCapture.text(),
        stdoutTruncated: stdoutCapture.truncated,
        stderrTruncated: stderrCapture.truncated,
        durationMs: durationMs(),
        spawnCode
      });

      function onError(error: Error): void {
        spawnCode = getSpawnCode(error);
        requestTermination("spawn");
      }

      function onClose(exitCode: number | null, signal: NodeJS.Signals | null): void {
        if (settled) return;
        settled = true;
        stdoutCapture.finish();
        stderrCapture.finish();
        cleanup();

        if (failureReason) {
          reject(createFailure(failureReason, exitCode, signal));
          return;
        }

        if (exitCode !== 0) {
          reject(createFailure("non-zero-exit", exitCode, signal));
          return;
        }

        resolve({
          exitCode: 0,
          signal: null,
          stdout: stdoutCapture.text(),
          stderr: stderrCapture.text(),
          stdoutTruncated: stdoutCapture.truncated,
          stderrTruncated: stderrCapture.truncated,
          durationMs: durationMs()
        });
      }

      child.on("error", onError);
      child.on("close", onClose);
      child.stdout?.on("data", onStdoutData);
      child.stderr?.on("data", onStderrData);
      options.signal?.addEventListener("abort", onAbort, { once: true });

      timeout = setTimeout(() => requestTermination("timeout"), options.timeoutMs);

      if (options.signal?.aborted) onAbort();

      if (!child.stdout || !child.stderr) {
        spawnCode = "INVALID_STDIO";
        requestTermination("spawn");
      }
    });
  };
}

export const runMediaProcess = createMediaProcessRunner({
  spawnProcess: spawn,
  killProcess: defaultKillProcess,
  platform: process.platform,
  now: () => performance.now(),
  binaryPaths: {
    ffmpeg: env.ffmpegPath,
    ffprobe: env.ffprobePath
  },
  nodeEnv: env.nodeEnv,
  pathValue: process.env.PATH,
  killGraceMs: env.ffmpegKillGraceSeconds * 1000
});
