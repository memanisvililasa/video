import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import type { Extractor } from "@/lib/extractors/types";
import type { MediaProcessResult, MediaProcessRunner } from "@/lib/ffmpeg/types";
import { createDurableMediaFileDelivery } from "@/lib/storage/file-delivery";
import { API_ERROR_CODES } from "@/lib/types";
import { createProductionMediaWorkerRuntime, type ProductionMediaWorkerRuntime } from "@/lib/worker/composition";
import type { MediaWorkerProcessor } from "@/lib/worker/processor";
import { createProcessObservability, type ProcessObservability } from "@/lib/observability/runtime";
import { applyMigrations } from "../../scripts/postgres-migrations.mjs";
import {
  provisionDurableVolumeTestRoot,
  TEST_DURABLE_VOLUME_AUTHORITY_ID
} from "@/tests/helpers/durable-volume";

const { Client } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required; media worker integration tests were not executed.");

const schema = `videosave_worker_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const quotedSchema = `"${schema}"`;
let bootstrap: InstanceType<typeof Client>;
let storageRoot: string | null = null;
let runtime: ProductionMediaWorkerRuntime | null = null;
let observability: ProcessObservability | null = null;
let operationalRecords: Array<Record<string, unknown>> = [];

const probeOutput = JSON.stringify({
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264", width: 16, height: 16, duration: "1" },
    { index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, duration: "1" }
  ],
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "1", size: "12" }
});

const fakeProcessRunner: MediaProcessRunner = async (): Promise<MediaProcessResult> => ({
  exitCode: 0,
  signal: null,
  stdout: probeOutput,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 1
});

const fakeExtractor: Extractor = {
  id: "worker-fixture",
  name: "Worker fixture",
  supports: () => true,
  async extract() {
    return {
      id: "fixture",
      originalUrl: "https://media.example.test/",
      title: "Fixture",
      platform: "fixture",
      formats: [{ id: "fixture-mp4", label: "fixture", ext: "mp4", hasAudio: true, hasVideo: true }]
    };
  },
  async download(_url, _formatId, context) {
    const target = path.join(context.workDir, "source.mp4");
    const bytes = Buffer.from("fixture-media");
    await writeFile(target, bytes);
    context.onDownloadProgress?.(bytes.length, bytes.length);
    return { path: target, filename: "fixture.mp4", contentType: "video/mp4", sizeBytes: bytes.length };
  }
};

function environment(root: string) {
  return {
    APP_PROCESS_ROLE: "worker",
    JOB_REPOSITORY_BACKEND: "postgres",
    DATABASE_URL: testDatabaseUrl,
    POSTGRES_SSL_MODE: "disable",
    POSTGRES_POOL_MAX: "3",
    POSTGRES_CONNECTION_TIMEOUT_MS: "5000",
    POSTGRES_STATEMENT_TIMEOUT_MS: "5000",
    POSTGRES_QUERY_TIMEOUT_MS: "5000",
    POSTGRES_IDLE_TIMEOUT_MS: "2000",
    MEDIA_STORAGE_BACKEND: "durable-volume",
    MEDIA_STORAGE_ROOT: root,
    MEDIA_STORAGE_AUTHORITY_ID: TEST_DURABLE_VOLUME_AUTHORITY_ID,
    MEDIA_STORAGE_MAX_JOB_BYTES: "2097152",
    MEDIA_STORAGE_MAX_OUTPUT_BYTES: "1048576",
    MEDIA_FINAL_TTL_SECONDS: "60",
    MEDIA_STORAGE_LOW_DISK_BYTES: "1048576",
    MEDIA_CLEANUP_BATCH_SIZE: "20",
    WORKER_ID_PREFIX: "integration",
    WORKER_CONCURRENCY: "1",
    WORKER_POLL_INTERVAL_MS: "100",
    WORKER_PROGRESS_INTERVAL_MS: "250",
    WORKER_SHUTDOWN_GRACE_MS: "1000",
    WORKER_ATTEMPT_TIMEOUT_MS: "60000",
    JOB_LEASE_DURATION_MS: "15000",
    JOB_LEASE_RENEW_INTERVAL_MS: "1000",
    WORKER_CANCELLATION_POLL_INTERVAL_MS: "1000",
    JOB_RECOVERY_INTERVAL_MS: "5000",
    JOB_MAX_RETRIES: "2",
    MAX_FILE_SIZE_MB: "1",
    MAX_VIDEO_DURATION_MINUTES: "1",
    DOWNLOAD_TIMEOUT_SECONDS: "1",
    FFPROBE_TIMEOUT_SECONDS: "1",
    FFMPEG_TIMEOUT_SECONDS: "1",
    FFMPEG_KILL_GRACE_SECONDS: "1",
    FFMPEG_THREADS: "1",
    NODE_ENV: "test"
  } as const;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for worker integration state.");
}

async function enqueue(jobId: string): Promise<void> {
  if (!runtime) throw new Error("Worker runtime is missing.");
  const result = await runtime.queue.enqueue({
    jobId,
    sourceUrl: "https://media.example.test/fixture.mp4",
    formatId: "fixture-mp4",
    processingPreset: "original"
  });
  if (result.outcome !== "created") throw new Error("Expected durable job creation.");
}

async function createRuntime(processor?: MediaWorkerProcessor): Promise<ProductionMediaWorkerRuntime> {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-worker-integration-"));
  await provisionDurableVolumeTestRoot(storageRoot);
  operationalRecords = [];
  observability = await createProcessObservability(environment(storageRoot), "worker", {
    metadata: { processInstanceId: () => "6".repeat(32) },
    logger: { sink: (record) => { operationalRecords.push(record as Record<string, unknown>); } }
  });
  runtime = createProductionMediaWorkerRuntime(environment(storageRoot), {
    postgresSchema: schema,
    runProcess: fakeProcessRunner,
    getExtractor: () => fakeExtractor,
    observability,
    ...(processor ? { processor } : {})
  });
  await runtime.readiness();
  return runtime;
}

beforeAll(async () => {
  bootstrap = new Client({
    connectionString: testDatabaseUrl,
    ssl: false,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: "videosave-worker-bootstrap"
  });
  await bootstrap.connect();
  await bootstrap.query(`CREATE SCHEMA ${quotedSchema}`);
  await applyMigrations({ connectionString: testDatabaseUrl, sslMode: "disable", nodeEnv: "test", schema });
  await bootstrap.query("SELECT set_config('search_path', $1, false)", [schema]);
});

beforeEach(async () => {
  await bootstrap.query("TRUNCATE TABLE media_artifacts, media_jobs");
});

afterEach(async () => {
  await runtime?.close().catch(() => undefined);
  runtime = null;
  observability?.close();
  observability = null;
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  storageRoot = null;
});

afterAll(async () => {
  await bootstrap.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => undefined);
  await bootstrap.end().catch(() => undefined);
});

describe("standalone media worker with PostgreSQL and durable volume", () => {
  it("fails readiness when the configured FFmpeg executable is missing", async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-worker-integration-"));
    await provisionDurableVolumeTestRoot(storageRoot);
    runtime = createProductionMediaWorkerRuntime({
      ...environment(storageRoot),
      FFMPEG_PATH: path.join(storageRoot, "missing-ffmpeg")
    }, {
      postgresSchema: schema,
      runProcess: fakeProcessRunner,
      getExtractor: () => fakeExtractor
    });
    await expect(runtime.readiness()).rejects.toBeDefined();
  });

  it("uses the exact shared migration checksum contract", async () => {
    const original = await bootstrap.query(
      "SELECT checksum FROM _videosave_migrations WHERE version = '004'"
    );
    await bootstrap.query(
      "UPDATE _videosave_migrations SET checksum = $1 WHERE version = '004'",
      ["0".repeat(64)]
    );
    try {
      await expect(createRuntime()).rejects.toThrow("not compatible");
    } finally {
      await bootstrap.query(
        "UPDATE _videosave_migrations SET checksum = $1 WHERE version = '004'",
        [original.rows[0].checksum]
      );
    }
  });

  it("claims, processes, publishes and exposes a ready final across adapter instances", async () => {
    const current = await createRuntime();
    await enqueue("job_worker_ready");
    const running = current.run();
    await waitFor(async () => (await current.repository.get("job_worker_ready"))?.status === "ready");
    const job = await current.repository.get("job_worker_ready");
    expect(job).toMatchObject({ status: "ready", progress: 100, leaseOwner: null });
    await observability?.collectMetrics();
    const metrics = observability?.metrics.registry.render() ?? "";
    expect(metrics).toContain('jobs_submitted_total{preset="original"} 1');
    expect(metrics).toContain('jobs_completed_total{preset="original"} 1');
    expect(metrics).toContain("queue_depth 0");
    expect(metrics).toContain("running_jobs 0");
    expect(metrics).toContain("storage_up 1");
    expect(metrics).not.toContain("job_worker_ready");
    expect(operationalRecords.map((record) => record.event)).toEqual(expect.arrayContaining([
      "job.queued",
      "job.claimed",
      "download.started",
      "download.completed",
      "probe.started",
      "artifact.staged",
      "artifact.published",
      "job.completed"
    ]));
    expect(JSON.stringify(operationalRecords)).not.toContain("https://media.example.test");
    const fileId = job?.finalMetadata?.fileId;
    if (!fileId) throw new Error("Expected final file ID.");
    const delivery = createDurableMediaFileDelivery({ artifacts: current.artifacts, storage: current.storage });
    const delivered = await delivery.get(fileId);
    expect(delivered).toMatchObject({ filename: "fixture.mp4", sizeBytes: 13, contentType: "video/mp4" });
    await delivered?.close();
    await current.shutdown();
    await running;
  });

  it("observes persistent cancellation and aborts an active processor", async () => {
    let observedAbort = false;
    const processor: MediaWorkerProcessor = {
      async process({ session }) {
        await new Promise<void>((resolve) => {
          session.signal.addEventListener("abort", () => { observedAbort = true; resolve(); }, { once: true });
        });
        throw new Error("aborted");
      }
    };
    const current = await createRuntime(processor);
    await enqueue("job_worker_cancel");
    const running = current.run();
    await waitFor(async () => (await current.repository.get("job_worker_cancel"))?.status === "running");
    await current.queue.requestCancellation("job_worker_cancel");
    await waitFor(async () => observedAbort, 3_000);
    expect((await current.repository.get("job_worker_cancel"))?.status).toBe("cancelled");
    expect(operationalRecords.map((record) => record.event)).toContain("job.cancelled");
    await current.shutdown();
    await running;
  });

  it("automatically recovers a crashed/retryable attempt and increments retryCount", async () => {
    const processor: MediaWorkerProcessor = {
      async process() { throw new AppError(API_ERROR_CODES.EXTRACTION_FAILED); }
    };
    const current = await createRuntime(processor);
    await enqueue("job_worker_retry");
    const running = current.run();
    await waitFor(async () => current.worker.status().activeJobs === 0 && (await current.repository.get("job_worker_retry"))?.status === "running");
    await bootstrap.query(
      "UPDATE media_jobs SET lease_expires_at = statement_timestamp() - interval '1 second' WHERE job_id = $1",
      ["job_worker_retry"]
    );
    await waitFor(async () => (await current.repository.get("job_worker_retry"))?.status === "queued", 8_000);
    expect(await current.repository.get("job_worker_retry")).toMatchObject({ status: "queued", retryCount: 1 });
    expect(current.lifecycle.status().lastSuccessfulRecoveryAt).not.toBeNull();
    expect(operationalRecords.map((record) => record.event)).toEqual(expect.arrayContaining([
      "job.retry_scheduled", "recovery.started", "recovery.completed"
    ]));
    await current.shutdown();
    await running;
  });

  it("persists a safe canonical terminal failure while owned", async () => {
    const processor: MediaWorkerProcessor = {
      async process() { throw new AppError(API_ERROR_CODES.INVALID_MEDIA_FILE); }
    };
    const current = await createRuntime(processor);
    await enqueue("job_worker_terminal");
    const running = current.run();
    await waitFor(async () => (await current.repository.get("job_worker_terminal"))?.status === "failed");
    expect(await current.repository.get("job_worker_terminal")).toMatchObject({
      canonicalError: { code: API_ERROR_CODES.INVALID_MEDIA_FILE }
    });
    expect(operationalRecords.map((record) => record.event)).toContain("job.failed");
    await current.shutdown();
    await running;
  });
});
