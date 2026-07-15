import { execFile, spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
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
export const INSTALLED_WORKER_OBSERVABILITY_SCHEMA_VERSION = "1.0";
export const INSTALLED_WORKER_MAX_LINE_BYTES = 8 * 1024;
const MAX_CLOCK_SKEW_MS = 5_000;
const PROCESS_INSTANCE_ID = /^[a-f0-9]{32}$/;
const RELEASE_COMMIT = /^[a-f0-9]{40}$/;
const RELEASE_ID = /^videosave-[A-Za-z0-9][A-Za-z0-9._-]{0,63}-[a-f0-9]{12}$/;
const RAW_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const POSTGRES_SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
const INSTALLED_COMMAND_LABELS = new Set([
  "migration-apply",
  "migration-status",
  "web-readiness",
  "worker-readiness"
]);

function exactRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function parseInstalledWorkerReadyLine(line, options) {
  if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > INSTALLED_WORKER_MAX_LINE_BYTES || RAW_CONTROL.test(line)) {
    return null;
  }
  let record;
  try {
    record = exactRecord(JSON.parse(line));
  } catch {
    return null;
  }
  if (!record) return null;
  const timestamp = record.timestamp;
  const parsedTimestamp = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  const nowMs = (options.now ?? Date.now)();
  if (
    record.schemaVersion !== INSTALLED_WORKER_OBSERVABILITY_SCHEMA_VERSION ||
    record.event !== "process.ready" ||
    record.service !== "videosave" ||
    record.processRole !== "worker" ||
    record.level !== "info" ||
    record.outcome !== "success" ||
    record.reasonCode !== "none" ||
    typeof record.processInstanceId !== "string" ||
    !PROCESS_INSTANCE_ID.test(record.processInstanceId) ||
    typeof record.releaseCommit !== "string" ||
    !RELEASE_COMMIT.test(record.releaseCommit) ||
    record.releaseCommit !== options.expectedReleaseCommit ||
    typeof record.releaseId !== "string" ||
    !RELEASE_ID.test(record.releaseId) ||
    record.releaseId !== options.expectedReleaseId ||
    typeof timestamp !== "string" ||
    !Number.isFinite(parsedTimestamp) ||
    new Date(parsedTimestamp).toISOString() !== timestamp ||
    parsedTimestamp < options.startedAtMs ||
    parsedTimestamp > nowMs + MAX_CLOCK_SKEW_MS
  ) {
    return null;
  }
  return Object.freeze({ ...record });
}

export function waitForInstalledWorkerReady(options) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    return Promise.reject(new TypeError("Installed release readiness timeout is invalid."));
  }
  if (options.child.exitCode !== null) {
    return Promise.reject(new Error("Installed release worker exited before readiness."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let pending = Buffer.alloc(0);
    const decoder = new TextDecoder("utf-8", { fatal: true });

    const cleanup = () => {
      clearTimeout(timer);
      options.stdout.off("data", onData);
      options.stdout.off("end", onEnd);
      options.stdout.off("error", onStreamError);
      options.child.off("exit", onExit);
    };
    const finish = (error, record) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(record);
    };
    const invalidOutput = () => finish(new Error("Installed release worker readiness output is invalid."));
    const inspectLine = (bytes) => {
      if (bytes.length > INSTALLED_WORKER_MAX_LINE_BYTES) {
        invalidOutput();
        return;
      }
      let line;
      try {
        line = decoder.decode(bytes);
      } catch {
        invalidOutput();
        return;
      }
      const record = parseInstalledWorkerReadyLine(line, options);
      if (record) finish(null, record);
    };
    const onData = (value) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let offset = 0;
      while (!settled && offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline === -1 ? chunk.length : newline;
        const segment = chunk.subarray(offset, end);
        if (pending.length + segment.length > INSTALLED_WORKER_MAX_LINE_BYTES) {
          invalidOutput();
          return;
        }
        if (segment.length > 0) pending = Buffer.concat([pending, segment], pending.length + segment.length);
        if (newline === -1) return;
        const line = pending;
        pending = Buffer.alloc(0);
        inspectLine(line);
        offset = newline + 1;
      }
    };
    const onExit = () => finish(new Error("Installed release worker exited before readiness."));
    const onEnd = () => finish(new Error("Installed release worker stdout ended before readiness."));
    const onStreamError = () => invalidOutput();
    const timer = setTimeout(
      () => finish(new Error("Installed release process readiness timed out.")),
      timeoutMs
    );
    timer.unref?.();
    options.stdout.on("data", onData);
    options.stdout.once("end", onEnd);
    options.stdout.once("error", onStreamError);
    options.child.once("exit", onExit);
  });
}

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

