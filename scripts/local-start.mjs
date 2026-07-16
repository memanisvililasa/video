import { constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APPROVED_YT_DLP_VERSION } from "./release-contract.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

export const LOCAL_HOSTNAME = "127.0.0.1";
export const EXPECTED_NODE_VERSION = packageJson.engines.node;
export const EXPECTED_NPM_VERSION = packageJson.engines.npm;

function failure(message) {
  return new Error(`Local runtime preflight failed: ${message}`);
}

export function npmVersionFromEnvironment(environment = process.env) {
  const match = /(?:^|\s)npm\/([^\s]+)/.exec(environment.npm_config_user_agent ?? "");
  return match?.[1] ?? null;
}

function defaultRun(command, args) {
  return spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true
  });
}

function commandOutput(result, command) {
  if (result.error) {
    if (result.error.code === "ENOENT") throw failure(`${command} is not installed or is not on PATH.`);
    throw failure(`${command} could not be executed (${result.error.message}).`);
  }
  if (result.status !== 0) throw failure(`${command} exited with status ${result.status ?? "unknown"}.`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

export async function checkLocalRuntime(options = {}) {
  const environment = options.environment ?? process.env;
  const run = options.run ?? defaultRun;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const npmVersion = options.npmVersion ?? npmVersionFromEnvironment(environment);
  const storagePath = path.resolve(projectRoot, options.storagePath ?? environment.STORAGE_PATH ?? "storage/tmp");

  if (nodeVersion !== EXPECTED_NODE_VERSION) {
    throw failure(`Node.js ${EXPECTED_NODE_VERSION} is required; found ${nodeVersion || "unknown"}.`);
  }
  if (npmVersion !== EXPECTED_NPM_VERSION) {
    throw failure(
      `npm ${EXPECTED_NPM_VERSION} is required; found ${npmVersion || "unknown"}. Run through Corepack: corepack npm run local.`
    );
  }

  const ffmpegVersion = commandOutput(run("ffmpeg", ["-version"]), "ffmpeg");
  commandOutput(run("ffprobe", ["-version"]), "ffprobe");
  const encoders = commandOutput(run("ffmpeg", ["-hide_banner", "-encoders"]), "ffmpeg encoder check");
  if (!/\blibx264\b/.test(encoders)) throw failure("FFmpeg does not provide the libx264 encoder.");
  if (!/^\s*A[.A-Z]{5}\s+aac\s/m.test(encoders)) throw failure("FFmpeg does not provide the AAC encoder.");
  const ytDlpVersion = commandOutput(run("yt-dlp", [
    "--ignore-config",
    "--no-config-locations",
    "--no-plugin-dirs",
    "--no-remote-components",
    "--no-cookies",
    "--no-cookies-from-browser",
    "--no-netrc",
    "--version"
  ]), "yt-dlp").trim();
  if (ytDlpVersion !== APPROVED_YT_DLP_VERSION) {
    throw failure(`yt-dlp ${APPROVED_YT_DLP_VERSION} is required; found ${ytDlpVersion || "unknown"}.`);
  }

  await mkdir(storagePath, { recursive: true });
  await access(storagePath, constants.R_OK | constants.W_OK | constants.X_OK).catch(() => {
    throw failure("local storage is not readable, writable, and searchable.");
  });

  return Object.freeze({
    nodeVersion,
    npmVersion,
    ffmpegVersion: ffmpegVersion.match(/^ffmpeg version\s+([^\s]+)/m)?.[1] ?? "available",
    ytDlpVersion,
    storagePath
  });
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const unsupported = argv.filter((argument) => argument !== "--check");
  if (unsupported.length > 0) throw failure(`unsupported argument: ${unsupported[0]}`);
  const result = await checkLocalRuntime(options);
  const output = options.output ?? process.stdout;
  output.write(
    `Local runtime ready (Node.js ${result.nodeVersion}, npm ${result.npmVersion}, FFmpeg ${result.ffmpegVersion}, yt-dlp ${result.ytDlpVersion}).\n`
  );
  if (argv.includes("--check")) return 0;

  const nextBin = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
  await access(nextBin, constants.R_OK).catch(() => {
    throw failure("Next.js is not installed. Run corepack npm install first.");
  });
  const child = (options.spawn ?? spawn)(
    process.execPath,
    [nextBin, "dev", "--hostname", LOCAL_HOSTNAME],
    { cwd: projectRoot, env: process.env, stdio: "inherit" }
  );
  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);
      if (signal) resolve(128);
      else resolve(code ?? 1);
    });
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
