import "server-only";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Extractor } from "@/lib/extractors/types";
import type { ProductionMediaWorkerRuntime } from "@/lib/worker/composition";
import { createProductionMediaWorkerRuntime } from "@/lib/worker/composition";

const execFileAsync = promisify(execFile);
const CLIENT_ID_HEADER = "X-VideoSave-Client-IP";
const FIXED_CLIENT_ID = "127.0.0.1";
const LOCAL_SOURCE_ORIGIN = "https://videosave-smoke.invalid";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

export type ProductionSmokeOptions = Readonly<{
  baseUrl: string;
  source?: Readonly<Record<string, string | undefined>>;
  postgresSchema?: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}>;

export type ControlledEgressConfig = Readonly<{
  baseUrl: string;
  sourceUrl: string;
  allowedHostname: string;
  timeoutMs?: number;
  maxBytes?: number;
  workerConcurrency?: number;
  source?: Readonly<Record<string, string | undefined>>;
  postgresSchema?: string;
}>;

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > maximum) {
    throw new TypeError("Smoke limit is invalid.");
  }
  return parsed;
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Smoke base URL is invalid.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) throw new TypeError("Smoke base URL is invalid.");
  return url.origin;
}

export function validateControlledEgressConfig(input: ControlledEgressConfig) {
  const baseUrl = validateBaseUrl(input.baseUrl);
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(input.allowedHostname)) {
    throw new TypeError("Controlled-egress hostname allowlist is invalid.");
  }
  let source: URL;
  try {
    source = new URL(input.sourceUrl);
  } catch {
    throw new TypeError("Controlled-egress source URL is invalid.");
  }
  if (
    source.protocol !== "https:" ||
    source.hostname !== input.allowedHostname ||
    source.username ||
    source.password ||
    source.search ||
    source.hash ||
    source.port ||
    !/\.(?:mp4|mov|webm)$/i.test(source.pathname)
  ) throw new TypeError("Controlled-egress source URL violates the allowlist.");
  const maxBytes = boundedInteger(input.maxBytes, DEFAULT_MAX_BYTES, 100 * 1024 * 1024);
  if (maxBytes % (1024 * 1024) !== 0) {
    throw new TypeError("Controlled-egress byte limit must be whole MiB.");
  }
  if (input.workerConcurrency !== undefined && input.workerConcurrency !== 1) {
    throw new TypeError("Controlled-egress worker concurrency must be exactly one.");
  }
  return Object.freeze({
    baseUrl,
    sourceUrl: source.toString(),
    allowedHostname: input.allowedHostname,
    timeoutMs: boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 10 * 60_000),
    maxBytes,
    workerConcurrency: 1
  });
}

async function responseJson(response: Response): Promise<JsonObject> {
  const text = await response.text();
  if (text.length > 128 * 1024) throw new Error("Smoke response exceeded its safe bound.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Smoke response was not JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Smoke response shape was invalid.");
  }
  return value as JsonObject;
}

async function requestJson(
  fetcher: typeof fetch,
  url: string,
  timeoutMs: number,
  init: RequestInit = {}
): Promise<JsonObject> {
  const headers = new Headers(init.headers);
  headers.set(CLIENT_ID_HEADER, FIXED_CLIENT_ID);
  const response = await fetcher(url, {
    ...init,
    headers,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await responseJson(response);
  if (!response.ok || body.ok !== true) throw new Error("Smoke API request failed.");
  return body;
}

function responseData(body: JsonObject): JsonObject {
  const value = body.data;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Smoke API data was invalid.");
  }
  return value as JsonObject;
}

async function createJob(
  fetcher: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
  sourceUrl: string,
  formatId: string
): Promise<string> {
  const body = await requestJson(fetcher, `${baseUrl}/api/download`, timeoutMs, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: sourceUrl,
      formatId,
      processingPreset: "compatible-mp4",
      rightsConfirmed: true
    })
  });
  const data = responseData(body);
  if (typeof data.jobId !== "string" || !/^job_[a-f0-9]{32}$/.test(data.jobId)) {
    throw new Error("Smoke job identifier was invalid.");
  }
  return data.jobId;
}

