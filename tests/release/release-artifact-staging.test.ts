import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Release tooling is intentionally plain Node.js ESM.
import { RELEASE_ARTIFACT_STAGING_DIRECTORY, stageVerifiedReleaseArtifacts } from "../../scripts/stage-release-artifact.mjs";

const roots = new Set<string>();
const commit = "a".repeat(40);
const archiveName = `videosave-1.0.0-${commit.slice(0, 12)}.tar.gz`;

async function sha256(filename: string): Promise<string> {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

async function fixture() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-artifact-stage-"));
  roots.add(projectRoot);
  const releaseRoot = path.join(projectRoot, ".release-dist", "release");
  const stagingRoot = path.join(projectRoot, RELEASE_ARTIFACT_STAGING_DIRECTORY);
  await mkdir(releaseRoot, { recursive: true });
  const archive = path.join(path.dirname(releaseRoot), archiveName);
  await writeFile(archive, "verified archive", { mode: 0o644 });
  await writeFile(`${archive}.sha256`, `${await sha256(archive)}  ${archiveName}\n`, { mode: 0o644 });
  await writeFile(path.join(releaseRoot, "release-manifest.json"), "{}\n", { mode: 0o644 });
  await writeFile(path.join(releaseRoot, "checksums.sha256"), `${"b".repeat(64)}  worker/main.mjs\n`, { mode: 0o644 });
  const verifyRelease = vi.fn(async () => ({
    manifest: {
      application: { version: "1.0.0" },
      build: { gitCommit: commit, sourceTreeDirty: false }
    },
    files: []
  }));
  return { projectRoot, releaseRoot, stagingRoot, archive, verifyRelease };
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("verified release artifact staging", () => {
  it("copies only the verified archive, manifest and checksums to a non-hidden directory", async () => {
    const value = await fixture();
    await writeFile(path.join(path.dirname(value.releaseRoot), ".env"), "SECRET=forbidden\n");
    await writeFile(path.join(path.dirname(value.releaseRoot), ".unexpected"), "hidden\n");
    await mkdir(value.stagingRoot);
    await writeFile(path.join(value.stagingRoot, "stale.log"), "stale\n");

    const result = await stageVerifiedReleaseArtifacts({
      ...value,
      expectedCommit: commit
    });

    expect(path.basename(result.stagingRoot)).toBe(RELEASE_ARTIFACT_STAGING_DIRECTORY);
    expect(path.basename(result.stagingRoot)).not.toMatch(/^\./);
    expect(result.files).toEqual([
      "checksums.sha256",
      "release-manifest.json",
      archiveName,
      `${archiveName}.sha256`
    ].sort((left, right) => left.localeCompare(right, "en")));
    expect(await readdir(value.stagingRoot)).not.toContain(".env");
    expect(await readdir(value.stagingRoot)).not.toContain(".unexpected");
    expect(await readdir(value.stagingRoot)).not.toContain("stale.log");
    expect(value.verifyRelease).toHaveBeenCalledOnce();
  });

  it("rejects a missing archive and leaves no staging directory", async () => {
    const value = await fixture();
    await rm(value.archive);
    await expect(stageVerifiedReleaseArtifacts({ ...value, expectedCommit: commit }))
      .rejects.toThrow("release archive must be a regular file");
    await expect(access(value.stagingRoot)).rejects.toThrow();
  });

  it("rejects a symlink archive", async () => {
    const value = await fixture();
    const target = path.join(value.projectRoot, "archive-target.tar.gz");
    await writeFile(target, "verified archive");
    await rm(value.archive);
    await symlink(target, value.archive);
    await expect(stageVerifiedReleaseArtifacts({ ...value, expectedCommit: commit }))
      .rejects.toThrow("release archive must be a regular file");
  });

  it("rejects an archive whose checksum no longer matches", async () => {
    const value = await fixture();
    await writeFile(value.archive, "tampered archive");
    await expect(stageVerifiedReleaseArtifacts({ ...value, expectedCommit: commit }))
      .rejects.toThrow("archive checksum does not match");
  });

  it("rejects an unverified release before creating staging", async () => {
    const value = await fixture();
    value.verifyRelease.mockRejectedValueOnce(new Error("release verification failed"));
    await expect(stageVerifiedReleaseArtifacts({ ...value, expectedCommit: commit }))
      .rejects.toThrow("release verification failed");
    await expect(access(value.stagingRoot)).rejects.toThrow();
  });

  it("binds the staged archive to the exact clean commit", async () => {
    const value = await fixture();
    await expect(stageVerifiedReleaseArtifacts({ ...value, expectedCommit: "c".repeat(40) }))
      .rejects.toThrow("clean expected commit");
  });
});