export async function runChecked(label, entrypoint, args, options) {
  if (!INSTALLED_COMMAND_LABELS.has(label)) {
    throw new TypeError("Installed release command label is invalid.");
  }
  const execute = options.execute ?? run;
  try {
    await execute(process.execPath, [entrypoint, ...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? 30_000,
      maxBuffer: 512 * 1024
    });
  } catch {
    throw new Error(`Installed release command failed: ${label}.`);
  }
}

async function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Loopback test listener address is invalid."));
      else resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

export async function createPostgresTlsBridge(databaseUrl, root) {
  const upstreamUrl = new URL(databaseUrl);
  if (upstreamUrl.protocol !== "postgres:" && upstreamUrl.protocol !== "postgresql:") {
    throw new Error("Disposable PostgreSQL URL is invalid.");
  }
  if (upstreamUrl.hostname !== "127.0.0.1" && upstreamUrl.hostname !== "localhost") {
    throw new Error("Disposable PostgreSQL must use loopback for release validation.");
  }
  const upstreamPort = Number(upstreamUrl.port || "5432");
  if (!Number.isSafeInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65_535) {
    throw new Error("Disposable PostgreSQL port is invalid.");
  }
  const tlsRoot = path.join(root, ".postgres-tls-bridge");
  await mkdir(tlsRoot, { mode: 0o700 });
  const keyFile = path.join(tlsRoot, "server.key");
  const certificateFile = path.join(tlsRoot, "server.crt");
  const configFile = path.join(tlsRoot, "openssl.cnf");
  await writeFile(configFile, [
    "[req]",
    "distinguished_name=subject",
    "x509_extensions=extensions",
    "prompt=no",
    "[subject]",
    "CN=127.0.0.1",
    "[extensions]",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "basicConstraints=critical,CA:TRUE",
    "keyUsage=critical,keyCertSign,digitalSignature,keyEncipherment",
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  await run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
    "-keyout", keyFile, "-out", certificateFile, "-days", "1", "-config", configFile
  ], { maxBuffer: 64 * 1024 });
  await chmod(keyFile, 0o600);

  const sockets = new Set();
  const secureServer = createTlsServer({
    key: await readFile(keyFile),
    cert: await readFile(certificateFile),
    minVersion: "TLSv1.2"
  }, (secureSocket) => {
    sockets.add(secureSocket);
    secureSocket.once("close", () => sockets.delete(secureSocket));
    const upstream = connect({ host: upstreamUrl.hostname, port: upstreamPort });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    secureSocket.once("error", () => upstream.destroy());
    upstream.once("error", () => secureSocket.destroy());
    secureSocket.pipe(upstream).pipe(secureSocket);
  });
  secureServer.on("error", () => {
    for (const socket of sockets) socket.destroy();
  });
  const securePort = await listen(secureServer);

  const frontServer = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("error", () => socket.destroy());
    socket.once("data", (request) => {
      if (request.length !== POSTGRES_SSL_REQUEST.length || !request.equals(POSTGRES_SSL_REQUEST)) {
        socket.destroy();
        return;
      }
      const bridge = connect({ host: "127.0.0.1", port: securePort });
      sockets.add(bridge);
      bridge.once("close", () => sockets.delete(bridge));
      bridge.once("error", () => socket.destroy());
      bridge.once("connect", () => {
        socket.write("S");
        socket.pipe(bridge).pipe(socket);
      });
    });
  });
  frontServer.on("error", () => {
    for (const socket of sockets) socket.destroy();
  });
  const frontPort = await listen(frontServer);
  const bridgedUrl = new URL(databaseUrl);
  bridgedUrl.hostname = "127.0.0.1";
  bridgedUrl.port = String(frontPort);
  let closed = false;
  return Object.freeze({
    databaseUrl: bridgedUrl.toString(),
    certificateFile,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await Promise.all([closeServer(frontServer), closeServer(secureServer)]);
    }
  });
}

