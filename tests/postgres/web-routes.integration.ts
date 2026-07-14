import { randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg, { type Pool } from "pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDownloadPostHandler } from "@/app/api/download/handler";
import { createFileDeliveryRouteHandler } from "@/app/api/file/[id]/handler";
import { createMediaJobRouteHandlers } from "@/app/api/jobs/[id]/handler";
import type { CreateDownloadJobRequest } from "@/lib/api/media-job-dto";
import { serializeMediaJobSnapshot } from "@/lib/api/media-job-serializer";
import type { MediaJobOutputMetadata } from "@/lib/jobs/types";
import { createDurableJobArtifactLifecycle } from "@/lib/storage/durable-job-artifacts";
import { createDurableVolumeStorage } from "@/lib/storage/durable-volume";
import { DURABLE_VOLUME_MARKER_FILENAME } from "@/lib/storage/durable-volume-marker";
import type { MediaArtifactRecord } from "@/lib/storage/media-artifact-repository";
import { createPostgresMediaArtifactRuntime } from "@/lib/storage/postgres/artifact-repository";
import type { RateLimitAllowed } from "@/lib/security/rate-limit";
import { API_ERROR_CODES } from "@/lib/types";
import {
  createProductionWebRuntime,
  type ProductionWebRuntime
} from "@/lib/web/production-runtime";
import { provisionDurableVolumeTestRoot } from "@/tests/helpers/durable-volume";
import { applyMigrations } from "../../scripts/postgres-migrations.mjs";

const { Client, Pool: PgPool } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required; persistent web routes were not tested.");
}

const schema = `videosave_web_routes_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const quotedSchema = `"${schema}"`;
const workerId = `worker_${"a".repeat(32)}`;
const media: MediaJobOutputMetadata = Object.freeze({
  durationSeconds: 1,
  formatName: "mp4",
  hasVideo: true,
  hasAudio: true,
  width: 16,
  height: 16,
  videoCodec: "h264",
  audioCodec: "aac"
});
const allowed: RateLimitAllowed = {
  ok: true,
  allowed: true,
  bucket: "download",
  key: "test",
  limit: 100,
  remaining: 99,
  resetAt: Date.now() + 60_000,
  retryAfterSeconds: 0
};

let bootstrap: InstanceType<typeof Client>;
let fixturePool: Pool;
let storageRoot: string;
let first: ProductionWebRuntime;
let second: ProductionWebRuntime;
let nextJob = 0;
let writeVolume: ReturnType<typeof createDurableVolumeStorage>;

function source(root = storageRoot, overrides: Record<string, string | undefined> = {}) {
  return {
    APP_PROCESS_ROLE: "web",
    JOB_REPOSITORY_BACKEND: "postgres",
    DATABASE_URL: testDatabaseUrl,
    POSTGRES_SSL_MODE: "disable",
    POSTGRES_POOL_MAX: "2",
    POSTGRES_CONNECTION_TIMEOUT_MS: "5000",
    POSTGRES_STATEMENT_TIMEOUT_MS: "5000",
    POSTGRES_QUERY_TIMEOUT_MS: "5000",
    POSTGRES_IDLE_TIMEOUT_MS: "1000",
    MEDIA_STORAGE_BACKEND: "durable-volume",
    MEDIA_STORAGE_ROOT: root,
    MEDIA_STORAGE_MAX_JOB_BYTES: "10485760",
    MEDIA_STORAGE_MAX_OUTPUT_BYTES: "5242880",
    MEDIA_FINAL_TTL_SECONDS: "60",
    MEDIA_STORAGE_LOW_DISK_BYTES: "1048576",
    MEDIA_CLEANUP_BATCH_SIZE: "20",
    JOB_LEASE_DURATION_MS: "15000",
    JOB_LEASE_RENEW_INTERVAL_MS: "5000",
    JOB_RECOVERY_INTERVAL_MS: "5000",
    JOB_MAX_RETRIES: "2",
    NODE_ENV: "test",
    ...overrides
  };
}

function nextId(prefix: string): string {
  nextJob += 1;
  return `job_${prefix}_${String(nextJob).padStart(4, "0")}`;
}

function requestBody(overrides: Partial<CreateDownloadJobRequest> = {}): CreateDownloadJobRequest {
  return {
    url: "https://public.example/media.mp4",
    formatId: "direct-source",
    processingPreset: "original",
    rightsConfirmed: true,
    ...overrides
  };
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function jobRequest(jobId: string, method: "GET" | "DELETE" = "GET"): NextRequest {
  return new NextRequest(`http://localhost/api/jobs/${jobId}`, { method });
}

