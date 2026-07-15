import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Extractor } from "@/lib/extractors/types";
import { createConfiguredMediaProcessRunner } from "@/lib/ffmpeg/process-runner";
import { createProductionMediaWorkerRuntime, type ProductionMediaWorkerRuntime } from "@/lib/worker/composition";
import { applyMigrations } from "../../scripts/postgres-migrations.mjs";
import {
  provisionDurableVolumeTestRoot,
  TEST_DURABLE_VOLUME_AUTHORITY_ID
} from "@/tests/helpers/durable-volume";
import { createSafeMediaDiagnosticRunner } from "@/tests/helpers/media-process-diagnostic";

const runFile = promisify(execFile);
const { Client } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required; real-media worker smoke was not executed.");

const schema = `videosave_smoke_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const quotedSchema = `"${schema}"`;
let bootstrap: InstanceType<typeof Client>;
let temporaryRoot: string;
let storageRoot: string;
let fixturePath: string;
let runtime: ProductionMediaWorkerRuntime | null = null;
let mediaFailure = () => "none";

type SmokeProbe = Readonly<{
  format: Readonly<{ format_name?: string; duration?: string; size?: string }>;
  streams: readonly Readonly<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>[];
}>;

async function probeSmokeMedia(filename: string, stage: "fixture" | "output"): Promise<SmokeProbe> {
  try {
    const result = await runFile("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name,width,height",
      "-show_entries", "format=format_name,duration,size",
      "-of", "json",
      filename
    ], { timeout: 10_000, maxBuffer: 128 * 1024 });
    return JSON.parse(result.stdout) as SmokeProbe;
  } catch {
    throw new Error(`Worker smoke ${stage} probe failed.`);
  }
}

function assertSmokeMedia(
  metadata: SmokeProbe,
  expectedVideoCodec: string,
  expectedAudioCodec: string
): void {
  const videos = metadata.streams.filter((stream) => stream.codec_type === "video");
  const audios = metadata.streams.filter((stream) => stream.codec_type === "audio");
  if (
    !metadata.format.format_name?.split(",").includes("mp4") ||
    !Number.isFinite(Number(metadata.format.duration)) || Number(metadata.format.duration) <= 0 ||
    !Number.isSafeInteger(Number(metadata.format.size)) || Number(metadata.format.size) <= 0 ||
    videos.length !== 1 || videos[0].codec_name !== expectedVideoCodec ||
    audios.length !== 1 || audios[0].codec_name !== expectedAudioCodec
  ) {
    throw new Error("Worker smoke media contract failed.");
  }
}

async function waitForReady(jobId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await runtime?.repository.get(jobId);
    if (job?.status === "ready") return;
    if (job && ["failed", "cancelled", "expired"].includes(job.status)) {
      throw new Error(`Real-media worker ended in ${job.status}; media=${mediaFailure()}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for real-media worker.");
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-worker-smoke-"));
  storageRoot = path.join(temporaryRoot, "storage");
  fixturePath = path.join(temporaryRoot, "fixture.mp4");
  await mkdir(storageRoot);
  await provisionDurableVolumeTestRoot(storageRoot);
  try {
    await runFile("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-filter_threads", "1",
      "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
      "-t", "1", "-c:v", "mpeg4", "-q:v", "5", "-pix_fmt", "yuv420p", "-threads", "1",
      "-c:a", "aac", "-shortest",
      fixturePath
    ], { timeout: 20_000, maxBuffer: 128 * 1024 });
  } catch {
    throw new Error("Worker smoke fixture generation failed.");
  }
  const fixtureInfo = await lstat(fixturePath);
  if (!fixtureInfo.isFile() || fixtureInfo.isSymbolicLink() || fixtureInfo.size <= 0) {
    throw new Error("Worker smoke fixture is not a regular non-empty file.");
  }
  assertSmokeMedia(await probeSmokeMedia(fixturePath, "fixture"), "mpeg4", "aac");

  bootstrap = new Client({
    connectionString: testDatabaseUrl,
    ssl: false,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: "videosave-worker-smoke-bootstrap"
  });
  await bootstrap.connect();
  await bootstrap.query(`CREATE SCHEMA ${quotedSchema}`);
  await applyMigrations({ connectionString: testDatabaseUrl, sslMode: "disable", nodeEnv: "test", schema });
});

