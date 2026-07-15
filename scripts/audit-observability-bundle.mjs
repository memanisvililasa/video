import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const staticRoot = path.join(root, ".next/static");
const serverRoot = path.join(root, ".next/server");
const forbidden = Object.freeze([
  "createOperationalLogger",
  "http_requests_total",
  "processInstanceId",
  "WORKER_OBSERVABILITY_HOST",
  "/internal/observability/",
  "PostgresSchemaCompatibilityError"
]);

async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(candidate));
    else if (entry.isFile() && /\.(?:js|json)$/.test(entry.name)) output.push(candidate);
  }
  return output;
}

if (!(await stat(staticRoot).catch(() => null))?.isDirectory()) throw new Error("Next.js static output is unavailable.");
if (!(await stat(serverRoot).catch(() => null))?.isDirectory()) throw new Error("Next.js server output is unavailable.");

for (const filename of await files(staticRoot)) {
  const content = await readFile(filename, "utf8");
  for (const marker of forbidden) {
    if (content.includes(marker)) throw new Error(`Server-only observability marker leaked into browser output: ${marker}.`);
  }
}

let serverContainsMetrics = false;
for (const filename of await files(serverRoot)) {
  const content = await readFile(filename, "utf8");
  if (content.includes("http_requests_total") && content.includes("process_up")) serverContainsMetrics = true;
}
if (!serverContainsMetrics) throw new Error("Server build does not contain required observability instrumentation.");
console.info("Observability browser bundle audit passed.");