async function getJob(fetcher: typeof fetch, baseUrl: string, timeoutMs: number, jobId: string) {
  return responseData(await requestJson(
    fetcher,
    `${baseUrl}/api/jobs/${encodeURIComponent(jobId)}`,
    timeoutMs,
    { method: "GET" }
  ));
}

async function cancelJob(fetcher: typeof fetch, baseUrl: string, timeoutMs: number, jobId: string) {
  return responseData(await requestJson(
    fetcher,
    `${baseUrl}/api/jobs/${encodeURIComponent(jobId)}`,
    timeoutMs,
    { method: "DELETE" }
  ));
}

async function waitForStatus(
  fetcher: typeof fetch,
  baseUrl: string,
  jobId: string,
  expected: ReadonlySet<string>,
  deadline: number
): Promise<JsonObject> {
  while (Date.now() < deadline) {
    const job = await getJob(fetcher, baseUrl, Math.min(5_000, Math.max(1_000, deadline - Date.now())), jobId);
    if (typeof job.status !== "string") throw new Error("Smoke job status was invalid.");
    if (expected.has(job.status)) return job;
    if (["failed", "cancelled", "expired"].includes(job.status)) {
      throw new Error("Smoke job reached an unexpected terminal state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Smoke polling timed out.");
}

async function verifyDownload(
  fetcher: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
  ready: JsonObject,
  maxBytes: number
) {
  const result = ready.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Smoke ready result was missing.");
  }
  const value = result as JsonObject;
  if (
    typeof value.downloadUrl !== "string" ||
    !/^\/api\/file\/file_[a-f0-9]{32}$/.test(value.downloadUrl) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) < 1 ||
    (value.sizeBytes as number) > maxBytes ||
    typeof value.mimeType !== "string" ||
    !value.mimeType.startsWith("video/")
  ) throw new Error("Smoke download metadata was invalid.");
  const response = await fetcher(`${baseUrl}${value.downloadUrl}`, {
    method: "GET",
    headers: { [CLIENT_ID_HEADER]: FIXED_CLIENT_ID },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok || response.headers.get("content-type") !== value.mimeType) {
    throw new Error("Smoke file response metadata was invalid.");
  }
  const length = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length !== value.sizeBytes) {
    throw new Error("Smoke file length was inconsistent.");
  }
  if (!response.body) throw new Error("Smoke file body was missing.");
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      received += chunk.byteLength;
      if (received > maxBytes || received > length) {
        await reader.cancel();
        throw new Error("Smoke file exceeded its declared bound.");
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (received !== length || received === 0) throw new Error("Smoke file body was incomplete.");
}

function localExtractor(fixturePath: string): Extractor {
  return {
    id: "production-no-egress-smoke",
    name: "Production no-egress smoke fixture",
    supports: (url) => url.origin === LOCAL_SOURCE_ORIGIN,
    async extract(url, context) {
      if (url.pathname === "/cancel.mp4") {
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new Error("Smoke cancellation observed."));
          if (context?.signal?.aborted) abort();
          else context?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return {
        id: "no-egress-smoke",
        originalUrl: `${LOCAL_SOURCE_ORIGIN}/`,
        title: "Controlled smoke fixture",
        platform: "operator-smoke",
        formats: [{
          id: "smoke-fixture",
          label: "Controlled MP4 fixture",
          ext: "mp4",
          hasAudio: true,
          hasVideo: true
        }]
      };
    },
    async download(_url, _formatId, context) {
      const target = path.join(context.workDir, "source.mp4");
      await copyFile(fixturePath, target);
      const info = await stat(target);
      context.onDownloadProgress?.(info.size, info.size);
      return {
        path: target,
        filename: "videosave-smoke.mp4",
        contentType: "video/mp4",
        sizeBytes: info.size
      };
    }
  };
}

async function createFixture(binary: string, directory: string): Promise<string> {
  const target = path.join(directory, "fixture.mp4");
  await execFileAsync(binary, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
    "-t", "1", "-c:v", "mpeg4", "-q:v", "5", "-c:a", "aac", "-shortest", target
  ], { timeout: 20_000, maxBuffer: 128 * 1024 });
  return target;
}

