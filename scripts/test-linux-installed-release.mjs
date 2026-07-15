import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { initializeVolumeMarker } from "./durable-volume-admin.mjs";
import { installRelease } from "./release-deployment.mjs";
import {
  APPROVED_NODE_VERSION,
  APPROVED_NPM_VERSION,
  RELEASE_MANIFEST_FILE,
  RELEASE_ROOT_DIRECTORY
} from "./release-contract.mjs";

const run = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const releaseRoot = path.join(projectRoot, RELEASE_ROOT_DIRECTORY);
const AUTHORITY = "0123456789abcdef0123456789abcdef";

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function executable(name) {
  const result = await run("which", [name], { maxBuffer: 64 * 1024 });
  const value = result.stdout.trim();
  if (!path.isAbsolute(value)) throw new Error("Required media executable is unavailable.");
  return value;
}

async function npmVersion() {
  const npm = process.env.npm_execpath?.trim();
  const result = npm
    ? await run(process.execPath, [npm, "--version"], { maxBuffer: 64 * 1024 })
    : await run("npm", ["--version"], { maxBuffer: 64 * 1024 });
  return result.stdout.trim();
}

async function makeWritable(value) {
  const info = await lstat(value).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(value, 0o755).catch(() => undefined);
    for (const entry of await readdir(value)) await makeWritable(path.join(value, entry));
  } else {
    await chmod(value, 0o644).catch(() => undefined);
  }
}

async function runChecked(entrypoint, args, options) {
  try {
    await run(process.execPath, [entrypoint, ...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? 30_000,
      maxBuffer: 512 * 1024
    });
  } catch {
    throw new Error("Installed release command failed without exposing runtime configuration.");
  }
}