afterAll(async () => {
  await runtime?.close().catch(() => undefined);
  runtime = null;
  if (bootstrap) {
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => undefined);
    await bootstrap.end().catch(() => undefined);
  }
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

describe("real ffprobe/FFmpeg worker smoke", () => {
  it("transcodes a local fixture and publishes a probed compatible MP4", async () => {
    const diagnostic = createSafeMediaDiagnosticRunner(createConfiguredMediaProcessRunner({
      binaryPaths: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
      nodeEnv: "test",
      pathValue: process.env.PATH,
      killGraceMs: 1_000
    }));
    mediaFailure = diagnostic.failure;
    const extractor: Extractor = {
      id: "local-smoke-fixture",
      name: "Local smoke fixture",
      supports: () => true,
      async extract() {
        return {
          id: "smoke",
          originalUrl: "https://media.example.test/",
          title: "Smoke fixture",
          platform: "local-smoke",
          formats: [{ id: "smoke-mp4", label: "MP4 fixture", ext: "mp4", hasAudio: true, hasVideo: true }]
        };
      },
      async download(_url, _formatId, context) {
        const target = path.join(context.workDir, "source.mp4");
        await copyFile(fixturePath, target);
        const sizeBytes = (await import("node:fs/promises")).stat(target).then((info) => info.size);
        const size = await sizeBytes;
        context.onDownloadProgress?.(size, size);
        return { path: target, filename: "fixture.mp4", contentType: "video/mp4", sizeBytes: size };
      }
    };
    runtime = createProductionMediaWorkerRuntime({
      APP_PROCESS_ROLE: "worker",
      JOB_REPOSITORY_BACKEND: "postgres",
      DATABASE_URL: testDatabaseUrl,
      POSTGRES_SSL_MODE: "disable",
      POSTGRES_POOL_MAX: "3",
      POSTGRES_CONNECTION_TIMEOUT_MS: "5000",
      POSTGRES_STATEMENT_TIMEOUT_MS: "10000",
      POSTGRES_QUERY_TIMEOUT_MS: "3000",
      POSTGRES_IDLE_TIMEOUT_MS: "2000",
      MEDIA_STORAGE_BACKEND: "durable-volume",
      MEDIA_STORAGE_ROOT: storageRoot,
      MEDIA_STORAGE_AUTHORITY_ID: TEST_DURABLE_VOLUME_AUTHORITY_ID,
      MEDIA_STORAGE_MAX_JOB_BYTES: "10485760",
      MEDIA_STORAGE_MAX_OUTPUT_BYTES: "5242880",
      MEDIA_FINAL_TTL_SECONDS: "60",
      MEDIA_STORAGE_LOW_DISK_BYTES: "1048576",
      MEDIA_CLEANUP_BATCH_SIZE: "20",
      WORKER_ID_PREFIX: "smoke",
      WORKER_CONCURRENCY: "1",
      WORKER_POLL_INTERVAL_MS: "100",
      WORKER_PROGRESS_INTERVAL_MS: "250",
      WORKER_SHUTDOWN_GRACE_MS: "1000",
      WORKER_ATTEMPT_TIMEOUT_MS: "60000",
      JOB_LEASE_DURATION_MS: "15000",
      JOB_LEASE_RENEW_INTERVAL_MS: "1000",
      WORKER_CANCELLATION_POLL_INTERVAL_MS: "1000",
      JOB_RECOVERY_INTERVAL_MS: "5000",
      JOB_MAX_RETRIES: "1",
      MAX_FILE_SIZE_MB: "5",
      MAX_VIDEO_DURATION_MINUTES: "1",
      DOWNLOAD_TIMEOUT_SECONDS: "5",
      FFPROBE_TIMEOUT_SECONDS: "10",
      FFMPEG_TIMEOUT_SECONDS: "30",
      FFMPEG_KILL_GRACE_SECONDS: "1",
      FFMPEG_THREADS: "1",
      FFMPEG_PATH: "ffmpeg",
      FFPROBE_PATH: "ffprobe",
      NODE_ENV: "test"
    }, { postgresSchema: schema, getExtractor: () => extractor, runProcess: diagnostic.run });
    await runtime.readiness();
    const jobId = "job_real_media_smoke";
    await runtime.queue.enqueue({
      jobId,
      sourceUrl: "https://media.example.test/fixture.mp4",
      formatId: "smoke-mp4",
      processingPreset: "compatible-mp4"
    });
    const running = runtime.run();
    await waitForReady(jobId);
    const ready = await runtime.repository.get(jobId);
    const fileId = ready?.finalMetadata?.fileId;
    if (!fileId) throw new Error("Smoke job did not publish a final file.");
    const artifact = await runtime.artifacts.getPublicFinal(fileId);
    if (!artifact) throw new Error("Smoke artifact is not public.");
    const opened = await runtime.storage.open(artifact.storageKey, artifact.sizeBytes);
    const verificationPath = path.join(temporaryRoot, "verified-output.mp4");
    await pipeline(opened.stream, (await import("node:fs")).createWriteStream(verificationPath, { flags: "wx" }));
    await opened.close();
    const outputInfo = await lstat(verificationPath);
    expect(outputInfo.isFile()).toBe(true);
    expect(outputInfo.isSymbolicLink()).toBe(false);
    expect(outputInfo.size).toBeGreaterThan(0);
    expect(path.resolve(verificationPath)).not.toBe(path.resolve(fixturePath));
    assertSmokeMedia(await probeSmokeMedia(verificationPath, "output"), "h264", "aac");
    expect(ready).toMatchObject({ status: "ready", progress: 100, finalMetadata: { processingPreset: "compatible-mp4" } });
    await runtime.shutdown();
    await running;
  });
});