export async function runNoEgressProductionSmoke(options: ProductionSmokeOptions): Promise<void> {
  const baseUrl = validateBaseUrl(options.baseUrl);
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 10 * 60_000);
  const deadline = Date.now() + timeoutMs;
  const fetcher = options.fetchImplementation ?? fetch;
  const source = options.source ?? process.env;
  let runtime: ProductionMediaWorkerRuntime | null = null;
  let running: Promise<void> | null = null;
  let fixtureRoot: string | null = null;
  const jobIds: string[] = [];
  try {
    await requestJson(fetcher, `${baseUrl}/api/health`, 5_000, { method: "GET" });
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-production-smoke-"));
    runtime = createProductionMediaWorkerRuntime({
      ...source,
      WORKER_CONCURRENCY: "1",
      WORKER_ID_PREFIX: "smoke"
    }, {
      postgresSchema: options.postgresSchema,
      getExtractor: () => localExtractor(path.join(fixtureRoot as string, "fixture.mp4"))
    });
    await runtime.readiness();
    await createFixture(runtime.config.ffmpegPath, fixtureRoot);
    running = runtime.run();

    const readyJobId = await createJob(
      fetcher,
      baseUrl,
      5_000,
      `${LOCAL_SOURCE_ORIGIN}/ready.mp4`,
      "smoke-fixture"
    );
    jobIds.push(readyJobId);
    if (!(await runtime.repository.get(readyJobId))) {
      throw new Error("Smoke job was not persisted in PostgreSQL.");
    }
    const ready = await waitForStatus(fetcher, baseUrl, readyJobId, new Set(["ready"]), deadline);
    await verifyDownload(fetcher, baseUrl, 15_000, ready, DEFAULT_MAX_BYTES);
    const persistent = await getJob(fetcher, baseUrl, 5_000, readyJobId);
    if (persistent.status !== "ready") throw new Error("Smoke status was not persistent.");

    const cancelJobId = await createJob(
      fetcher,
      baseUrl,
      5_000,
      `${LOCAL_SOURCE_ORIGIN}/cancel.mp4`,
      "smoke-fixture"
    );
    jobIds.push(cancelJobId);
    await waitForStatus(fetcher, baseUrl, cancelJobId, new Set(["running"]), deadline);
    const cancelled = await cancelJob(fetcher, baseUrl, 5_000, cancelJobId);
    if (cancelled.status !== "cancelled") throw new Error("Smoke cancellation was not persisted.");
    const cancellationStatus = await getJob(fetcher, baseUrl, 5_000, cancelJobId);
    if (cancellationStatus.status !== "cancelled") throw new Error("Smoke cancellation was not durable.");
  } finally {
    for (const jobId of jobIds) await runtime?.queue.requestCancellation(jobId).catch(() => undefined);
    await runtime?.shutdown().catch(() => undefined);
    await running?.catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  }
}

