import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Local launcher is intentionally plain Node.js ESM.
import * as localStart from "../../scripts/local-start.mjs";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

function successfulTool(command: string, args: string[]) {
  if (command === "ffmpeg" && args.includes("-encoders")) {
    return { status: 0, stdout: " V....D libx264 H.264\n A....D aac AAC\n", stderr: "" };
  }
  if (command === "yt-dlp") return { status: 0, stdout: "2026.07.04\n", stderr: "" };
  if (command === "ffmpeg") return { status: 0, stdout: "ffmpeg version 8.1.2 test\n", stderr: "" };
  return { status: 0, stdout: "ffprobe version 8.1.2 test\n", stderr: "" };
}

async function tempStorage() {
  const root = await mkdtemp(path.join(os.tmpdir(), "videosave-local-start-"));
  roots.add(root);
  return path.join(root, "storage");
}

describe("personal-use local launcher", () => {
  it("accepts the exact repository toolchain and required media encoders", async () => {
    await expect(localStart.checkLocalRuntime({
      nodeVersion: localStart.EXPECTED_NODE_VERSION,
      npmVersion: localStart.EXPECTED_NPM_VERSION,
      storagePath: await tempStorage(),
      run: successfulTool
    })).resolves.toMatchObject({
      nodeVersion: localStart.EXPECTED_NODE_VERSION,
      npmVersion: localStart.EXPECTED_NPM_VERSION,
      ffmpegVersion: "8.1.2",
      ytDlpVersion: "2026.07.04"
    });
  });

  it.each([
    ["Node.js", { nodeVersion: "0.0.0", npmVersion: localStart.EXPECTED_NPM_VERSION }],
    ["npm", { nodeVersion: localStart.EXPECTED_NODE_VERSION, npmVersion: "0.0.0" }]
  ])("rejects a mismatched %s toolchain", async (_name, versions) => {
    await expect(localStart.checkLocalRuntime({
      ...versions,
      storagePath: await tempStorage(),
      run: successfulTool
    })).rejects.toThrow(_name);
  });

  it("fails clearly when FFmpeg or a required encoder is unavailable", async () => {
    await expect(localStart.checkLocalRuntime({
      nodeVersion: localStart.EXPECTED_NODE_VERSION,
      npmVersion: localStart.EXPECTED_NPM_VERSION,
      storagePath: await tempStorage(),
      run: (command: string, args: string[]) => command === "ffmpeg" && args.includes("-encoders")
        ? { status: 0, stdout: " A....D aac AAC\n", stderr: "" }
        : successfulTool(command, args)
    })).rejects.toThrow("libx264");
  });

  it("rejects a yt-dlp version outside the exact approved contract", async () => {
    await expect(localStart.checkLocalRuntime({
      nodeVersion: localStart.EXPECTED_NODE_VERSION,
      npmVersion: localStart.EXPECTED_NPM_VERSION,
      storagePath: await tempStorage(),
      run: (command: string, args: string[]) => command === "yt-dlp"
        ? { status: 0, stdout: "2026.08.01\n", stderr: "" }
        : successfulTool(command, args)
    })).rejects.toThrow("yt-dlp 2026.07.04 is required");
  });

  it("starts Next.js on IPv4 loopback only after preflight", async () => {
    const child = new EventEmitter() as EventEmitter & { killed: boolean; kill: ReturnType<typeof vi.fn> };
    child.killed = false;
    child.kill = vi.fn();
    const spawn = vi.fn((..._arguments: unknown[]) => child);
    const output = { write: vi.fn() };
    const running = localStart.main([], {
      nodeVersion: localStart.EXPECTED_NODE_VERSION,
      npmVersion: localStart.EXPECTED_NPM_VERSION,
      storagePath: await tempStorage(),
      run: successfulTool,
      spawn,
      output
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const [, args, options] = spawn.mock.calls[0] as [string, string[], { cwd: string; stdio: string }];
    expect(args.slice(-3)).toEqual(["dev", "--hostname", "127.0.0.1"]);
    expect(path.resolve(options.cwd)).toBe(process.cwd());
    expect(options.stdio).toBe("inherit");
    child.emit("exit", 0, null);
    await expect(running).resolves.toBe(0);
  });
});
