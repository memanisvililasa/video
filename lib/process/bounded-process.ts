import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";

const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 4 * 1024;
const MAX_TOTAL_ARGUMENT_BYTES = 64 * 1024;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

export type BoundedProcessFailureReason =
  | "spawn"
  | "non-zero-exit"
  | "timeout"
  | "aborted"
  | "stdout-limit";

export type BoundedProcessRunOptions = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
  timeoutMs: number;
  killGraceMs: number;
  stdoutMaxBytes: number;
  stderrMaxBytes: number;
  signal?: AbortSignal;
}>;

export type BoundedProcessResult = Readonly<{
  stdout: string;
  stderr: string;
  stderrTruncated: boolean;
  durationMs: number;
}>;

export class BoundedProcessError extends Error {
  constructor(
    public readonly reason: BoundedProcessFailureReason,
    public readonly exitCode: number | null = null,
    public readonly signal: NodeJS.Signals | null = null,
    public readonly stderr = "",
    public readonly stderrTruncated = false,
    public readonly spawnCode?: string
  ) {
    super("External process failed within its bounded execution contract.");
    this.name = "BoundedProcessError";
  }
}

type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type KillProcess = (child: ChildProcess, signal: NodeJS.Signals, detached: boolean) => void;

export type BoundedProcessDependencies = Readonly<{
  spawnProcess: SpawnProcess;
  killProcess: KillProcess;
  platform: NodeJS.Platform;
  now: () => number;
}>;

function spawnCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function validateOptions(options: BoundedProcessRunOptions): void {
  if (!options.command || options.command.includes("\0")) throw new TypeError("Process command is invalid.");
  if (!path.isAbsolute(options.cwd) || options.cwd.includes("\0")) throw new TypeError("Process cwd is invalid.");
  if (!Array.isArray(options.args) || options.args.length > MAX_ARGUMENTS) throw new TypeError("Process argument count is invalid.");
  let totalBytes = 0;
  for (const argument of options.args) {
    if (typeof argument !== "string" || argument.includes("\0")) throw new TypeError("Process argument is invalid.");
    const bytes = Buffer.byteLength(argument);
    if (bytes > MAX_ARGUMENT_BYTES) throw new TypeError("Process argument is too large.");
    totalBytes += bytes;
  }
  if (totalBytes > MAX_TOTAL_ARGUMENT_BYTES) throw new TypeError("Process arguments are too large.");
  for (const [name, value] of [["timeoutMs", options.timeoutMs], ["killGraceMs", options.killGraceMs]] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer.`);
  }
  for (const [name, value] of [["stdoutMaxBytes", options.stdoutMaxBytes], ["stderrMaxBytes", options.stderrMaxBytes]] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CAPTURE_BYTES) {
      throw new TypeError(`${name} is outside the supported range.`);
    }
  }
}

function defaultKillProcess(child: ChildProcess, signal: NodeJS.Signals, detached: boolean): void {
  if (detached && child.pid && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (spawnCode(error) === "ESRCH") return;
    }
  }
  child.kill(signal);
}

export function createBoundedProcessRunner(dependencies: BoundedProcessDependencies) {
  return async (options: BoundedProcessRunOptions): Promise<BoundedProcessResult> => {
    validateOptions(options);
    if (options.signal?.aborted) throw new BoundedProcessError("aborted");
    const startedAt = dependencies.now();
    const detached = dependencies.platform !== "win32";
    let child: ChildProcess;
    try {
      child = dependencies.spawnProcess(options.command, options.args, {
        shell: false,
        cwd: options.cwd,
        detached,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...options.env }
      });
    } catch (error) {
      throw new BoundedProcessError("spawn", null, null, "", false, spawnCode(error));
    }

    return await new Promise<BoundedProcessResult>((resolve, reject) => {
      let settled = false;
      let reason: BoundedProcessFailureReason | undefined;
      let childSpawnCode: string | undefined;
      let stdoutBytes = 0;
      const stdout: Buffer[] = [];
      let stderr = Buffer.alloc(0);
      let stderrTruncated = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

      const sendSignal = (signal: NodeJS.Signals) => {
        try { dependencies.killProcess(child, signal, detached); } catch { /* close remains authoritative */ }
      };
      const terminate = (failure: BoundedProcessFailureReason) => {
        if (settled || reason) return;
        reason = failure;
        sendSignal("SIGTERM");
        forceKillTimer = setTimeout(() => sendSignal("SIGKILL"), options.killGraceMs);
      };
      const onAbort = () => terminate("aborted");
      const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
      const toBuffer = (value: unknown) => Buffer.isBuffer(value)
        ? value
        : value instanceof Uint8Array
          ? Buffer.from(value)
          : Buffer.from(String(value));
      const onStdout = (value: unknown) => {
        const chunk = toBuffer(value);
        const remaining = Math.max(0, options.stdoutMaxBytes - stdoutBytes);
        if (remaining > 0) {
          stdout.push(chunk.subarray(0, remaining));
          stdoutBytes += Math.min(chunk.length, remaining);
        }
        if (chunk.length > remaining) terminate("stdout-limit");
      };
      const onStderr = (value: unknown) => {
        const chunk = toBuffer(value);
        if (chunk.length >= options.stderrMaxBytes) {
          stderr = Buffer.from(chunk.subarray(chunk.length - options.stderrMaxBytes));
          stderrTruncated = true;
          return;
        }
        if (stderr.length + chunk.length > options.stderrMaxBytes) {
          stderr = Buffer.concat([stderr.subarray(stderr.length + chunk.length - options.stderrMaxBytes), chunk]);
          stderrTruncated = true;
          return;
        }
        stderr = Buffer.concat([stderr, chunk]);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        options.signal?.removeEventListener("abort", onAbort);
        child.stdout?.off("data", onStdout);
        child.stderr?.off("data", onStderr);
      };
      const fail = (failure: BoundedProcessFailureReason, code: number | null, signal: NodeJS.Signals | null) =>
        new BoundedProcessError(failure, code, signal, stderr.toString("utf8"), stderrTruncated, childSpawnCode);

      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.once("error", (error) => {
        childSpawnCode = spawnCode(error);
        terminate("spawn");
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (reason) return reject(fail(reason, code, signal));
        if (code !== 0) return reject(fail("non-zero-exit", code, signal));
        resolve(Object.freeze({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: stderr.toString("utf8"),
          stderrTruncated,
          durationMs: Math.max(0, dependencies.now() - startedAt)
        }));
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (!child.stdout || !child.stderr) terminate("spawn");
      if (options.signal?.aborted) onAbort();
    });
  };
}

export const runBoundedProcess = createBoundedProcessRunner({
  spawnProcess: spawn,
  killProcess: defaultKillProcess,
  platform: process.platform,
  now: () => performance.now()
});
