import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Release tooling is intentionally plain Node.js ESM.
import * as releaseContract from "../../scripts/release-contract.mjs";

const {
  APPROVED_NODE_VERSION,
  APPROVED_NPM_VERSION,
  RELEASE_CHECKSUMS_FILE,
  RELEASE_ENTRYPOINTS,
  RELEASE_MANIFEST_FILE,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  REQUIRED_MIGRATIONS,
  REQUIRED_RUNTIME_PACKAGES,
  assertReleaseToolchain,
  canonicalTreeHash,
  formatChecksums,
  hashReleaseFiles,
  stableJson,
  verifyReleaseRoot
} = releaseContract;

const roots = new Set<string>();

async function write(root: string, relative: string, value = relative): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value, { mode: 0o644 });
}

function isWebArtifact(relative: string): boolean {
  return relative === "server.js" ||
    relative === "package.json" ||
    relative.startsWith(".next/") ||
    relative.startsWith("node_modules/") ||
    relative.startsWith("public/");
}

async function createReleaseFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "videosave-release-contract-"));
  roots.add(root);
  await Promise.all([
    write(root, "server.js", "console.log('standalone');\n"),
    write(root, ".next/BUILD_ID", `${"a".repeat(40)}\n`),
    write(root, "package.json", stableJson({
      name: "videosave",
      version: "1.0.0",
      private: true,
      packageManager: `npm@${APPROVED_NPM_VERSION}`,
      engines: { node: APPROVED_NODE_VERSION, npm: APPROVED_NPM_VERSION },
      dependencies: { next: "16.2.10", pg: "8.22.0", react: "19.0.0", "react-dom": "19.0.0" }
    })),
    write(root, ".next/static/chunks/app.js", "console.log('client');\n"),
    write(root, "worker/main.mjs", "export {};\n"),
    write(root, "checks/web-readiness.mjs", "export {};\n"),
    write(root, "checks/cutover-readiness.mjs", "export {};\n"),
    write(root, "scripts/postgres-migrations.mjs", "export {};\n"),
    write(root, "scripts/operational-log.mjs", await readFile(
      path.join(process.cwd(), "scripts/operational-log.mjs"), "utf8"
    )),
    write(root, "scripts/postgres-migration-catalog.mjs", await readFile(
      path.join(process.cwd(), "scripts/postgres-migration-catalog.mjs"), "utf8"
    )),
    write(root, "smoke/production-smoke.mjs", "export {};\n"),
    write(root, "tools/verify-release.mjs", "export {};\n"),
    write(root, "tools/release-contract.mjs", "export {};\n")
  ]);
  await Promise.all(REQUIRED_RUNTIME_PACKAGES.map((name: string) =>
    write(root, `node_modules/${name}/package.json`, `${JSON.stringify({ name, version: "1.0.0" })}\n`)
  ));
  const migrations = [];
  for (const migration of REQUIRED_MIGRATIONS) {
    const sql = await readFile(path.join(process.cwd(), "db/migrations", migration.file), "utf8");
    await write(root, `db/migrations/${migration.file}`, sql);
  }
  const payload = await hashReleaseFiles(root);
  for (const migration of REQUIRED_MIGRATIONS) {
    const record = payload.find((candidate: { path: string }) =>
      candidate.path === `db/migrations/${migration.file}`
    );
    if (!record) throw new Error(`Missing migration fixture: ${migration.file}`);
    migrations.push({
      ...migration,
      sha256: record.sha256
    });
  }
  const worker = payload.find((record: { path: string }) => record.path === "worker/main.mjs");
  if (!worker) throw new Error("Missing worker fixture.");
  const manifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    application: { name: "videosave", version: "1.0.0" },
    artifacts: {
      webSha256: canonicalTreeHash(payload, (record: { path: string }) => isWebArtifact(record.path)),
      workerSha256: worker.sha256
    },
    build: {
      gitCommit: "a".repeat(40),
      gitTree: "b".repeat(40),
      nodeVersion: APPROVED_NODE_VERSION,
      npmVersion: APPROVED_NPM_VERSION,
      sourceDateEpoch: 1_700_000_000,
      timestamp: "2023-11-14T22:13:20.000Z",
      target: `${process.platform}-${process.arch}`,
      sourceTreeDirty: false
    },
    entrypoints: RELEASE_ENTRYPOINTS,
    migrations,
    runtimeAuthority: "postgres-durable",
    storageMarkerVersion: "v2"
  };
  await write(root, RELEASE_MANIFEST_FILE, stableJson(manifest));
  await write(root, RELEASE_CHECKSUMS_FILE, formatChecksums(await hashReleaseFiles(root)));
  return root;
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("release toolchain contract", () => {
  it("requires the approved exact Node.js and npm versions", () => {
    expect(() => assertReleaseToolchain({
      nodeVersion: APPROVED_NODE_VERSION,
      npmVersion: APPROVED_NPM_VERSION
    })).not.toThrow();
    expect(() => assertReleaseToolchain({ nodeVersion: "24.18.1", npmVersion: APPROVED_NPM_VERSION })).toThrow("Node.js");
    expect(() => assertReleaseToolchain({ nodeVersion: APPROVED_NODE_VERSION, npmVersion: "11.16.0" })).toThrow("npm 11.6.0");
  });

  it("serializes manifest data deterministically", () => {
    const left = stableJson({ z: 1, nested: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }] });
    const right = stableJson({ list: [{ x: 1, y: 2 }], nested: { a: 1, b: 2 }, z: 1 });
    expect(left).toBe(right);
  });
});

