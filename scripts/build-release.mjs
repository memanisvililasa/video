import { execFile } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  APPROVED_NODE_VERSION,
  APPROVED_NPM_VERSION,
  RELEASE_CHECKSUMS_FILE,
  RELEASE_ENTRYPOINTS,
  RELEASE_MANIFEST_FILE,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  RELEASE_ROOT_DIRECTORY,
  REQUIRED_MIGRATIONS,
  REQUIRED_RUNTIME_PACKAGES,
  assertRegularFile,
  assertReleaseToolchain,
  canonicalTreeHash,
  formatChecksums,
  hashReleaseFiles,
  sha256File,
  stableJson,
  verifyReleaseRoot
} from "./release-contract.mjs";

const runFile = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const releaseRoot = path.join(projectRoot, RELEASE_ROOT_DIRECTORY);
const outputRoot = path.dirname(releaseRoot);

async function run(command, args, environment = {}) {
  try {
    await runFile(command, args, {
      cwd: projectRoot,
      env: { ...process.env, ...environment },
      maxBuffer: 8 * 1024 * 1024
    });
  } catch (error) {
    const output = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    if (output) process.stderr.write(`${output}\n`);
    throw new Error(`Release build command failed: ${path.basename(command)} ${args.join(" ")}`);
  }
}

async function npmVersion() {
  const invokedNpm = process.env.npm_execpath?.trim();
  const result = invokedNpm
    ? await runFile(process.execPath, [invokedNpm, "--version"], { cwd: projectRoot, maxBuffer: 64 * 1024 })
    : await runFile("npm", ["--version"], { cwd: projectRoot, maxBuffer: 64 * 1024 });
  return result.stdout.trim();
}

async function gitValue(args) {
  const result = await runFile("git", args, { cwd: projectRoot, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim();
}

async function copyReleaseTree(source, destination, options = {}) {
  const excludedTopLevel = new Set(options.excludedTopLevel ?? []);
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    force: false,
    errorOnExist: true,
    filter(candidate) {
      const normalized = candidate.replaceAll("\\", "/");
      const relative = path.relative(source, candidate).replaceAll("\\", "/");
      const topLevel = relative.split("/")[0];
      return (
        !excludedTopLevel.has(topLevel) &&
        !normalized.endsWith(".map") &&
        !normalized.includes("/.next/cache/")
      );
    }
  });
}

async function sanitizeStandaloneServer(filename) {
  const content = await readFile(filename, "utf8");
  const assignment = "const nextConfig = ";
  const start = content.indexOf(assignment);
  const endMarker = "\n\nprocess.env.__NEXT_PRIVATE_STANDALONE_CONFIG";
  const end = content.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("Next.js standalone config boundary is unsupported.");
  const jsonStart = start + assignment.length;
  let config;
  try {
    config = JSON.parse(content.slice(jsonStart, end));
  } catch {
    throw new Error("Next.js standalone config is not valid JSON.");
  }
  config.outputFileTracingRoot = ".";
  if (config.turbopack && typeof config.turbopack === "object") config.turbopack.root = ".";
  const sanitized = `${content.slice(0, jsonStart)}${JSON.stringify(config)}${content.slice(end)}`;
  if (sanitized.includes(projectRoot)) throw new Error("Builder root remains in the standalone server.");
  await writeFile(filename, sanitized, { mode: 0o644 });
}

async function sanitizeRequiredServerFiles(filename) {
  const metadata = JSON.parse(await readFile(filename, "utf8"));
  if (!metadata.config || typeof metadata.config !== "object") {
    throw new Error("Next.js required-server-files config is invalid.");
  }
  metadata.appDir = ".";
  metadata.config.outputFileTracingRoot = ".";
  if (metadata.config.turbopack && typeof metadata.config.turbopack === "object") {
    metadata.config.turbopack.root = ".";
  }
  const sanitized = stableJson(metadata);
  if (sanitized.includes(projectRoot)) throw new Error("Builder root remains in required server files.");
  await writeFile(filename, sanitized, { mode: 0o644 });
}

async function normalizeGeneratedSitemap(filename, sourceDateEpoch) {
  const content = await readFile(filename, "utf8");
  const lastModified = new Date(sourceDateEpoch * 1_000).toISOString();
  const matches = content.match(/<lastmod>[^<]+<\/lastmod>/g) ?? [];
  if (matches.length === 0) throw new Error("Generated sitemap does not expose normalizable timestamps.");
  const normalized = content.replaceAll(/<lastmod>[^<]+<\/lastmod>/g, `<lastmod>${lastModified}</lastmod>`);
  await writeFile(filename, normalized, { mode: 0o644 });
}

