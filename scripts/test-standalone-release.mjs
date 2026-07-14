import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_ROOT_DIRECTORY, verifyReleaseRoot } from "./release-contract.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const releaseRoot = path.join(projectRoot, RELEASE_ROOT_DIRECTORY);

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Standalone web exited before becoming healthy.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1_000)
      });
      if (response.status === 200) {
        const payload = await response.json();
        if (payload?.data?.status !== "ok") throw new Error("Standalone health payload is invalid.");
        return;
      }
    } catch {
      // Startup polling is bounded by the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Standalone web health check timed out.");
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Standalone web did not stop gracefully.")), 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  await verifyReleaseRoot(releaseRoot, { builderRoot: projectRoot });
  for (const forbidden of ["app", "components", "lib", "tests", "next.config.ts", "tsconfig.json"]) {
    await access(path.join(releaseRoot, forbidden)).then(
      () => { throw new Error(`Source tree leaked into release: ${forbidden}`); },
      () => undefined
    );
  }
  const manifest = JSON.parse(await readFile(path.join(releaseRoot, "release-manifest.json"), "utf8"));
  if (manifest.entrypoints.web !== "server.js") throw new Error("Standalone web entrypoint is invalid.");
  const port = await availablePort();
  if (!port) throw new Error("A loopback test port was not allocated.");
  const child = spawn(process.execPath, ["server.js"], {
    cwd: releaseRoot,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      APP_PROCESS_ROLE: "web",
      HOSTNAME: "127.0.0.1",
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-16_384); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-16_384); });
  try {
    await waitForHealth(port, child);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "Standalone boot failed."}\n${output}`.trim());
  } finally {
    await stop(child).catch((error) => {
      child.kill("SIGKILL");
      throw error;
    });
  }
  if (child.exitCode !== 0 && child.exitCode !== 128 + 15) {
    throw new Error(`Standalone web exited with code ${child.exitCode}.`);
  }
  console.info("Standalone release boot passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Standalone release boot failed.");
  process.exitCode = 1;
});
