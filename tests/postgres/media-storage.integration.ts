import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg, { type Pool } from "pg";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFileDeliveryRouteHandler } from "@/app/api/file/[id]/handler";
import type { ClaimedMediaJob, JobLeaseQueue } from "@/lib/jobs/job-lease-queue";
import { createPostgresJobLeaseQueue } from "@/lib/jobs/postgres/job-queue";
import { createPostgresMediaJobLifecycleMaintenance } from "@/lib/jobs/postgres/lifecycle-maintenance";
import { createPostgresJobRepository } from "@/lib/jobs/postgres/repository";
import type { JobRepository } from "@/lib/jobs/repository";
import type { MediaJobOutputMetadata } from "@/lib/jobs/types";
import { createDurableJobArtifactLifecycle } from "@/lib/storage/durable-job-artifacts";
import { createDurableVolumeStorage, type DurableVolumeStorage } from "@/lib/storage/durable-volume";
import { createDurableMediaFileDelivery } from "@/lib/storage/file-delivery";
import type { MediaArtifactRecord } from "@/lib/storage/media-artifact-repository";
import { createMediaArtifactId } from "@/lib/storage/media-storage";
import { createPostgresMediaArtifactRuntime, type PostgresMediaArtifactRuntime } from "@/lib/storage/postgres/artifact-repository";
import { createExplicitDurableMediaRuntime } from "@/lib/storage/postgres/factory";
import { createMediaStorageReconciler } from "@/lib/storage/reconciliation";
import { applyMigrations } from "../../scripts/postgres-migrations.mjs";
import {
  provisionDurableVolumeTestRoot,
  TEST_DURABLE_VOLUME_AUTHORITY_ID
} from "@/tests/helpers/durable-volume";

const { Client, Pool: PgPool } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required; durable storage integration tests were not executed.");

const schema = `videosave_storage_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const quotedSchema = `"${schema}"`;
const workerA = `worker_${"a".repeat(32)}`;
const workerB = `worker_${"b".repeat(32)}`;
const media: MediaJobOutputMetadata = Object.freeze({
  durationSeconds: 5,
  formatName: "mp4",
  hasVideo: true,
  hasAudio: true,
  width: 1280,
  height: 720,
  videoCodec: "h264",
  audioCodec: "aac"
});

let bootstrap: InstanceType<typeof Client>;
let pool: Pool;
let queue: JobLeaseQueue;
let jobs: JobRepository;
let postgresArtifacts: PostgresMediaArtifactRuntime;
let storageRoot: string | null = null;
let volume: DurableVolumeStorage;

function createVolume(root: string): DurableVolumeStorage {
  return createDurableVolumeStorage({
    root,
    maxJobBytes: 10 * 1024 * 1024,
    maxOutputBytes: 5 * 1024 * 1024,
    lowDiskBytes: 1024 * 1024
  });
}

async function claim(jobId: string, workerId = workerA): Promise<ClaimedMediaJob> {
  const enqueued = await queue.enqueue({
    jobId,
    sourceUrl: `https://example.com/media/${jobId}`,
    formatId: "video-1080p",
    processingPreset: "original"
  });
  if (enqueued.outcome !== "created") throw new Error("Expected job enqueue.");
  const result = await queue.claimNext(workerId);
  if (result.outcome !== "claimed") throw new Error("Expected job claim.");
  return result.job;
}

async function stagedLifecycle(jobId: string, workerId = workerA) {
  const claimed = await claim(jobId, workerId);
  const lifecycle = await createDurableJobArtifactLifecycle({
    lease: claimed.lease,
    sourceExtension: "mp4",
    outputExtension: "mp4",
    maxJobBytes: 10 * 1024 * 1024,
    maxOutputBytes: 5 * 1024 * 1024,
    finalTtlSeconds: 60,
    storage: volume.storage,
    artifacts: postgresArtifacts.artifacts,
    publication: postgresArtifacts.publication
  });
  await writeFile(lifecycle.workspace.stagedFinal.localPath, `final:${jobId}`);
  const staged = await lifecycle.stageFinal({ filename: `${jobId}.mp4`, contentType: "video/mp4" });
  if (staged.outcome !== "reserved" && staged.outcome !== "already-reserved") throw new Error("Expected staged artifact.");
  return { claimed, lifecycle, artifact: staged.artifact };
}

