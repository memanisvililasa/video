import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const forbiddenPaths = [
  /(?:^|\/)\.env(?:$|\.(?!example$))/,
  /(?:^|\/)(?:coverage|test-results|playwright-report|\.release-dist|\.next)(?:\/|$)/,
  /\.(?:log|mp4|mov|webm|part)$/i
];
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\/Users\/(?!example(?:\/|$))[A-Za-z0-9._-]+\//
];

async function repositoryFiles() {
  const result = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 8 * 1024 * 1024
  });
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

async function main() {
  const failures = [];
  for (const relative of await repositoryFiles()) {
    if (forbiddenPaths.some((pattern) => pattern.test(relative))) {
      failures.push(relative);
      continue;
    }
    const bytes = await readFile(path.join(root, relative));
    if (bytes.length > 4 * 1024 * 1024 || bytes.includes(0)) continue;
    const content = bytes.toString("utf8");
    if (secretPatterns.some((pattern) => pattern.test(content))) failures.push(relative);
  }
  if (failures.length > 0) {
    throw new Error(`Repository secret/exclusion audit failed for ${failures.length} path(s).`);
  }
  console.info("Repository secret/exclusion audit passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Repository audit failed.");
  process.exitCode = 1;
});