async function writeRuntimePackageMetadata(packageMetadata) {
  const dependencies = Object.fromEntries(REQUIRED_RUNTIME_PACKAGES.map((name) => {
    const version = packageMetadata.dependencies?.[name];
    if (typeof version !== "string" || version.length === 0) {
      throw new Error(`Required runtime package is not pinned: ${name}.`);
    }
    return [name, version];
  }));
  const runtimeMetadata = {
    name: packageMetadata.name,
    version: packageMetadata.version,
    private: true,
    packageManager: `npm@${APPROVED_NPM_VERSION}`,
    engines: { node: APPROVED_NODE_VERSION, npm: APPROVED_NPM_VERSION },
    dependencies
  };
  await writeFile(path.join(releaseRoot, "package.json"), stableJson(runtimeMetadata), { mode: 0o644 });
}

async function normalizeModes(directory) {
  const entries = await (await import("node:fs/promises")).readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await chmod(candidate, 0o755);
      await normalizeModes(candidate);
    } else {
      await chmod(candidate, 0o644);
    }
  }
}

function webArtifactPath(input) {
  const relative = typeof input === "string" ? input : input.path;
  return (
    relative === "server.js" ||
    relative === "package.json" ||
    relative.startsWith(".next/") ||
    relative.startsWith("node_modules/") ||
    relative.startsWith("public/")
  );
}

export async function assembleRelease({
  packageMetadata,
  gitCommit,
  gitTree,
  sourceDateEpoch,
  sourceTreeDirty
}) {
  if (!/^[a-f0-9]{40}$/.test(gitCommit) || !/^[a-f0-9]{40}$/.test(gitTree)) {
    throw new Error("Release source revision is invalid.");
  }
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    throw new Error("SOURCE_DATE_EPOCH is outside its supported range.");
  }
  if (typeof sourceTreeDirty !== "boolean") throw new Error("Release source tree state is invalid.");
  const standaloneRoot = path.join(projectRoot, ".next/standalone");
  await Promise.all([
    assertRegularFile(path.join(standaloneRoot, "server.js")),
    assertRegularFile(path.join(projectRoot, ".worker-dist/main.mjs")),
    assertRegularFile(path.join(projectRoot, ".web-readiness-dist/main.mjs"))
  ]);

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true, mode: 0o755 });
  await copyReleaseTree(standaloneRoot, releaseRoot, {
    excludedTopLevel: ["app", "components", "lib", "tests"]
  });
  await sanitizeStandaloneServer(path.join(releaseRoot, "server.js"));
  await sanitizeRequiredServerFiles(path.join(releaseRoot, ".next/required-server-files.json"));
  await normalizeGeneratedSitemap(
    path.join(releaseRoot, ".next/server/app/sitemap.xml.body"),
    sourceDateEpoch
  );
  await writeRuntimePackageMetadata(packageMetadata);
  await mkdir(path.join(releaseRoot, ".next"), { recursive: true });
  await copyReleaseTree(path.join(projectRoot, ".next/static"), path.join(releaseRoot, ".next/static"));
  const publicDirectory = path.join(projectRoot, "public");
  const publicInfo = await (await import("node:fs/promises")).stat(publicDirectory).catch(() => null);
  if (publicInfo?.isDirectory()) await copyReleaseTree(publicDirectory, path.join(releaseRoot, "public"));

  await Promise.all([
    mkdir(path.join(releaseRoot, "worker"), { recursive: true }),
    mkdir(path.join(releaseRoot, "checks"), { recursive: true }),
    mkdir(path.join(releaseRoot, "scripts"), { recursive: true }),
    mkdir(path.join(releaseRoot, "db/migrations"), { recursive: true }),
    mkdir(path.join(releaseRoot, "tools"), { recursive: true })
  ]);
  await Promise.all([
    cp(path.join(projectRoot, ".worker-dist/main.mjs"), path.join(releaseRoot, "worker/main.mjs")),
    cp(path.join(projectRoot, ".web-readiness-dist/main.mjs"), path.join(releaseRoot, "checks/web-readiness.mjs")),
    cp(path.join(projectRoot, "scripts/postgres-migrations.mjs"), path.join(releaseRoot, "scripts/postgres-migrations.mjs")),
    cp(path.join(projectRoot, "scripts/verify-release.mjs"), path.join(releaseRoot, "tools/verify-release.mjs")),
    cp(path.join(projectRoot, "scripts/release-contract.mjs"), path.join(releaseRoot, "tools/release-contract.mjs")),
    ...REQUIRED_MIGRATIONS.map((migration) => cp(
      path.join(projectRoot, "db/migrations", migration.file),
      path.join(releaseRoot, "db/migrations", migration.file)
    ))
  ]);

  await normalizeModes(releaseRoot);
  const payload = await hashReleaseFiles(releaseRoot);
  const migrations = [];
  for (const migration of REQUIRED_MIGRATIONS) {
    migrations.push(Object.freeze({
      ...migration,
      sha256: await sha256File(path.join(releaseRoot, "db/migrations", migration.file))
    }));
  }
  const workerRecord = payload.find((record) => record.path === RELEASE_ENTRYPOINTS.worker);
  if (!workerRecord) throw new Error("Compiled worker was not copied into the release.");
  const manifest = Object.freeze({
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    application: Object.freeze({ name: packageMetadata.name, version: packageMetadata.version }),
    artifacts: Object.freeze({
      webSha256: canonicalTreeHash(payload, webArtifactPath),
      workerSha256: workerRecord.sha256
    }),
    build: Object.freeze({
      gitCommit,
      gitTree,
      nodeVersion: APPROVED_NODE_VERSION,
      npmVersion: APPROVED_NPM_VERSION,
      sourceDateEpoch,
      timestamp: new Date(sourceDateEpoch * 1_000).toISOString(),
      target: `${process.platform}-${process.arch}`,
      sourceTreeDirty
    }),
    entrypoints: RELEASE_ENTRYPOINTS,
    migrations: Object.freeze(migrations),
    runtimeAuthority: "postgres-durable",
    storageMarkerVersion: "v1"
  });
  await writeFile(path.join(releaseRoot, RELEASE_MANIFEST_FILE), stableJson(manifest), { mode: 0o644, flag: "wx" });
  const withManifest = await hashReleaseFiles(releaseRoot, { exclude: [RELEASE_CHECKSUMS_FILE] });
  await writeFile(path.join(releaseRoot, RELEASE_CHECKSUMS_FILE), formatChecksums(withManifest), { mode: 0o644, flag: "wx" });
  await verifyReleaseRoot(releaseRoot, { builderRoot: projectRoot });
  console.info(`Release build passed for ${gitCommit.slice(0, 12)}.`);
}

