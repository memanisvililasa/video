import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RELEASE_CHECKSUMS_FILE,
  RELEASE_MANIFEST_FILE,
  RELEASE_ROOT_DIRECTORY,
  sha256File,
  verifyReleaseRoot
} from "./release-contract.mjs";

const run = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const RELEASE_ARTIFACT_STAGING_DIRECTORY = "ci-release-artifact";

function stagingError(message) {
  return new Error(`Release artifact staging failed: ${message}`);
}

async function assertRegularSource(filename, label) {
  const info = await lstat(filename).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw stagingError(`${label} must be a regular file.`);
  }
  return info;
}

function assertSafeVersion(version) {
  if (typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) {
    throw stagingError("release version is invalid.");
  }
}

function parseArchiveChecksum(value, archiveName) {
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz)\n$/.exec(value);
  if (!match || match[2] !== archiveName) {
    throw stagingError("archive checksum metadata is invalid.");
  }
  return match[1];
}

export async function stageVerifiedReleaseArtifacts(options = {}) {
  const root = path.resolve(options.projectRoot ?? projectRoot);
  const releaseRoot = path.resolve(options.releaseRoot ?? path.join(root, RELEASE_ROOT_DIRECTORY));
  const stagingRoot = path.resolve(
    options.stagingRoot ?? path.join(root, RELEASE_ARTIFACT_STAGING_DIRECTORY)
  );
  const stagingRelative = path.relative(root, stagingRoot);
  if (!stagingRelative || stagingRelative.startsWith("..") || path.isAbsolute(stagingRelative)) {
    throw stagingError("staging directory escaped the project root.");
  }
  if (path.basename(stagingRoot).startsWith(".")) {
    throw stagingError("staging directory must not be hidden.");
  }

  await rm(stagingRoot, { recursive: true, force: true });
  const verify = options.verifyRelease ?? verifyReleaseRoot;
  const { manifest } = await verify(releaseRoot, { builderRoot: root });
  const expectedCommit = options.expectedCommit;
  if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? "")) {
    throw stagingError("expected commit is invalid.");
  }
  if (manifest.build.gitCommit !== expectedCommit || manifest.build.sourceTreeDirty !== false) {
    throw stagingError("release manifest does not match the clean expected commit.");
  }
  assertSafeVersion(manifest.application.version);

  const archiveName = `videosave-${manifest.application.version}-${expectedCommit.slice(0, 12)}.tar.gz`;
  const outputRoot = path.dirname(releaseRoot);
  const archive = path.join(outputRoot, archiveName);
  const archiveChecksum = `${archive}.sha256`;
  const releaseManifest = path.join(releaseRoot, RELEASE_MANIFEST_FILE);
  const releaseChecksums = path.join(releaseRoot, RELEASE_CHECKSUMS_FILE);
  await Promise.all([
    assertRegularSource(archive, "release archive"),
    assertRegularSource(archiveChecksum, "release archive checksum"),
    assertRegularSource(releaseManifest, "release manifest"),
    assertRegularSource(releaseChecksums, "release payload checksums")
  ]);
  const declaredChecksum = parseArchiveChecksum(await readFile(archiveChecksum, "utf8"), archiveName);
  if (await sha256File(archive) !== declaredChecksum) {
    throw stagingError("release archive checksum does not match.");
  }

  const sources = Object.freeze([
    Object.freeze({ source: archive, name: archiveName }),
    Object.freeze({ source: archiveChecksum, name: `${archiveName}.sha256` }),
    Object.freeze({ source: releaseManifest, name: RELEASE_MANIFEST_FILE }),
    Object.freeze({ source: releaseChecksums, name: RELEASE_CHECKSUMS_FILE })
  ]);
  try {
    await mkdir(stagingRoot, { recursive: false, mode: 0o700 });
    for (const artifact of sources) {
      await copyFile(artifact.source, path.join(stagingRoot, artifact.name), fsConstants.COPYFILE_EXCL);
    }
    const stagedNames = (await readdir(stagingRoot)).sort((left, right) => left.localeCompare(right, "en"));
    const expectedNames = sources.map(({ name }) => name).sort((left, right) => left.localeCompare(right, "en"));
    if (JSON.stringify(stagedNames) !== JSON.stringify(expectedNames)) {
      throw stagingError("staging directory contains unexpected files.");
    }
    for (const name of stagedNames) await assertRegularSource(path.join(stagingRoot, name), "staged artifact");
    if (await sha256File(path.join(stagingRoot, archiveName)) !== declaredChecksum) {
      throw stagingError("staged archive checksum does not match.");
    }
    return Object.freeze({
      stagingRoot,
      commit: expectedCommit,
      files: Object.freeze(stagedNames)
    });
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function gitHead() {
  const { stdout } = await run("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    maxBuffer: 64 * 1024
  });
  return stdout.trim();
}

async function main() {
  const result = await stageVerifiedReleaseArtifacts({ expectedCommit: await gitHead() });
  console.info(`Verified release artifact staged for ${result.commit.slice(0, 12)}: ${result.files.length} files.`);
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Release artifact staging failed.");
    process.exitCode = 1;
  });
}