export async function validateInstalledReleaseReadiness(options) {
  const migrationEnvironment = { ...options.common, APP_PROCESS_ROLE: "migration" };
  await runChecked("migration-apply", "scripts/postgres-migrations.mjs", ["apply"], {
    cwd: options.installedRoot,
    env: migrationEnvironment,
    execute: options.execute
  });
  await runChecked("migration-status", "scripts/postgres-migrations.mjs", ["status"], {
    cwd: options.installedRoot,
    env: migrationEnvironment,
    execute: options.execute
  });
  await runChecked("web-readiness", "checks/web-readiness.mjs", [], {
    cwd: options.installedRoot,
    env: { ...options.common, APP_PROCESS_ROLE: "web" },
    execute: options.execute
  });
  await runChecked("worker-readiness", "worker/main.mjs", ["--check"], {
    cwd: options.installedRoot,
    env: options.workerEnvironment,
    execute: options.execute
  });
}

export async function stopInstalledProcess(child, label, timeoutMs = 15_000) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      child.kill("SIGKILL");
      reject(new Error(`${label} did not stop gracefully.`));
    }, timeoutMs);
    child.once("exit", onExit);
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
  let postgresTlsBridge;
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
    postgresTlsBridge = await createPostgresTlsBridge(databaseUrl, deploymentRoot);
    const workerObservabilityPort = await availablePort();
    if (!workerObservabilityPort) throw new Error("Worker observability loopback port was not allocated.");
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
    const workerEnvironment = {
      ...common,
      NODE_ENV: "production",
      APP_PROCESS_ROLE: "worker",
      DATABASE_URL: postgresTlsBridge.databaseUrl,
      POSTGRES_SSL_MODE: "require",
      NODE_EXTRA_CA_CERTS: postgresTlsBridge.certificateFile,
      OBSERVABILITY_ENABLED: "true",
      OBSERVABILITY_LOG_LEVEL: "info",
      WORKER_OBSERVABILITY_HOST: "127.0.0.1",
      WORKER_OBSERVABILITY_PORT: String(workerObservabilityPort),
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
    await validateInstalledReleaseReadiness({ installedRoot, common, workerEnvironment });

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
      await stopInstalledProcess(web, "Installed web");
    } finally {
      if (web.exitCode === null) web.kill("SIGKILL");
    }

    const workerStartedAt = Date.now();
    const worker = spawn(process.execPath, ["worker/main.mjs"], {
      cwd: installedRoot,
      env: workerEnvironment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    try {
      await waitForInstalledWorkerReady({
        child: worker,
        stdout: worker.stdout,
        expectedReleaseCommit: manifest.build.gitCommit,
        expectedReleaseId: installed.releaseId,
        startedAtMs: workerStartedAt,
        timeoutMs: 30_000
      });
      await stopInstalledProcess(worker, "Installed worker", 15_000);
      if (worker.exitCode !== 0 || worker.signalCode !== null) {
        throw new Error("Installed worker did not complete graceful SIGTERM shutdown.");
      }
    } finally {
      if (worker.exitCode === null) worker.kill("SIGKILL");
    }
    console.info("Linux installed release and process signal validation passed.");
  } finally {
    await postgresTlsBridge?.close().catch(() => undefined);
    await makeWritable(deploymentRoot);
    await Promise.all([
      rm(deploymentRoot, { recursive: true, force: true }),
      rm(volumeRoot, { recursive: true, force: true })
    ]);
  }
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Linux installed release validation failed.");
    process.exitCode = 1;
  });
}
