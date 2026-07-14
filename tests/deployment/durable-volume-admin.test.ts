import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Deployment tooling is intentionally plain Node.js ESM.
import * as admin from "../../scripts/durable-volume-admin.mjs";
import { durableVolumeMarkerContent } from "@/lib/storage/durable-volume-marker";

const AUTHORITY = "abcdef0123456789abcdef0123456789";
const roots = new Set<string>();

async function root(): Promise<string> {
  const value = await realpath(await mkdtemp(path.join(os.tmpdir(), "videosave-volume-admin-")));
  roots.add(value);
  return value;
}

async function provision(value: string): Promise<void> {
  await mkdir(path.join(value, "published"), { mode: 0o750 });
  await admin.initializeVolumeMarker({ root: value, authorityId: AUTHORITY });
}

afterEach(async () => {
  for (const value of roots) {
    await chmod(value, 0o750).catch(() => undefined);
    await rm(value, { recursive: true, force: true });
  }
  roots.clear();
});

describe("durable volume authority administration", () => {
  it("uses the same deterministic marker contract as the runtime", () => {
    expect(admin.markerContent(AUTHORITY)).toBe(durableVolumeMarkerContent(AUTHORITY));
    expect(admin.VOLUME_MARKER_FILENAME).toBe(".videosave-volume");
  });

  it("supports mutation-free dry-run and explicit idempotent initialization", async () => {
    const value = await root();
    await expect(admin.initializeVolumeMarker({
      root: value,
      authorityId: AUTHORITY,
      dryRun: true
    })).resolves.toMatchObject({ outcome: "would-initialize", changed: false });
    expect(await readdir(value)).toEqual([]);

    await expect(admin.initializeVolumeMarker({ root: value, authorityId: AUTHORITY }))
      .resolves.toMatchObject({ outcome: "initialized", changed: true });
    await expect(admin.initializeVolumeMarker({ root: value, authorityId: AUTHORITY }))
      .resolves.toMatchObject({ outcome: "already-compatible", changed: false });
    expect(await readFile(path.join(value, admin.VOLUME_MARKER_FILENAME), "utf8"))
      .toBe(admin.markerContent(AUTHORITY));
  });

  it("never overwrites an incompatible marker", async () => {
    const value = await root();
    const marker = path.join(value, admin.VOLUME_MARKER_FILENAME);
    await writeFile(marker, admin.markerContent("0".repeat(32)), { mode: 0o640 });
    await expect(admin.initializeVolumeMarker({ root: value, authorityId: AUTHORITY }))
      .rejects.toMatchObject({ code: "marker-incompatible" });
    expect(await readFile(marker, "utf8")).toBe(admin.markerContent("0".repeat(32)));
  });

  it("keeps check-only mode read-only and reports bounded filesystem capacity", async () => {
    const value = await root();
    await provision(value);
    const before = await readdir(value);
    await expect(admin.checkDurableVolume({
      root: value,
      authorityId: AUTHORITY,
      role: "worker",
      minimumFreeBytes: 1
    })).resolves.toMatchObject({ outcome: "ok", role: "worker" });
    expect(await readdir(value)).toEqual(before);
  });

  it("probes hard links and atomic rename while always cleaning its files", async () => {
    const value = await root();
    await provision(value);
    const before = await readdir(value);
    await expect(admin.probeDurableVolume({
      root: value,
      authorityId: AUTHORITY,
      minimumFreeBytes: 1
    })).resolves.toMatchObject({ outcome: "probed", changed: false });
    expect(await readdir(value)).toEqual(before);
    expect((await readdir(value)).some((name) => name.startsWith(".videosave-probe-"))).toBe(false);
  });

  it("checks the web boundary without attempting writes", async () => {
    const value = await root();
    await provision(value);
    await chmod(path.join(value, "published"), 0o550);
    await chmod(value, 0o550);
    await expect(admin.checkDurableVolume({
      root: value,
      authorityId: AUTHORITY,
      role: "web",
      minimumFreeBytes: 1
    })).resolves.toMatchObject({ outcome: "ok", role: "web" });
  });

  it("rejects missing roots, missing markers, traversal and symlink roots", async () => {
    const value = await root();
    await expect(admin.checkDurableVolume({
      root: value,
      authorityId: AUTHORITY,
      role: "worker",
      minimumFreeBytes: 1
    })).rejects.toMatchObject({ code: "marker-missing" });
    await expect(admin.canonicalVolumeRoot(path.join(value, "missing")))
      .rejects.toMatchObject({ code: "root-unavailable" });
    await expect(admin.canonicalVolumeRoot(`${value}${path.sep}child${path.sep}..`))
      .rejects.toMatchObject({ code: "invalid-root" });

    const target = await root();
    const linked = path.join(value, "linked");
    await symlink(target, linked);
    await expect(admin.canonicalVolumeRoot(linked))
      .rejects.toMatchObject({ code: "invalid-root" });
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
  });

  it("keeps probe dry-run mutation-free", async () => {
    const value = await root();
    await provision(value);
    const before = await readdir(value);
    await expect(admin.probeDurableVolume({
      root: value,
      authorityId: AUTHORITY,
      minimumFreeBytes: 1,
      dryRun: true
    })).resolves.toMatchObject({ outcome: "would-probe", changed: false });
    expect(await readdir(value)).toEqual(before);
  });
});