async function main() {
  const actualNode = process.version.replace(/^v/, "");
  const actualNpm = await npmVersion();
  assertReleaseToolchain({ nodeVersion: actualNode, npmVersion: actualNpm });

  const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  if (
    packageMetadata.packageManager !== `npm@${APPROVED_NPM_VERSION}` ||
    packageMetadata.engines?.node !== APPROVED_NODE_VERSION ||
    packageMetadata.engines?.npm !== APPROVED_NPM_VERSION
  ) {
    throw new Error("package.json does not match the approved release toolchain.");
  }

  const gitCommit = await gitValue(["rev-parse", "HEAD"]);
  const gitTree = await gitValue(["rev-parse", "HEAD^{tree}"]);
  const sourceStatus = await gitValue(["status", "--porcelain=v1", "--untracked-files=all"]);
  const sourceDateEpochValue = process.env.SOURCE_DATE_EPOCH?.trim() || await gitValue(["show", "-s", "--format=%ct", "HEAD"]);
  if (!/^\d+$/.test(sourceDateEpochValue)) throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer.");
  const sourceDateEpoch = Number(sourceDateEpochValue);
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    throw new Error("SOURCE_DATE_EPOCH is outside its supported range.");
  }

  await run(process.execPath, [path.join(projectRoot, "node_modules/next/dist/bin/next"), "build"], {
    VIDEOSAVE_BUILD_ID: gitCommit,
    SOURCE_DATE_EPOCH: String(sourceDateEpoch)
  });
  await run(process.execPath, [path.join(projectRoot, "scripts/build-worker.mjs")]);
  await run(process.execPath, [path.join(projectRoot, "scripts/build-web-readiness.mjs")]);
  await assembleRelease({
    packageMetadata,
    gitCommit,
    gitTree,
    sourceDateEpoch,
    sourceTreeDirty: sourceStatus.length > 0
  });
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Release build failed.");
    process.exitCode = 1;
  });
}
