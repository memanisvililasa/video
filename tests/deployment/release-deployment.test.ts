import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Release tooling is intentionally plain Node.js ESM.
import * as contract from "../../scripts/release-contract.mjs";
// @ts-expect-error Deployment tooling is intentionally plain Node.js ESM.
import * as deployment from "../../scripts/release-deployment.mjs";

const roots = new Set<string>();
const TAR_BLOCK = 512;

async function temporary(prefix: string): Promise<string> {
  const value = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.add(value);
  return value;
}

async function write(root: string, relative: string, value = relative): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value, { mode: 0o644 });
}

function webArtifact(relative: string): boolean {
  return relative === "server.js" ||
    relative === "package.json" ||
    relative.startsWith(".next/") ||
    relative.startsWith("node_modules/") ||
    relative.startsWith("public/");
}

function stringField(buffer: Buffer, offset: number, length: number, value: string): void {
  Buffer.from(value).copy(buffer, offset, 0, length);
}

function octalField(buffer: Buffer, offset: number, length: number, value: number): void {
  stringField(buffer, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function tarHeader(relative: string, size: number, type = "0"): Buffer {
  const header = Buffer.alloc(TAR_BLOCK);
  stringField(header, 0, 100, relative);
  octalField(header, 100, 8, 0o444);
  octalField(header, 108, 8, 0);
  octalField(header, 116, 8, 0);
  octalField(header, 124, 12, size);
  octalField(header, 136, 12, 1_700_000_000);
  header.fill(0x20, 148, 156);
  stringField(header, 156, 1, type);
  stringField(header, 257, 6, "ustar\0");
  stringField(header, 263, 2, "00");
  const sum = header.reduce((total, byte) => total + byte, 0);
  stringField(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

async function createReleaseRoot(parent: string, commit: string): Promise<string> {
  const root = path.join(parent, `release-${commit.slice(0, 12)}`);
  await mkdir(root);
  await Promise.all([
    write(root, "server.js", "console.log('standalone');\n"),
    write(root, ".next/BUILD_ID", `${commit}\n`),
    write(root, "package.json", contract.stableJson({
      name: "videosave",
      version: "1.0.0",
      private: true,
      packageManager: `npm@${contract.APPROVED_NPM_VERSION}`,
      engines: { node: contract.APPROVED_NODE_VERSION, npm: contract.APPROVED_NPM_VERSION },
      dependencies: { next: "16.2.10", pg: "8.22.0", react: "19.0.0", "react-dom": "19.0.0" }
    })),
    write(root, ".next/static/chunks/app.js", "console.log('client');\n"),
    write(root, "worker/main.mjs", "export {};\n"),
    write(root, "checks/web-readiness.mjs", "export {};\n"),
    write(root, "scripts/postgres-migrations.mjs", "export {};\n"),
    write(root, "smoke/production-smoke.mjs", "export {};\n"),
    write(root, "tools/verify-release.mjs", "export {};\n"),
    write(root, "tools/release-contract.mjs", "export {};\n")
  ]);
  await Promise.all(contract.REQUIRED_RUNTIME_PACKAGES.map((name: string) =>
    write(root, `node_modules/${name}/package.json`, `${JSON.stringify({ name, version: "1.0.0" })}\n`)
  ));
  for (const migration of contract.REQUIRED_MIGRATIONS) {
    await write(
      root,
      `db/migrations/${migration.file}`,
      await readFile(path.join(process.cwd(), "db/migrations", migration.file), "utf8")
    );
  }
  const payload = await contract.hashReleaseFiles(root);
  const migrations = contract.REQUIRED_MIGRATIONS.map((migration: { version: string; file: string }) => ({
    ...migration,
    sha256: payload.find((record: { path: string }) => record.path === `db/migrations/${migration.file}`).sha256
  }));
  const worker = payload.find((record: { path: string }) => record.path === "worker/main.mjs");
  const manifest = {
    schemaVersion: contract.RELEASE_MANIFEST_SCHEMA_VERSION,
    application: { name: "videosave", version: "1.0.0" },
    artifacts: {
      webSha256: contract.canonicalTreeHash(payload, (record: { path: string }) => webArtifact(record.path)),
      workerSha256: worker.sha256
    },
    build: {
      gitCommit: commit,
      gitTree: "b".repeat(40),
      nodeVersion: contract.APPROVED_NODE_VERSION,
      npmVersion: contract.APPROVED_NPM_VERSION,
      sourceDateEpoch: 1_700_000_000,
      timestamp: "2023-11-14T22:13:20.000Z",
      target: `${process.platform}-${process.arch}`,
      sourceTreeDirty: false
    },
    entrypoints: contract.RELEASE_ENTRYPOINTS,
    migrations,
    runtimeAuthority: "postgres-durable",
    storageMarkerVersion: "v2"
  };
  await write(root, contract.RELEASE_MANIFEST_FILE, contract.stableJson(manifest));
  await write(root, contract.RELEASE_CHECKSUMS_FILE, contract.formatChecksums(await contract.hashReleaseFiles(root)));
  return root;
}

async function archiveFromRecords(
  directory: string,
  basename: string,
  records: readonly { path: string; bytes: Buffer; type?: string }[]
) {
  const chunks: Buffer[] = [];
  for (const record of records) {
    chunks.push(tarHeader(record.path, record.bytes.length, record.type));
    chunks.push(record.bytes);
    const padding = (TAR_BLOCK - (record.bytes.length % TAR_BLOCK)) % TAR_BLOCK;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2));
  const archive = path.join(directory, `${basename}.tar.gz`);
  const compressed = gzipSync(Buffer.concat(chunks), { level: 9 });
  await writeFile(archive, compressed);
  const checksum = path.join(directory, `${basename}.tar.gz.sha256`);
  const digest = createHash("sha256").update(compressed).digest("hex");
  await writeFile(checksum, `${digest}  ${basename}.tar.gz\n`);
  return { archive, checksum };
}

async function releaseArchive(parent: string, commit: string) {
  const root = await createReleaseRoot(parent, commit);
  const files = await contract.listReleaseFiles(root);
  const records = await Promise.all(files.map(async (file: { relative: string; absolute: string }) => ({
    path: file.relative,
    bytes: await readFile(file.absolute)
  })));
  return archiveFromRecords(parent, `videosave-${commit.slice(0, 12)}`, records);
}

async function layout() {
  const root = await temporary("videosave-deployment-root-");
  await mkdir(path.join(root, "releases"));
  return root;
}

async function makeWritable(value: string): Promise<void> {
  const info = await lstat(value).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(value, 0o755).catch(() => undefined);
    for (const entry of await readdir(value)) await makeWritable(path.join(value, entry));
  } else {
    await chmod(value, 0o644).catch(() => undefined);
  }
}

afterEach(async () => {
  for (const value of roots) {
    await makeWritable(value);
    await rm(value, { recursive: true, force: true });
  }
  roots.clear();
});

describe("immutable release installation", () => {
  it("accepts a checksummed B1 archive and installs it read-only", async () => {
    const root = await layout();
    const artifacts = await releaseArchive(root, "a".repeat(40));
    await expect(deployment.installRelease({ ...artifacts, deploymentRoot: root }))
      .resolves.toEqual({
        outcome: "installed",
        releaseId: "videosave-1.0.0-aaaaaaaaaaaa",
        changed: true
      });
    await expect(deployment.inspectInstalledRelease({
      deploymentRoot: root,
      releaseId: "videosave-1.0.0-aaaaaaaaaaaa"
    })).resolves.toMatchObject({ releaseId: "videosave-1.0.0-aaaaaaaaaaaa" });
  });

  it("rejects tampering, existing targets and traversal", async () => {
    const root = await layout();
    const artifacts = await releaseArchive(root, "a".repeat(40));
    await deployment.installRelease({ ...artifacts, deploymentRoot: root });
    await expect(deployment.installRelease({ ...artifacts, deploymentRoot: root }))
      .rejects.toMatchObject({ code: "release-already-installed" });
    await writeFile(artifacts.archive, Buffer.from("tampered"));
    await expect(deployment.installRelease({ ...artifacts, deploymentRoot: root }))
      .rejects.toMatchObject({ code: "archive-checksum-mismatch" });
    await expect(deployment.promoteRelease({
      deploymentRoot: root,
      releaseId: "../escape",
      dryRun: true
    })).rejects.toMatchObject({ code: "release-id-invalid" });
  });

  it("rejects archive traversal, symlink entries and unexpected content", async () => {
    const root = await layout();
    const traversal = await archiveFromRecords(root, "traversal", [{
      path: "../escape",
      bytes: Buffer.from("unsafe")
    }]);
    await expect(deployment.installRelease({ ...traversal, deploymentRoot: root }))
      .rejects.toMatchObject({ code: "archive-path-invalid" });

    const linked = await archiveFromRecords(root, "symlink", [{
      path: "server.js",
      bytes: Buffer.from("target"),
      type: "2"
    }]);
    await expect(deployment.installRelease({ ...linked, deploymentRoot: root }))
      .rejects.toMatchObject({ code: "archive-entry-type-forbidden" });

    const source = await createReleaseRoot(root, "c".repeat(40));
    await write(source, "checks/unexpected.txt", "unexpected");
    const files = await contract.listReleaseFiles(source);
    const unexpected = await archiveFromRecords(root, "unexpected", await Promise.all(files.map(async (file: { relative: string; absolute: string }) => ({
      path: file.relative,
      bytes: await readFile(file.absolute)
    }))));
    await expect(deployment.installRelease({ ...unexpected, deploymentRoot: root })).rejects.toThrow();
  });

  it("cleans partial extraction and keeps dry-run mutation-free", async () => {
    const root = await layout();
    const artifacts = await releaseArchive(root, "d".repeat(40));
    const compressed = await readFile(artifacts.archive);
    await writeFile(artifacts.archive, compressed.subarray(0, Math.floor(compressed.length / 2)));
    const truncated = await readFile(artifacts.archive);
    await writeFile(
      artifacts.checksum,
      `${createHash("sha256").update(truncated).digest("hex")}  ${path.basename(artifacts.archive)}\n`
    );
    await expect(deployment.installRelease({ ...artifacts, deploymentRoot: root })).rejects.toThrow();
    expect((await readdir(path.join(root, "releases"))).filter((name) => name.startsWith(".install-"))).toEqual([]);

    const clean = await releaseArchive(root, "e".repeat(40));
    await expect(deployment.installRelease({ ...clean, deploymentRoot: root, dryRun: true }))
      .resolves.toMatchObject({ outcome: "would-install", changed: false });
    expect(await readdir(path.join(root, "releases"))).toEqual([]);
  });
});

describe("atomic promotion and rollback compatibility", () => {
  it("atomically switches current while retaining the previous release", async () => {
    const root = await layout();
    for (const commit of ["a".repeat(40), "b".repeat(40)]) {
      await deployment.installRelease({ ...(await releaseArchive(root, commit)), deploymentRoot: root });
    }
    await deployment.promoteRelease({
      deploymentRoot: root,
      releaseId: "videosave-1.0.0-aaaaaaaaaaaa",
      confirm: true
    });
    const promoted = await deployment.promoteRelease({
      deploymentRoot: root,
      releaseId: "videosave-1.0.0-bbbbbbbbbbbb",
      confirm: true
    });
    expect(promoted).toEqual({
      outcome: "promoted",
      previousReleaseId: "videosave-1.0.0-aaaaaaaaaaaa",
      currentReleaseId: "videosave-1.0.0-bbbbbbbbbbbb",
      changed: true
    });
    expect(await readlink(path.join(root, "current"))).toBe("releases/videosave-1.0.0-bbbbbbbbbbbb");
    expect(await readdir(path.join(root, "releases"))).toEqual(expect.arrayContaining([
      "videosave-1.0.0-aaaaaaaaaaaa",
      "videosave-1.0.0-bbbbbbbbbbbb"
    ]));
  });

  it("requires confirmation, keeps dry-run mutation-free and rejects non-symlink current", async () => {
    const root = await layout();
    await deployment.installRelease({ ...(await releaseArchive(root, "a".repeat(40))), deploymentRoot: root });
    await expect(deployment.promoteRelease({
      deploymentRoot: root,
      releaseId: "videosave-1.0.0-aaaaaaaaaaaa"
    })).rejects.toMatchObject({ code: "promotion-confirmation-required" });
    await expect(deployment.promoteRelease({
      deploymentRoot: root,
      releaseId: "videosave-1.0.0-aaaaaaaaaaaa",
      dryRun: true
    })).resolves.toMatchObject({ outcome: "would-promote", changed: false });
    await expect(lstat(path.join(root, "current"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path.join(root, "current"), "not-a-symlink");
    await expect(deployment.promoteRelease({
      deploymentRoot: root,
      releaseId: "videosave-1.0.0-aaaaaaaaaaaa",
      dryRun: true
    })).rejects.toMatchObject({ code: "current-not-symlink" });
  });

  it("allows matching persistent contracts and blocks an invalid rollback target", async () => {
    const root = await layout();
    for (const commit of ["a".repeat(40), "b".repeat(40)]) {
      await deployment.installRelease({ ...(await releaseArchive(root, commit)), deploymentRoot: root });
    }
    await expect(deployment.checkRollbackCompatibility({
      deploymentRoot: root,
      fromReleaseId: "videosave-1.0.0-bbbbbbbbbbbb",
      toReleaseId: "videosave-1.0.0-aaaaaaaaaaaa"
    })).resolves.toMatchObject({ outcome: "compatible", reasons: [] });

    const target = path.join(root, "releases", "videosave-1.0.0-aaaaaaaaaaaa", contract.RELEASE_MANIFEST_FILE);
    await chmod(path.dirname(target), 0o755);
    await chmod(target, 0o644);
    await writeFile(target, "{}\n");
    await expect(deployment.checkRollbackCompatibility({
      deploymentRoot: root,
      fromReleaseId: "videosave-1.0.0-bbbbbbbbbbbb",
      toReleaseId: "videosave-1.0.0-aaaaaaaaaaaa"
    })).resolves.toEqual({
      outcome: "blocked",
      fromReleaseId: "videosave-1.0.0-bbbbbbbbbbbb",
      toReleaseId: "videosave-1.0.0-aaaaaaaaaaaa",
      reasons: ["target-release-invalid"]
    });
  });
});