beforeAll(async () => {
  bootstrap = new Client({
    connectionString: testDatabaseUrl,
    ssl: false,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: "videosave-storage-bootstrap"
  });
  await bootstrap.connect();
  await bootstrap.query(`CREATE SCHEMA ${quotedSchema}`);
  await applyMigrations({ connectionString: testDatabaseUrl, sslMode: "disable", nodeEnv: "test", schema });
  pool = new PgPool({
    connectionString: testDatabaseUrl,
    ssl: false,
    max: 6,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 2_000,
    statement_timeout: 3_000,
    query_timeout: 4_000,
    options: `-c search_path=${schema}`,
    application_name: "videosave-storage-integration"
  });
  pool.on("error", () => undefined);
  queue = createPostgresJobLeaseQueue({ database: pool, leaseDurationMs: 15_000, maxRetries: 2, terminalTtlMs: 60_000 });
  jobs = createPostgresJobRepository({ database: pool, terminalTtlMs: 60_000 });
  postgresArtifacts = createPostgresMediaArtifactRuntime({ pool });
  await pool.query("SELECT 1");
});

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE media_artifacts, media_jobs");
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-pg-storage-"));
  volume = createVolume(storageRoot);
  await volume.storage.initialize();
});

afterEach(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  storageRoot = null;
});

afterAll(async () => {
  await pool?.end().catch(() => undefined);
  if (bootstrap) {
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => undefined);
    await bootstrap.end().catch(() => undefined);
  }
});