function fileRequest(fileId: string): NextRequest {
  return new NextRequest(`http://localhost/api/file/${fileId}`);
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

function postHandler(runtime: ProductionWebRuntime) {
  return createDownloadPostHandler({
    enqueueDownloadJob: runtime.jobs.enqueueDownloadJob,
    checkRateLimit: () => allowed
  });
}

function jobHandlers(runtime: ProductionWebRuntime) {
  return createMediaJobRouteHandlers({
    getDownloadJob: runtime.jobs.getDownloadJob,
    cancelDownloadJob: runtime.jobs.cancelDownloadJob,
    serializeMediaJobSnapshot,
    checkRateLimit: () => allowed
  });
}

function fileHandler(runtime: ProductionWebRuntime) {
  return createFileDeliveryRouteHandler({
    getFile: runtime.files.get,
    checkRateLimit: () => allowed
  });
}

async function enqueue(runtime = first): Promise<string> {
  const created = await runtime.jobs.enqueueDownloadJob(requestBody());
  return created.jobId;
}

async function stageFinal(jobId: string, publish = true): Promise<{
  artifact: MediaArtifactRecord;
  absolutePath: string;
  sourceId: string;
  partialId: string;
}> {
  const claimed = await first.queue.claimNext(workerId);
  if (claimed.outcome !== "claimed" || claimed.job.record.jobId !== jobId) {
    throw new Error("Expected the requested persistent job claim.");
  }
  const lifecycle = await createDurableJobArtifactLifecycle({
    lease: claimed.job.lease,
    sourceExtension: "mp4",
    outputExtension: "mp4",
    maxJobBytes: 10 * 1024 * 1024,
    maxOutputBytes: 5 * 1024 * 1024,
    finalTtlSeconds: 60,
    storage: writeVolume.storage,
    artifacts: first.artifacts,
    publication: createPostgresMediaArtifactRuntime({ pool: fixturePool }).publication
  });
  await writeFile(lifecycle.workspace.source.localPath, `source:${jobId}`);
  const sourceArtifact = await lifecycle.registerSource({ filename: "source.mp4", contentType: "video/mp4" });
  if (sourceArtifact.outcome !== "reserved" && sourceArtifact.outcome !== "already-reserved") {
    throw new Error("Expected source reservation.");
  }
  await writeFile(lifecycle.workspace.partial.localPath, `partial:${jobId}`);
  const partialArtifact = await lifecycle.registerPartial({ filename: "partial.mp4", contentType: "video/mp4" });
  if (partialArtifact.outcome !== "reserved" && partialArtifact.outcome !== "already-reserved") {
    throw new Error("Expected partial reservation.");
  }
  await writeFile(lifecycle.workspace.stagedFinal.localPath, `final:${jobId}`);
  const staged = await lifecycle.stageFinal({ filename: "final.mp4", contentType: "video/mp4" });
  if (staged.outcome !== "reserved" && staged.outcome !== "already-reserved") {
    throw new Error("Expected final reservation.");
  }
  let artifact = staged.artifact;
  if (publish) {
    const completed = await lifecycle.publishReady(media);
    if (completed.outcome !== "completed" && completed.outcome !== "already-completed") {
      throw new Error("Expected ready publication.");
    }
    artifact = completed.artifact;
  }
  return {
    artifact,
    absolutePath: path.join(storageRoot, ...artifact.storageKey.split("/")),
    sourceId: sourceArtifact.artifact.artifactId,
    partialId: partialArtifact.artifact.artifactId
  };
}

beforeAll(async () => {
  bootstrap = new Client({
    connectionString: testDatabaseUrl,
    ssl: false,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: "videosave-web-routes-bootstrap"
  });
  await bootstrap.connect();
  await bootstrap.query(`CREATE SCHEMA ${quotedSchema}`);
  await applyMigrations({ connectionString: testDatabaseUrl, sslMode: "disable", nodeEnv: "test", schema });
  await bootstrap.query("SELECT set_config('search_path', $1, false)", [schema]);
  fixturePool = new PgPool({
    connectionString: testDatabaseUrl,
    ssl: false,
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 1_000,
    statement_timeout: 5_000,
    query_timeout: 5_000,
    options: `-c search_path=${schema}`,
    application_name: "videosave-web-route-fixture"
  });

  storageRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-web-routes-"));
  await provisionDurableVolumeTestRoot(storageRoot, { createPublished: true });
  writeVolume = createDurableVolumeStorage({
    root: storageRoot,
    maxJobBytes: 10 * 1024 * 1024,
    maxOutputBytes: 5 * 1024 * 1024,
    lowDiskBytes: 1024 * 1024
  });
  await writeVolume.storage.initialize();

  first = createProductionWebRuntime(source(), {
    postgresSchema: schema,
    createJobId: () => nextId("first")
  });
  second = createProductionWebRuntime(source(), {
    postgresSchema: schema,
    createJobId: () => nextId("second")
  });
  await Promise.all([first.readiness(), second.readiness()]);
});

beforeEach(async () => {
  await bootstrap.query("TRUNCATE TABLE media_artifacts, media_jobs");
});

afterAll(async () => {
  await Promise.all([first?.close(), second?.close()]);
  await fixturePool?.end().catch(() => undefined);
  await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
  await bootstrap.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => undefined);
  await bootstrap.end().catch(() => undefined);
});

