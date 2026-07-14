import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializeCreateDownloadJobData, serializeMediaJobSnapshot } from "@/lib/api/media-job-serializer";
import { runNoEgressProductionSmoke } from "@/lib/smoke/production-smoke";
import { createProductionWebRuntime, type ProductionWebRuntime } from "@/lib/web/production-runtime";
import {
  provisionDurableVolumeTestRoot,
  TEST_DURABLE_VOLUME_AUTHORITY_ID
} from "@/tests/helpers/durable-volume";
import { applyMigrations } from "../../scripts/postgres-migrations.mjs";

const { Client } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required; production no-egress smoke was not executed.");

const schema = `videosave_production_smoke_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const quotedSchema = `"${schema}"`;
let bootstrap: InstanceType<typeof Client>;
let storageRoot: string;
let web: ProductionWebRuntime;
let server: ReturnType<typeof createServer>;
let baseUrl: string;

function environment(role: "web" | "worker") {
  return {
    APP_PROCESS_ROLE: role,
    JOB_REPOSITORY_BACKEND: "postgres",
    DATABASE_URL: testDatabaseUrl,
    POSTGRES_SSL_MODE: "disable",
    POSTGRES_POOL_MAX: role === "worker" ? "3" : "2",
    POSTGRES_CONNECTION_TIMEOUT_MS: "5000",
    POSTGRES_STATEMENT_TIMEOUT_MS: "10000",
    POSTGRES_QUERY_TIMEOUT_MS: "5000",
    POSTGRES_IDLE_TIMEOUT_MS: "1000",
    MEDIA_STORAGE_BACKEND: "durable-volume",
    MEDIA_STORAGE_ROOT: storageRoot,
    MEDIA_STORAGE_AUTHORITY_ID: TEST_DURABLE_VOLUME_AUTHORITY_ID,
    MEDIA_STORAGE_MAX_JOB_BYTES: "10485760",
    MEDIA_STORAGE_MAX_OUTPUT_BYTES: "5242880",
    MEDIA_FINAL_TTL_SECONDS: "60",
    MEDIA_STORAGE_LOW_DISK_BYTES: "1048576",
    MEDIA_CLEANUP_BATCH_SIZE: "20",
    JOB_ACTIVE_TTL_SECONDS: "300",
    WORKER_ID_PREFIX: "production-smoke",
    WORKER_CONCURRENCY: "1",
    WORKER_POLL_INTERVAL_MS: "100",
    WORKER_PROGRESS_INTERVAL_MS: "250",
    WORKER_SHUTDOWN_GRACE_MS: "2000",
    WORKER_ATTEMPT_TIMEOUT_MS: "60000",
    WORKER_METADATA_TIMEOUT_SECONDS: "5",
    WORKER_DB_LOSS_GRACE_MS: "1000",
    WORKER_CANCELLATION_POLL_INTERVAL_MS: "250",
    JOB_LEASE_DURATION_MS: "15000",
    JOB_LEASE_RENEW_INTERVAL_MS: "1000",
    JOB_RECOVERY_ENABLED: "true",
    JOB_RECOVERY_INTERVAL_MS: "5000",
    JOB_RECOVERY_BATCH_SIZE: "20",
    JOB_RETRY_BACKOFF_BASE_MS: "1000",
    JOB_RETRY_BACKOFF_MAX_MS: "5000",
    JOB_MAX_RETRIES: "1",
    MEDIA_RECONCILIATION_INTERVAL_MS: "5000",
    MEDIA_ORPHAN_GRACE_MS: "1000",
    JOB_EXPIRATION_BATCH_SIZE: "20",
    WORKER_ELECTION_RETRY_INTERVAL_MS: "1000",
    WORKER_STORAGE_HEALTH_INTERVAL_MS: "1000",
    JOB_EXPIRED_RETENTION_SECONDS: "60",
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
  } as const;
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > 8192) throw new Error("request too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store"
  });
  response.end(body);
}

async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/health") {
      json(response, 200, { ok: true, data: { status: "ok" } });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/download") {
      const created = await web.jobs.enqueueDownloadJob(await jsonBody(request) as never);
      json(response, 202, { ok: true, data: serializeCreateDownloadJobData(created.snapshot) });
      return;
    }
    const job = /^\/api\/jobs\/(job_[a-f0-9]{32})$/.exec(url.pathname);
    if (job && request.method === "GET") {
      json(response, 200, {
        ok: true,
        data: serializeMediaJobSnapshot(await web.jobs.getDownloadJob(job[1]))
      });
      return;
    }
    if (job && request.method === "DELETE") {
      json(response, 200, {
        ok: true,
        data: serializeMediaJobSnapshot(await web.jobs.cancelDownloadJob(job[1]))
      });
      return;
    }
    const file = /^\/api\/file\/(file_[a-f0-9]{32})$/.exec(url.pathname);
    if (file && request.method === "GET") {
      const delivered = await web.files.get(file[1]);
      if (!delivered) {
        json(response, 404, { ok: false, error: { code: "DOWNLOAD_FAILED" } });
        return;
      }
      response.writeHead(200, {
        "Content-Type": delivered.contentType,
        "Content-Length": String(delivered.sizeBytes),
        "Content-Disposition": `attachment; filename="${delivered.filename}"`,
        "Cache-Control": "private, max-age=0, no-store"
      });
      delivered.stream.pipe(response);
      response.once("close", () => { void delivered.close(); });
      return;
    }
    json(response, 404, { ok: false, error: { code: "NOT_FOUND" } });
  } catch {
    json(response, 500, { ok: false, error: { code: "INTERNAL_ERROR" } });
  }
}

beforeAll(async () => {
  bootstrap = new Client({
    connectionString: testDatabaseUrl,
    ssl: false,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: "videosave-production-smoke-bootstrap"
  });
  await bootstrap.connect();
  await bootstrap.query(`CREATE SCHEMA ${quotedSchema}`);
  await applyMigrations({ connectionString: testDatabaseUrl, sslMode: "disable", nodeEnv: "test", schema });
  await bootstrap.query("SELECT set_config('search_path', $1, false)", [schema]);
  storageRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "videosave-production-smoke-volume-")));
  await provisionDurableVolumeTestRoot(storageRoot, { createPublished: true });
  web = createProductionWebRuntime(environment("web"), { postgresSchema: schema });
  await web.readiness();
  server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Smoke fixture server did not bind.");
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await web?.close().catch(() => undefined);
  await bootstrap?.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => undefined);
  await bootstrap?.end().catch(() => undefined);
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

describe("production no-egress boundary smoke", () => {
  it("persists, claims, publishes, downloads and cancels without Internet egress", async () => {
    await expect(runNoEgressProductionSmoke({
      baseUrl,
      source: environment("worker"),
      postgresSchema: schema,
      timeoutMs: 60_000
    })).resolves.toBeUndefined();
    const state = await bootstrap.query(
      "SELECT status, count(*)::int AS count FROM media_jobs GROUP BY status ORDER BY status"
    );
    expect(state.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "ready" }),
      expect.objectContaining({ status: "cancelled" })
    ]));
  }, 70_000);
});
