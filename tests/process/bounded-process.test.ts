import { describe, expect, it, vi } from "vitest";
import { createBoundedProcessRunner, BoundedProcessError } from "@/lib/process/bounded-process";
import { FakeChildProcess, createSpawnRecorder, type SpawnCall } from "@/tests/helpers/fake-child-process";

function harness() {
  const child = new FakeChildProcess();
  const calls: SpawnCall[] = [];
  const kills: NodeJS.Signals[] = [];
  const runner = createBoundedProcessRunner({
    spawnProcess: createSpawnRecorder(child, calls),
    killProcess: (_child, signal) => { kills.push(signal); },
    platform: "darwin",
    now: () => 100
  });
  const options = {
    command: "/safe/tool",
    args: ["--fixed"] as const,
    cwd: "/tmp",
    env: { NODE_ENV: "production" as const, LANG: "C" },
    timeoutMs: 1_000,
    killGraceMs: 50,
    stdoutMaxBytes: 64,
    stderrMaxBytes: 16
  };
  return { child, calls, kills, runner, options };
}

describe("bounded external process runner", () => {
  it("spawns without a shell and returns bounded output", async () => {
    const state = harness();
    const pending = state.runner(state.options);
    state.child.writeStdout("result");
    state.child.writeStderr("diagnostic");
    state.child.emitClose(0);
    await expect(pending).resolves.toMatchObject({ stdout: "result", stderr: "diagnostic" });
    expect(state.calls[0]).toMatchObject({ command: "/safe/tool", args: ["--fixed"] });
    expect(state.calls[0].options).toMatchObject({ shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  });

  it("terminates the process group when stdout exceeds its cap", async () => {
    const state = harness();
    const pending = state.runner({ ...state.options, stdoutMaxBytes: 4 });
    state.child.writeStdout("oversized");
    state.child.emitClose(null, "SIGTERM");
    await expect(pending).rejects.toMatchObject({ reason: "stdout-limit" });
    expect(state.kills).toContain("SIGTERM");
  });

  it("maps cancellation and never invokes a shell", async () => {
    const state = harness();
    const controller = new AbortController();
    const pending = state.runner({ ...state.options, signal: controller.signal });
    controller.abort();
    state.child.emitClose(null, "SIGTERM");
    await expect(pending).rejects.toEqual(expect.objectContaining<Partial<BoundedProcessError>>({ reason: "aborted" }));
    expect(state.kills).toContain("SIGTERM");
  });

  it("rejects NUL arguments before spawn", async () => {
    const state = harness();
    await expect(state.runner({ ...state.options, args: ["bad\0argument"] })).rejects.toThrow(TypeError);
    expect(state.calls).toHaveLength(0);
  });

  it("requires an absolute working directory", async () => {
    const state = harness();
    await expect(state.runner({ ...state.options, cwd: "relative" })).rejects.toThrow("cwd");
    expect(state.calls).toHaveLength(0);
  });
});