describe("strict release verification", () => {
  it("accepts a complete allowlisted release", async () => {
    const root = await createReleaseFixture();
    await expect(verifyReleaseRoot(root)).resolves.toMatchObject({
      manifest: { runtimeAuthority: "postgres-durable" }
    });
  });

  it("detects payload tampering after manifest generation", async () => {
    const root = await createReleaseFixture();
    await writeFile(path.join(root, "worker/main.mjs"), "tampered\n");
    await expect(verifyReleaseRoot(root)).rejects.toThrow("checksum mismatch");
  });

  it("binds the Next.js build ID to the release commit", async () => {
    const root = await createReleaseFixture();
    await write(root, ".next/BUILD_ID", `${"c".repeat(40)}\n`);
    const records = await hashReleaseFiles(root, { exclude: [RELEASE_CHECKSUMS_FILE] });
    await write(root, RELEASE_CHECKSUMS_FILE, formatChecksums(records));
    await expect(verifyReleaseRoot(root)).rejects.toThrow("build ID");
  });

  it("rejects an artifact built for another OS/architecture", async () => {
    const root = await createReleaseFixture();
    const manifest = JSON.parse(await readFile(path.join(root, RELEASE_MANIFEST_FILE), "utf8"));
    manifest.build.target = "unsupported-architecture";
    await write(root, RELEASE_MANIFEST_FILE, stableJson(manifest));
    const records = await hashReleaseFiles(root, { exclude: [RELEASE_CHECKSUMS_FILE] });
    await write(root, RELEASE_CHECKSUMS_FILE, formatChecksums(records));
    await expect(verifyReleaseRoot(root)).rejects.toThrow("target");
  });

  it.each([
    ["unexpected file", "checks/unexpected.txt", "unexpected"],
    ["environment file", ".env", "DATABASE_URL=secret"],
    ["source map", ".next/static/chunks/app.js.map", "{}"],
    ["test fixture", "public/fixtures/sample.txt", "fixture"],
    ["temporary media", "public/sample.mp4", "media"],
    ["PostgreSQL data", "public/pg_wal/000000010000000000000001", "data"],
    ["log", "checks/runtime.log", "log"],
    ["credential", "public/config.js", "postgresql://user:password@db.example/videosave"],
    ["local path", "checks/config.json", "{\"root\":\"/Users/example/project/\"}"]
  ])("rejects %s", async (_name, relative, content) => {
    const root = await createReleaseFixture();
    await write(root, relative, content);
    await expect(verifyReleaseRoot(root)).rejects.toThrow();
  });

  it("rejects symlinks instead of following an escape", async () => {
    const root = await createReleaseFixture();
    await symlink(path.join(os.tmpdir(), randomUUID()), path.join(root, "checks/escape"));
    await expect(verifyReleaseRoot(root)).rejects.toThrow("symlink");
  });

  it("rejects local file package dependencies", async () => {
    const root = await createReleaseFixture();
    await write(root, "package.json", `${JSON.stringify({
      name: "videosave-release",
      dependencies: { unsafe: "file:../unsafe" }
    })}\n`);
    await expect(verifyReleaseRoot(root)).rejects.toThrow("Local package dependency");
  });

  it("rejects source-only runtime package metadata", async () => {
    const root = await createReleaseFixture();
    const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    metadata.scripts = { test: "vitest" };
    metadata.devDependencies = { vitest: "4.1.10" };
    await write(root, "package.json", stableJson(metadata));
    const records = await hashReleaseFiles(root, { exclude: [RELEASE_CHECKSUMS_FILE] });
    await write(root, RELEASE_CHECKSUMS_FILE, formatChecksums(records));
    await expect(verifyReleaseRoot(root)).rejects.toThrow("runtime package metadata");
  });

  it("rejects executable payload files", async () => {
    const root = await createReleaseFixture();
    await chmod(path.join(root, "worker/main.mjs"), 0o755);
    await expect(verifyReleaseRoot(root)).rejects.toThrow("executable");
  });

  it("rejects server-only modules in client static assets", async () => {
    const root = await createReleaseFixture();
    await write(root, ".next/static/chunks/app.js", "createProductionMediaWorkerRuntime();\n");
    const records = await hashReleaseFiles(root, { exclude: [RELEASE_CHECKSUMS_FILE] });
    await write(root, RELEASE_CHECKSUMS_FILE, formatChecksums(records));
    await expect(verifyReleaseRoot(root)).rejects.toThrow("Server-only module leaked");
  });

  it("rejects a changed migration checksum", async () => {
    const root = await createReleaseFixture();
    await write(root, "db/migrations/001_create_media_jobs.sql", "SELECT 1;\n");
    await expect(verifyReleaseRoot(root)).rejects.toThrow();
  });
});