describe("PostgreSQL durable artifact registry and shared volume", () => {
  it("keeps explicit durable construction lazy until readiness", async () => {
    if (!storageRoot) throw new Error("Expected temporary storage root.");
    const explicitRoot = path.join(storageRoot, "explicit-root");
    const runtime = createExplicitDurableMediaRuntime({
      JOB_REPOSITORY_BACKEND: "postgres",
      DATABASE_URL: testDatabaseUrl,
      POSTGRES_SSL_MODE: "disable",
      POSTGRES_POOL_MAX: "2",
      POSTGRES_CONNECTION_TIMEOUT_MS: "5000",
      POSTGRES_STATEMENT_TIMEOUT_MS: "3000",
      POSTGRES_QUERY_TIMEOUT_MS: "4000",
      POSTGRES_IDLE_TIMEOUT_MS: "2000",
      NODE_ENV: "test",
      MEDIA_STORAGE_BACKEND: "durable-volume",
      MEDIA_STORAGE_ROOT: explicitRoot,
      MEDIA_STORAGE_AUTHORITY_ID: TEST_DURABLE_VOLUME_AUTHORITY_ID,
      MEDIA_STORAGE_MAX_JOB_BYTES: "2097152",
      MEDIA_STORAGE_MAX_OUTPUT_BYTES: "1048576",
      MEDIA_FINAL_TTL_SECONDS: "60",
      MEDIA_STORAGE_LOW_DISK_BYTES: "1048576",
      MEDIA_CLEANUP_BATCH_SIZE: "10"
    }, { postgresSchema: schema, reconciliationGraceMs: 0 });
    await expect(access(explicitRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(explicitRoot);
    await provisionDurableVolumeTestRoot(explicitRoot);
    await expect(runtime.readiness()).resolves.toBeUndefined();
    await runtime.close();
  });

  it("keeps staged metadata private and makes final public only after atomic DB completion", async () => {
    const { lifecycle, artifact } = await stagedLifecycle("job_publication_order");
    expect((await jobs.get(artifact.jobId))?.status).toBe("running");
    await expect(postgresArtifacts.artifacts.getPublicFinal(artifact.artifactId)).resolves.toBeNull();
    const completed = await lifecycle.publishReady(media);
    expect(completed).toMatchObject({
      outcome: "completed",
      artifact: { publicationState: "published", kind: "final" },
      record: { status: "ready", finalMetadata: { fileId: artifact.artifactId } }
    });
    await expect(postgresArtifacts.artifacts.getPublicFinal(artifact.artifactId)).resolves.toMatchObject({
      artifactId: artifact.artifactId,
      publicationState: "published"
    });
  });

  it("persists source/partial/final metadata without exposing private artifacts publicly", async () => {
    const claimed = await claim("job_private_artifacts");
    const lifecycle = await createDurableJobArtifactLifecycle({
      lease: claimed.lease,
      sourceExtension: "mp4",
      outputExtension: "mp4",
      maxJobBytes: 10 * 1024 * 1024,
      maxOutputBytes: 5 * 1024 * 1024,
      finalTtlSeconds: 60,
      storage: volume.storage,
      artifacts: postgresArtifacts.artifacts,
      publication: postgresArtifacts.publication
    });
    await writeFile(lifecycle.workspace.source.localPath, "source");
    const source = await lifecycle.registerSource({ filename: "../unsafe.mp4", contentType: "video/mp4" });
    expect(source).toMatchObject({ outcome: "reserved", artifact: { kind: "source", filename: "-unsafe.mp4" } });
    await writeFile(lifecycle.workspace.partial.localPath, "partial");
    const partial = await lifecycle.registerPartial({ filename: "partial.mp4", contentType: "video/mp4" });
    expect(partial).toMatchObject({ outcome: "reserved", artifact: { kind: "partial" } });
    await writeFile(lifecycle.workspace.stagedFinal.localPath, "final");
    const final = await lifecycle.stageFinal({ filename: "safe.mp4", contentType: "video/mp4" });
    if (source.outcome !== "reserved" || partial.outcome !== "reserved" || final.outcome !== "reserved") return;
    await expect(postgresArtifacts.artifacts.getPublicFinal(source.artifact.artifactId)).resolves.toBeNull();
    await expect(postgresArtifacts.artifacts.getPublicFinal(partial.artifact.artifactId)).resolves.toBeNull();
    expect(Object.isFrozen((await postgresArtifacts.artifacts.listForJob(claimed.record.jobId))[0])).toBe(true);
  });

  it("lets separate adapter instances and a restart simulation read one published object", async () => {
    const { lifecycle, artifact } = await stagedLifecycle("job_shared_restart");
    await expect(lifecycle.publishReady(media)).resolves.toMatchObject({ outcome: "completed" });
    const registered = await postgresArtifacts.artifacts.getPublicFinal(artifact.artifactId);
    if (!registered || !storageRoot) throw new Error("Expected published artifact.");
    const restarted = createVolume(storageRoot);
    await restarted.storage.initialize();
    const opened = await restarted.storage.open(registered.storageKey, registered.sizeBytes);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    await opened.close();
    expect(Buffer.concat(chunks).toString()).toBe("final:job_shared_restart");
  });

  it("makes concurrent duplicate publication idempotent and keeps one result", async () => {
    const { lifecycle, artifact } = await stagedLifecycle("job_concurrent_publish");
    const [first, second] = await Promise.all([lifecycle.publishReady(media), lifecycle.publishReady(media)]);
    expect([first.outcome, second.outcome].sort()).toEqual(["already-completed", "completed"]);
    expect((await postgresArtifacts.artifacts.listForJob(artifact.jobId)).filter((item) => item.publicationState === "published")).toHaveLength(1);
    expect((await jobs.get(artifact.jobId))?.status).toBe("ready");
  });

  it("rejects lost-lease publication before creating a public file", async () => {
    const { lifecycle, artifact } = await stagedLifecycle("job_lost_lease_publish");
    await pool.query(
      "UPDATE media_jobs SET lease_expires_at = statement_timestamp() - interval '1 second' WHERE job_id = $1",
      [artifact.jobId]
    );
    await expect(lifecycle.publishReady(media)).resolves.toEqual({ outcome: "ownership-lost" });
    expect(await volume.inventory.listPublished(10)).toEqual([]);
    expect((await postgresArtifacts.artifacts.get(artifact.artifactId))?.publicationState).toBe("staged");
  });

  it("fences cancellation/publication races and never exposes cancelled output", async () => {
    const { lifecycle, artifact } = await stagedLifecycle("job_cancel_publish_race");
    await Promise.all([
      queue.requestCancellation(artifact.jobId),
      lifecycle.publishReady(media)
    ]);
    const final = await jobs.get(artifact.jobId);
    expect(["ready", "cancelled"]).toContain(final?.status);
    if (final?.status === "cancelled") {
      await expect(postgresArtifacts.artifacts.getPublicFinal(artifact.artifactId)).resolves.toBeNull();
    }
    expect(final?.leaseOwner).toBeNull();
  });

  it("protects active attempts and removes stale attempt artifacts idempotently", async () => {
    const { lifecycle, artifact } = await stagedLifecycle("job_attempt_cleanup");
    const reconciler = createMediaStorageReconciler({
      artifacts: postgresArtifacts.artifacts,
      storage: volume.storage,
      inventory: volume.inventory,
      batchSize: 100,
      orphanGraceMs: 0,
      lifecycle: createPostgresMediaJobLifecycleMaintenance(pool)
    });
    const active = await reconciler.reconcile();
    expect(active.protectedActiveAttempts).toBeGreaterThan(0);
    expect(await volume.storage.stat(artifact.storageKey)).not.toBeNull();
    await queue.requestCancellation(artifact.jobId);
    await expect(reconciler.cleanupJobArtifacts(artifact.jobId)).resolves.toBeGreaterThan(0);
    await expect(reconciler.cleanupJobArtifacts(artifact.jobId)).resolves.toBe(0);
    await expect(volume.storage.stat(artifact.storageKey)).resolves.toBeNull();
    await expect(lifecycle.publishReady(media)).resolves.toMatchObject({ outcome: "ownership-lost" });
  });

  it("marks DB metadata missing when the physical file disappears", async () => {
    const { lifecycle, artifact } = await stagedLifecycle("job_missing_physical");
    const completed = await lifecycle.publishReady(media);
    if (completed.outcome !== "completed") throw new Error("Expected publication.");
    await volume.storage.remove(completed.artifact.storageKey);
    const reconciler = createMediaStorageReconciler({
      artifacts: postgresArtifacts.artifacts,
      storage: volume.storage,
      inventory: volume.inventory,
      batchSize: 100,
      orphanGraceMs: 0,
      lifecycle: createPostgresMediaJobLifecycleMaintenance(pool)
    });
    await expect(reconciler.reconcile()).resolves.toMatchObject({ missingArtifacts: 1 });
    expect((await postgresArtifacts.artifacts.get(artifact.artifactId))?.publicationState).toBe("missing");
    expect((await jobs.get(artifact.jobId))?.status).toBe("expired");
    await expect(postgresArtifacts.artifacts.getPublicFinal(artifact.artifactId)).resolves.toBeNull();
  });

  it("does not convert a durable-volume outage into missing metadata", async () => {
    const { lifecycle, artifact } = await stagedLifecycle("job_storage_outage");
    const completed = await lifecycle.publishReady(media);
    if (completed.outcome !== "completed") throw new Error("Expected publication.");
    const unavailableStorage = {
      ...volume.storage,
      stat: async () => { throw new Error("mount unavailable"); }
    };
    const reconciler = createMediaStorageReconciler({
      artifacts: postgresArtifacts.artifacts,
      storage: unavailableStorage,
      inventory: volume.inventory,
      batchSize: 100,
      orphanGraceMs: 0,
      lifecycle: createPostgresMediaJobLifecycleMaintenance(pool)
    });
    await expect(reconciler.reconcile()).rejects.toThrow("mount unavailable");
    expect(await postgresArtifacts.artifacts.get(artifact.artifactId)).toMatchObject({
      publicationState: "published"
    });
    expect((await jobs.get(artifact.jobId))?.status).toBe("ready");
  });

  it("fails an abandoned job safely when published metadata exists without ready", async () => {
    const { lifecycle, artifact } = await stagedLifecycle("job_dangling_published");
    const published = await volume.storage.publishImmutable({
      stagedKey: lifecycle.workspace.stagedFinal.key,
      fileId: artifact.artifactId,
      extension: "mp4",
      maximumBytes: 5 * 1024 * 1024
    });
    await pool.query(
      `UPDATE media_artifacts
       SET publication_state = 'published', storage_key = $2,
           published_at = statement_timestamp(), updated_at = statement_timestamp(),
           version = version + 1
       WHERE artifact_id = $1`,
      [artifact.artifactId, published.key]
    );
    await pool.query(
      `UPDATE media_jobs SET lease_expires_at = statement_timestamp() - interval '1 second'
       WHERE job_id = $1`,
      [artifact.jobId]
    );
    const reconciler = createMediaStorageReconciler({
      artifacts: postgresArtifacts.artifacts,
      storage: volume.storage,
      inventory: volume.inventory,
      batchSize: 100,
      orphanGraceMs: 0,
      lifecycle: createPostgresMediaJobLifecycleMaintenance(pool)
    });
    await reconciler.reconcile();
    expect(await jobs.get(artifact.jobId)).toMatchObject({
      status: "failed",
      canonicalError: { code: "PROCESSING_FAILED" }
    });
    expect(await postgresArtifacts.artifacts.get(artifact.artifactId)).toMatchObject({
      publicationState: "published"
    });
    expect(await volume.storage.stat(published.key)).not.toBeNull();
  });

  it("reconciles a staged DB reservation whose attempt file is missing", async () => {
    const { artifact } = await stagedLifecycle("job_staged_file_missing");
    await queue.requestCancellation(artifact.jobId);
    await volume.storage.remove(artifact.storageKey);
    const reconciler = createMediaStorageReconciler({
      artifacts: postgresArtifacts.artifacts,
      storage: volume.storage,
      inventory: volume.inventory,
      batchSize: 100,
      orphanGraceMs: 0
    });
    await expect(reconciler.reconcile()).resolves.toMatchObject({ missingArtifacts: 1 });
    await expect(postgresArtifacts.artifacts.get(artifact.artifactId)).resolves.toBeNull();
  });

  it("removes a physical orphan created when DB completion loses the lease", async () => {
    const { lifecycle, artifact } = await stagedLifecycle("job_physical_orphan");
    const published = await volume.storage.publishImmutable({
      stagedKey: lifecycle.workspace.stagedFinal.key,
      fileId: artifact.artifactId,
      extension: "mp4",
      maximumBytes: 5 * 1024 * 1024
    });
    await pool.query(
      "UPDATE media_jobs SET lease_expires_at = statement_timestamp() - interval '1 second' WHERE job_id = $1",
      [artifact.jobId]
    );
    await queue.recoverExpiredLeases();
    await expect(postgresArtifacts.publication.completeReadyOwned({
      lease: lifecycle.currentLease(),
      artifactId: artifact.artifactId,
      publishedObject: published,
      media
    })).resolves.toMatchObject({ outcome: "invalid-state", record: { status: "queued" } });
    const reconciler = createMediaStorageReconciler({
      artifacts: postgresArtifacts.artifacts,
      storage: volume.storage,
      inventory: volume.inventory,
      batchSize: 100,
      orphanGraceMs: 0
    });
    await reconciler.reconcile();
    await expect(volume.storage.stat(published.key)).resolves.toBeNull();
  });

  it("reconciles a file created before DB reservation after cancellation", async () => {
    const claimed = await claim("job_file_without_db");
    const workspace = await volume.storage.createAttemptWorkspace({
      jobId: claimed.record.jobId,
      attemptId: claimed.lease.attemptId,
      sourceExtension: "mp4",
      outputExtension: "mp4"
    });
    await writeFile(workspace.stagedFinal.localPath, "unregistered");
    await queue.requestCancellation(claimed.record.jobId);
    const reconciler = createMediaStorageReconciler({
      artifacts: postgresArtifacts.artifacts,
      storage: volume.storage,
      inventory: volume.inventory,
      batchSize: 100,
      orphanGraceMs: 0
    });
    await reconciler.reconcile();
    await expect(volume.storage.stat(workspace.stagedFinal.key)).resolves.toBeNull();
  });

  it("preserves the current file-route headers and errors through injected durable delivery", async () => {
    const { lifecycle, artifact } = await stagedLifecycle("job_injected_file_route");
    await lifecycle.publishReady(media);
    const delivery = createDurableMediaFileDelivery({ artifacts: postgresArtifacts.artifacts, storage: volume.storage });
    const handler = createFileDeliveryRouteHandler({ getFile: delivery.get });
    const response = await handler(
      new NextRequest(`http://localhost/api/file/${artifact.artifactId}`, { headers: { "x-test-client": randomUUID() } }),
      { params: Promise.resolve({ id: artifact.artifactId }) }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(`final:${artifact.jobId}`)));
    expect(response.headers.get("content-disposition")).toContain(`${artifact.jobId}.mp4`);
    expect(response.headers.get("cache-control")).toBe("private, max-age=0, no-store");
    expect(await response.text()).toBe(`final:${artifact.jobId}`);
    const privateResponse = await handler(
      new NextRequest("http://localhost/api/file/source_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      { params: Promise.resolve({ id: `source_${"a".repeat(32)}` }) }
    );
    expect(privateResponse.status).toBe(404);
  });

  it("uses parameters for artifact metadata and keeps the schema intact", async () => {
    const { lifecycle } = await stagedLifecycle("job_artifact_sql_parameter");
    const records = await postgresArtifacts.artifacts.listForJob("job_artifact_sql_parameter");
    expect(records).toHaveLength(1);
    await expect(pool.query("SELECT count(*) FROM media_artifacts")).resolves.toMatchObject({ rowCount: 1 });
    await lifecycle.cleanupAttempt();
  });

  it("rejects duplicate file IDs at the authoritative registry", async () => {
    const first = await stagedLifecycle("job_duplicate_file_a", workerA);
    const second = await claim("job_duplicate_file_b", workerB);
    const workspace = await volume.storage.createAttemptWorkspace({
      jobId: second.record.jobId,
      attemptId: second.lease.attemptId,
      sourceExtension: "mp4",
      outputExtension: "mp4"
    });
    await writeFile(workspace.stagedFinal.localPath, "other");
    const descriptor = await volume.storage.inspect(workspace.stagedFinal.key, 1024);
    await expect(postgresArtifacts.artifacts.reserveOwned(second.lease, {
      artifactId: first.artifact.artifactId,
      kind: "final",
      object: descriptor,
      filename: "other.mp4",
      contentType: "video/mp4",
      ttlSeconds: 60
    })).resolves.toMatchObject({ outcome: "invalid-state" });
  });

  it("expires published artifacts without deleting active leased attempts", async () => {
    const published = await stagedLifecycle("job_expired_final");
    const active = await stagedLifecycle("job_active_while_cleanup", workerB);
    const completion = await published.lifecycle.publishReady(media);
    if (completion.outcome !== "completed") throw new Error("Expected ready completion.");
    await pool.query(
      "UPDATE media_artifacts SET expires_at = statement_timestamp() WHERE artifact_id = $1",
      [published.artifact.artifactId]
    );
    const reconciler = createMediaStorageReconciler({
      artifacts: postgresArtifacts.artifacts,
      storage: volume.storage,
      inventory: volume.inventory,
      batchSize: 100,
      orphanGraceMs: 0
    });
    await reconciler.reconcile();
    await expect(postgresArtifacts.artifacts.get(published.artifact.artifactId)).resolves.toBeNull();
    await expect(volume.storage.stat(active.artifact.storageKey)).resolves.not.toBeNull();
  });
});