async function waitForOutput(child, output, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Installed release process exited before readiness.");
    if (output.value.includes(marker)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Installed release process readiness timed out.");
}

async function stop(child, label, timeoutMs = 15_000) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not stop gracefully.`)), timeoutMs))
  ]).catch((error) => {
    child.kill("SIGKILL");
    throw error;
  });
}

async function main() {
  if (process.platform !== "linux") throw new Error("Installed release process validation requires Linux.");
  if (process.version.replace(/^v/, "") !== APPROVED_NODE_VERSION) throw new Error("Node version is not approved.");
  if (await npmVersion() !== APPROVED_NPM_VERSION) throw new Error("npm version is not approved.");
  const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for Linux release validation.");
  const manifest = JSON.parse(await readFile(path.join(releaseRoot, RELEASE_MANIFEST_FILE), "utf8"));
  if (manifest.build.target !== `${process.platform}-${process.arch}` || manifest.build.sourceTreeDirty !== false) {
    throw new Error("Release is not a clean approved Linux artifact.");
  }
  const deploymentRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-linux-release-"));
  const volumeRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-linux-volume-"));
  try {
    await Promise.all([
      mkdir(path.join(deploymentRoot, "releases")),
      mkdir(path.join(deploymentRoot, ".deployment")),
      mkdir(path.join(volumeRoot, "jobs"), { mode: 0o750 }),
      mkdir(path.join(volumeRoot, "published"), { mode: 0o750 })
    ]);
    await initializeVolumeMarker({ root: volumeRoot, authorityId: AUTHORITY });
    const basename = `videosave-${manifest.application.version}-${manifest.build.gitCommit.slice(0, 12)}.tar.gz`;
    const installed = await installRelease({
      archive: path.join(path.dirname(releaseRoot), basename),
      checksum: path.join(path.dirname(releaseRoot), `${basename}.sha256`),
      deploymentRoot,
      expectedCommit: manifest.build.gitCommit
    });
    const installedRoot = path.join(deploymentRoot, "releases", installed.releaseId);
    const ffmpeg = await executable("ffmpeg");
    const ffprobe = await executable("ffprobe");
    const common = {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      POSTGRES_SSL_MODE: "disable",
      POSTGRES_POOL_MAX: "5",
      POSTGRES_CONNECTION_TIMEOUT_MS: "5000",
      POSTGRES_STATEMENT_TIMEOUT_MS: "5000",
      POSTGRES_QUERY_TIMEOUT_MS: "5000",
      POSTGRES_IDLE_TIMEOUT_MS: "1000",
      JOB_REPOSITORY_BACKEND: "postgres",
      MEDIA_STORAGE_BACKEND: "durable-volume",
      MEDIA_STORAGE_ROOT: volumeRoot,
      MEDIA_STORAGE_AUTHORITY_ID: AUTHORITY,
      MEDIA_STORAGE_MAX_JOB_BYTES: "10485760",
      MEDIA_STORAGE_MAX_OUTPUT_BYTES: "5242880",
      MEDIA_STORAGE_LOW_DISK_BYTES: "1048576",
      MEDIA_FINAL_TTL_SECONDS: "60"
    };
    await runChecked("scripts/postgres-migrations.mjs", ["status"], {
      cwd: installedRoot,
      env: { ...common, APP_PROCESS_ROLE: "migration" }
    });
    await runChecked("checks/web-readiness.mjs", [], {
      cwd: installedRoot,
      env: { ...common, APP_PROCESS_ROLE: "web" }
    });
    const workerEnvironment = {
      ...common,
      APP_PROCESS_ROLE: "worker",
      WORKER_CONCURRENCY: "1",
      WORKER_POLL_INTERVAL_MS: "100",
      WORKER_PROGRESS_INTERVAL_MS: "250",
      WORKER_SHUTDOWN_GRACE_MS: "5000",
      WORKER_ATTEMPT_TIMEOUT_MS: "60000",
      JOB_LEASE_DURATION_MS: "15000",
      JOB_LEASE_RENEW_INTERVAL_MS: "1000",
      WORKER_CANCELLATION_POLL_INTERVAL_MS: "1000",
      JOB_RECOVERY_INTERVAL_MS: "5000",
      MAX_FILE_SIZE_MB: "5",
      MAX_VIDEO_DURATION_MINUTES: "1",
      DOWNLOAD_TIMEOUT_SECONDS: "10",
      FFPROBE_TIMEOUT_SECONDS: "10",
      FFMPEG_TIMEOUT_SECONDS: "10",
      FFMPEG_KILL_GRACE_SECONDS: "1",
      FFMPEG_THREADS: "1",
      FFMPEG_PATH: ffmpeg,
      FFPROBE_PATH: ffprobe
    };
    await runChecked("worker/main.mjs", ["--check"], { cwd: installedRoot, env: workerEnvironment });

    const port = await availablePort();
    if (!port) throw new Error("Web loopback port was not allocated.");
    const webOutput = { value: "" };
    const web = spawn(process.execPath, ["server.js"], {
      cwd: installedRoot,
      env: {
        ...common,
        // The disposable CI PostgreSQL service intentionally has no trusted TLS certificate.
        // Production fail-closed parsing is covered separately; this gate proves the installed
        // Linux standalone artifact boots and stops without depending on the source tree.
        NODE_ENV: "test",
        APP_PROCESS_ROLE: "web",
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
        TRUST_PROXY_MODE: "nginx-single-host",
        POSTGRES_SSL_MODE: "disable"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    web.stdout.on("data", (chunk) => { webOutput.value = `${webOutput.value}${chunk}`.slice(-16_384); });
    web.stderr.on("data", (chunk) => { webOutput.value = `${webOutput.value}${chunk}`.slice(-16_384); });
    try {
      const deadline = Date.now() + 30_000;
      let healthy = false;
      while (Date.now() < deadline) {
        if (web.exitCode !== null) throw new Error("Installed web exited during boot.");
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
            signal: AbortSignal.timeout(1_000)
          });
          if (response.ok) {
            healthy = true;
            break;
          }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (!healthy) throw new Error("Installed web health check timed out.");
      await stop(web, "Installed web");
    } finally {
      if (web.exitCode === null) web.kill("SIGKILL");
    }

    const workerOutput = { value: "" };
    const worker = spawn(process.execPath, ["worker/main.mjs"], {
      cwd: installedRoot,
      env: workerEnvironment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    worker.stdout.on("data", (chunk) => { workerOutput.value = `${workerOutput.value}${chunk}`.slice(-16_384); });
    worker.stderr.on("data", (chunk) => { workerOutput.value = `${workerOutput.value}${chunk}`.slice(-16_384); });
    try {
      await waitForOutput(worker, workerOutput, "worker.ready", 30_000);
      await stop(worker, "Installed worker", 15_000);
    } finally {
      if (worker.exitCode === null) worker.kill("SIGKILL");
    }
    console.info("Linux installed release and process signal validation passed.");
  } finally {
    await makeWritable(deploymentRoot);
    await Promise.all([
      rm(deploymentRoot, { recursive: true, force: true }),
      rm(volumeRoot, { recursive: true, force: true })
    ]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Linux installed release validation failed.");
  process.exitCode = 1;
});