describe("persistent production web routes", () => {
  it("POST atomically stores a queued job and private durable payload visible after restart", async () => {
    const response = await postHandler(first)(postRequest(requestBody()));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      data: { status: "queued", progress: 0, processingPreset: "original" }
    });
    expect(JSON.stringify(body)).not.toContain("sourceUrl");
    expect(JSON.stringify(body)).not.toContain("public.example");
    const jobId = body.data.jobId as string;
    const stored = await bootstrap.query(
      "SELECT status, source_url, format_id FROM media_jobs WHERE job_id = $1",
      [jobId]
    );
    expect(stored.rows[0]).toEqual({
      status: "queued",
      source_url: "https://public.example/media.mp4",
      format_id: "direct-source"
    });
    expect(await second.jobs.getDownloadJob(jobId)).toMatchObject({ jobId, status: "queued" });
    const webSessions = await bootstrap.query<{ count: number }>(
      `SELECT count(DISTINCT pid)::int AS count
       FROM pg_stat_activity
       WHERE application_name = 'videosave-web' AND datname = current_database()`
    );
    expect(webSessions.rows[0]?.count).toBeGreaterThanOrEqual(2);

    const restarted = createProductionWebRuntime(source(), { postgresSchema: schema });
    await restarted.readiness();
    await expect(restarted.jobs.getDownloadJob(jobId)).resolves.toMatchObject({ status: "queued" });
    await restarted.close();
  });

  it("POST preserves validation errors and never reports success after PostgreSQL failure", async () => {
    const invalid = await postHandler(first)(postRequest({ ...requestBody(), formatId: "../private" }));
    expect(invalid.status).toBe(422);
    await expect(invalid.json()).resolves.toMatchObject({
      ok: false,
      error: { code: API_ERROR_CODES.INVALID_FORMAT }
    });
    expect((await bootstrap.query("SELECT count(*)::int AS count FROM media_jobs")).rows[0]).toEqual({ count: 0 });

    const unavailable = createProductionWebRuntime(source(), {
      postgresSchema: schema,
      createJobId: () => nextId("closed")
    });
    await unavailable.readiness();
    await unavailable.close();
    const failed = await postHandler(unavailable)(postRequest(requestBody()));
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toMatchObject({
      ok: false,
      error: { code: API_ERROR_CODES.INTERNAL_ERROR }
    });
    expect((await bootstrap.query("SELECT count(*)::int AS count FROM media_jobs")).rows[0]).toEqual({ count: 0 });
  });

  it("GET serializes persistent queued, running, failed, cancelled, expired, and unknown states", async () => {
    const handlers = jobHandlers(second);
    const queuedId = await enqueue();
    const queued = await handlers.GET(jobRequest(queuedId), context(queuedId));
    await expect(queued.json()).resolves.toMatchObject({ ok: true, data: { status: "queued" } });

    const claimed = await first.queue.claimNext(workerId);
    if (claimed.outcome !== "claimed") throw new Error("Expected claim.");
    const progressed = await first.queue.updateProgressOwned(claimed.job.lease, 42);
    if (progressed.outcome !== "updated") throw new Error("Expected progress update.");
    const running = await handlers.GET(jobRequest(queuedId), context(queuedId));
    await expect(running.json()).resolves.toMatchObject({
      ok: true,
      data: { status: "running", progress: 42 }
    });
    await first.queue.completeOwned(progressed.lease, {
      type: "failed",
      errorCode: API_ERROR_CODES.PROCESSING_FAILED
    });
    const failed = await handlers.GET(jobRequest(queuedId), context(queuedId));
    await expect(failed.json()).resolves.toMatchObject({
      ok: true,
      data: { status: "failed", error: { code: API_ERROR_CODES.PROCESSING_FAILED } }
    });

    const cancelledId = await enqueue();
    await first.jobs.cancelDownloadJob(cancelledId);
    const cancelled = await handlers.GET(jobRequest(cancelledId), context(cancelledId));
    await expect(cancelled.json()).resolves.toMatchObject({ ok: true, data: { status: "cancelled" } });
    const record = await first.repository.get(cancelledId);
    if (!record) throw new Error("Expected cancelled record.");
    await first.repository.update(cancelledId, record.version, { type: "expire" });
    const expired = await handlers.GET(jobRequest(cancelledId), context(cancelledId));
    expect(expired.status).toBe(404);
    const unknown = await handlers.GET(jobRequest("job_unknown"), context("job_unknown"));
    expect(unknown.status).toBe(404);
  });

  it("DELETE is persistent and idempotent across immediate, claimed, repeated, race, and terminal states", async () => {
    const handlers = jobHandlers(second);
    const queuedId = await enqueue();
    const immediate = await handlers.DELETE(jobRequest(queuedId, "DELETE"), context(queuedId));
    await expect(immediate.json()).resolves.toMatchObject({ ok: true, data: { status: "cancelled" } });
    const repeated = await handlers.DELETE(jobRequest(queuedId, "DELETE"), context(queuedId));
    await expect(repeated.json()).resolves.toMatchObject({ ok: true, data: { status: "cancelled" } });
    expect((await first.repository.get(queuedId))?.cancellationRequestedAt).toEqual(expect.any(String));

    const runningId = await enqueue();
    const running = await first.queue.claimNext(workerId);
    if (running.outcome !== "claimed") throw new Error("Expected running claim.");
    const cancelledRunning = await handlers.DELETE(jobRequest(runningId, "DELETE"), context(runningId));
    await expect(cancelledRunning.json()).resolves.toMatchObject({ ok: true, data: { status: "cancelled" } });

    const raceId = await enqueue();
    const lockingClient = await fixturePool.connect();
    try {
      await lockingClient.query("BEGIN");
      await lockingClient.query("SELECT job_id FROM media_jobs WHERE job_id = $1 FOR UPDATE", [raceId]);
      const cancellation = second.jobs.cancelDownloadJob(raceId);
      await new Promise((resolve) => setTimeout(resolve, 25));
      await lockingClient.query(
        `UPDATE media_jobs
         SET status = 'running', started_at = clock_timestamp(),
             lease_owner = $2, lease_expires_at = clock_timestamp() + interval '15 seconds',
             lease_attempt_id = $3, available_at = NULL, version = version + 1
         WHERE job_id = $1`,
        [raceId, workerId, `attempt_${"c".repeat(32)}`]
      );
      await lockingClient.query("COMMIT");
      await expect(cancellation).resolves.toMatchObject({ status: "cancelled" });
    } finally {
      await lockingClient.query("ROLLBACK").catch(() => undefined);
      lockingClient.release();
    }
    expect((await first.repository.get(raceId))?.status).toBe("cancelled");

    const readyId = await enqueue();
    await stageFinal(readyId);
    const terminal = await handlers.DELETE(jobRequest(readyId, "DELETE"), context(readyId));
    await expect(terminal.json()).resolves.toMatchObject({ ok: true, data: { status: "ready" } });
  });

  it("delivers a published final through another web instance with unchanged headers", async () => {
    const jobId = await enqueue();
    const { artifact } = await stageFinal(jobId);
    const ready = await jobHandlers(second).GET(jobRequest(jobId), context(jobId));
    await expect(ready.json()).resolves.toMatchObject({
      ok: true,
      data: {
        status: "ready",
        result: { fileId: artifact.artifactId, downloadUrl: `/api/file/${artifact.artifactId}` }
      }
    });
    const response = await fileHandler(second)(fileRequest(artifact.artifactId), context(artifact.artifactId));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe(String(artifact.sizeBytes));
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="final.mp4"');
    expect(response.headers.get("cache-control")).toBe("private, max-age=0, no-store");
    expect(await response.text()).toBe(`final:${jobId}`);
  });

  it("rejects source/staged/expired/missing/symlinked files and never exposes storage keys", async () => {
    const privateJob = await enqueue();
    const privateArtifacts = await stageFinal(privateJob, false);
    for (const id of [
      privateArtifacts.sourceId,
      privateArtifacts.partialId,
      privateArtifacts.artifact.artifactId
    ]) {
      const response = await fileHandler(second)(fileRequest(id), context(id));
      expect(response.status).toBe(404);
      expect(JSON.stringify(await response.json())).not.toContain(storageRoot);
      expect(JSON.stringify(await fileHandler(second)(fileRequest(id), context(id)).then((value) => value.json())))
        .not.toContain("published/");
    }

    await bootstrap.query("TRUNCATE TABLE media_artifacts, media_jobs");
    const expiredJob = await enqueue();
    const expired = await stageFinal(expiredJob);
    await bootstrap.query(
      `UPDATE media_artifacts
       SET created_at = statement_timestamp() - interval '2 hours',
           updated_at = statement_timestamp() - interval '1 hour',
           published_at = statement_timestamp() - interval '1 hour',
           expires_at = statement_timestamp() - interval '1 second'
       WHERE artifact_id = $1`,
      [expired.artifact.artifactId]
    );
    expect((await fileHandler(second)(
      fileRequest(expired.artifact.artifactId),
      context(expired.artifact.artifactId)
    )).status).toBe(404);

    await bootstrap.query("TRUNCATE TABLE media_artifacts, media_jobs");
    const missingJob = await enqueue();
    const missing = await stageFinal(missingJob);
    await rm(missing.absolutePath);
    expect((await fileHandler(second)(
      fileRequest(missing.artifact.artifactId),
      context(missing.artifact.artifactId)
    )).status).toBe(404);

    await bootstrap.query("TRUNCATE TABLE media_artifacts, media_jobs");
    const symlinkJob = await enqueue();
    const linked = await stageFinal(symlinkJob);
    await rm(linked.absolutePath);
    await symlink(path.join(storageRoot, DURABLE_VOLUME_MARKER_FILENAME), linked.absolutePath);
    expect((await fileHandler(second)(
      fileRequest(linked.artifact.artifactId),
      context(linked.artifact.artifactId)
    )).status).toBe(404);

    const malformed = await fileHandler(second)(fileRequest("../secret"), context("../secret"));
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(await malformed.json())).not.toContain(storageRoot);
  });
});