export async function runControlledEgressSmoke(
  input: ControlledEgressConfig & Readonly<{
    fetchImplementation?: typeof fetch;
    createWorkerRuntime?: typeof createProductionMediaWorkerRuntime;
  }>
): Promise<void> {
  const config = validateControlledEgressConfig(input);
  const fetcher = input.fetchImplementation ?? fetch;
  const deadline = Date.now() + config.timeoutMs;
  const source = input.source ?? process.env;
  const totalSeconds = Math.max(1, Math.floor(config.timeoutMs / 1_000));
  const phaseSeconds = Math.max(1, Math.min(totalSeconds, 120));
  const attemptTimeoutMs = Math.max(60_000, config.timeoutMs + 10_000);
  const createWorker = input.createWorkerRuntime ?? createProductionMediaWorkerRuntime;
  let runtime: ProductionMediaWorkerRuntime | null = null;
  let running: Promise<void> | null = null;
  let jobId: string | null = null;
  try {
    runtime = createWorker({
      ...source,
      WORKER_CONCURRENCY: "1",
      WORKER_ID_PREFIX: "egress-smoke",
      MAX_FILE_SIZE_MB: String(config.maxBytes / (1024 * 1024)),
      DOWNLOAD_TIMEOUT_SECONDS: String(phaseSeconds),
      FFMPEG_TIMEOUT_SECONDS: String(phaseSeconds),
      WORKER_ATTEMPT_TIMEOUT_MS: String(attemptTimeoutMs)
    }, { postgresSchema: input.postgresSchema });
    await runtime.readiness();
    running = runtime.run();
    await requestJson(fetcher, `${config.baseUrl}/api/health`, 5_000, { method: "GET" });
    jobId = await createJob(fetcher, config.baseUrl, 5_000, config.sourceUrl, "direct-source");
    const ready = await waitForStatus(fetcher, config.baseUrl, jobId, new Set(["ready"]), deadline);
    await verifyDownload(fetcher, config.baseUrl, 15_000, ready, config.maxBytes);
  } finally {
    if (jobId) await cancelJob(fetcher, config.baseUrl, 5_000, jobId).catch(() => undefined);
    await runtime?.shutdown().catch(() => undefined);
    await running?.catch(() => undefined);
    await runtime?.close().catch(() => undefined);
  }
}

function argumentMap(argv: readonly string[]) {
  const [mode, ...rest] = argv;
  if (mode !== "--no-egress" && mode !== "--controlled-egress") {
    throw new TypeError("Smoke mode must be explicit.");
  }
  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (key === "--dry-run") {
      if (dryRun) throw new TypeError("Smoke arguments are invalid.");
      dryRun = true;
      continue;
    }
    if (!new Set(["--base-url", "--source-url", "--allowed-host", "--timeout-ms", "--max-bytes"]).has(key)) {
      throw new TypeError("Smoke arguments are invalid.");
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--") || values.has(key)) throw new TypeError("Smoke arguments are invalid.");
    values.set(key, value);
    index += 1;
  }
  if (!values.has("--base-url")) throw new TypeError("Smoke base URL must be explicit.");
  return { mode, values, dryRun } as const;
}

async function main(): Promise<void> {
  const { mode, values, dryRun } = argumentMap(process.argv.slice(2));
  const timeoutMs = values.has("--timeout-ms") ? Number(values.get("--timeout-ms")) : undefined;
  if (mode === "--no-egress") {
    if (dryRun || values.has("--source-url") || values.has("--allowed-host") || values.has("--max-bytes")) {
      throw new TypeError("No-egress smoke arguments are invalid.");
    }
    await runNoEgressProductionSmoke({
      baseUrl: values.get("--base-url") as string,
      timeoutMs
    });
    console.info("Production no-egress smoke passed.");
    return;
  }
  if (!values.has("--source-url") || !values.has("--allowed-host")) {
    throw new TypeError("Controlled-egress source and allowlist must be explicit.");
  }
  const config = {
    baseUrl: values.get("--base-url") as string,
    sourceUrl: values.get("--source-url") as string,
    allowedHostname: values.get("--allowed-host") as string,
    timeoutMs,
    maxBytes: values.has("--max-bytes") ? Number(values.get("--max-bytes")) : undefined
  };
  validateControlledEgressConfig(config);
  if (dryRun) {
    console.info("Controlled-egress smoke configuration passed.");
    return;
  }
  await runControlledEgressSmoke(config);
  console.info("Controlled-egress smoke passed.");
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  void main().catch(() => {
    console.error("Production smoke failed.");
    process.exitCode = 1;
  });
}
