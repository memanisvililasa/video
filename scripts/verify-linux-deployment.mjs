import { execFile, spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const run = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function requireLinux() {
  if (process.platform !== "linux") throw new Error("Linux deployment validation requires Linux.");
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function verifySystemd(root) {
  const current = path.join(root, "current");
  const media = path.join(root, "media");
  const environment = path.join(root, "env");
  const units = path.join(root, "systemd");
  await Promise.all([
    mkdir(path.join(current, "checks"), { recursive: true }),
    mkdir(path.join(current, "tools"), { recursive: true }),
    mkdir(path.join(current, "worker"), { recursive: true }),
    mkdir(path.join(current, "scripts"), { recursive: true }),
    mkdir(media, { recursive: true }),
    mkdir(environment, { recursive: true }),
    mkdir(units, { recursive: true })
  ]);
  for (const relative of [
    "server.js", "checks/web-readiness.mjs", "tools/verify-release.mjs",
    "worker/main.mjs", "scripts/postgres-migrations.mjs"
  ]) {
    const target = path.join(current, relative);
    await writeFile(target, "export {};\n", { mode: 0o444 });
  }
  for (const name of ["web.env", "worker.env", "migration.env"]) {
    await writeFile(path.join(environment, name), "NODE_ENV=test\n", { mode: 0o600 });
  }
  const rendered = [];
  for (const name of ["videosave-web.service", "videosave-worker.service", "videosave-migrate.service"]) {
    let content = await readFile(path.join(projectRoot, "deployment/systemd", name), "utf8");
    content = content
      .replaceAll("/usr/bin/node", process.execPath)
      .replaceAll("/opt/videosave/current", current)
      .replaceAll("/var/lib/videosave/media", media)
      .replaceAll("/etc/videosave/web.env", path.join(environment, "web.env"))
      .replaceAll("/etc/videosave/worker.env", path.join(environment, "worker.env"))
      .replaceAll("/etc/videosave/migration.env", path.join(environment, "migration.env"))
      .replace(/^User=.*$/m, "User=nobody")
      .replace(/^Group=.*$/m, "Group=nogroup")
      .replace(/^SupplementaryGroups=.*$/m, "SupplementaryGroups=nogroup");
    const target = path.join(units, name);
    await writeFile(target, content, { mode: 0o600 });
    rendered.push(target);
  }
  await run("systemd-analyze", ["verify", ...rendered], { maxBuffer: 1024 * 1024 });
}

async function createCertificate(root) {
  const key = path.join(root, "test.key");
  const certificate = path.join(root, "test.crt");
  await run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=videosave.test", "-keyout", key, "-out", certificate
  ], { maxBuffer: 1024 * 1024 });
  await chmod(key, 0o600);
  return { key, certificate };
}

async function httpsJson(port, method, pathname, headers = {}, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host,
      port,
      method,
      path: pathname,
      servername: "videosave.test",
      rejectUnauthorized: false,
      headers: { Host: "videosave.test", ...headers },
      timeout: 5_000
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("timeout", () => request.destroy(new Error("Nginx integration request timed out.")));
    request.once("error", reject);
    request.end();
  });
}

async function waitForNginx(port, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Nginx exited before validation.");
    try {
      await httpsJson(port, "GET", "/api/health");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Nginx did not become ready.");
}

async function closeHttpServer(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function stopChild(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Nginx did not stop gracefully.")), timeoutMs))
    ]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 1_000))
    ]);
    throw error;
  }
}

export async function withUpstreamFixture(operation, createServer = createHttpServer) {
  const upstream = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ method: request.method, headers: request.headers }));
  });
  try {
    await new Promise((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address();
    const upstreamPort = typeof address === "object" && address ? address.port : null;
    if (!upstreamPort) throw new Error("Upstream loopback port was not allocated.");
    return await operation(upstreamPort);
  } finally {
    await closeHttpServer(upstream);
  }
}

async function verifyNginx(root) {
  return withUpstreamFixture(async (upstreamPort) => {
    const httpPort = await availablePort();
    const httpsPort = await availablePort();
    if (!httpPort || !httpsPort) throw new Error("Loopback ports were not allocated.");
    const tls = await createCertificate(root);
    let template = await readFile(path.join(projectRoot, "deployment/nginx/videosave.conf"), "utf8");
    template = template
      .replaceAll("__PUBLIC_HOSTNAME__", "videosave.test")
      .replaceAll("__TLS_CERTIFICATE_FILE__", tls.certificate)
      .replaceAll("__TLS_CERTIFICATE_KEY_FILE__", tls.key)
      .replace("server 127.0.0.1:3000;", `server 127.0.0.1:${upstreamPort};`)
      .replace("listen 80;", `listen 127.0.0.1:${httpPort};`)
      .replace("listen [::]:80;", `listen [::1]:${httpPort};`)
      .replace("listen 443 ssl http2;", `listen 127.0.0.1:${httpsPort} ssl;`)
      .replace("listen [::]:443 ssl http2;", `listen [::1]:${httpsPort} ssl;`)
      .replace("/var/log/nginx/videosave-access.log", path.join(root, "access.log"))
      .replace("/var/log/nginx/videosave-error.log", path.join(root, "error.log"));
    const config = path.join(root, "nginx.conf");
    await writeFile(config, [
      `pid ${path.join(root, "nginx.pid")};`,
      "error_log stderr notice;",
      "events { worker_connections 64; }",
      "http {",
      "  default_type application/octet-stream;",
      template,
      "}"
    ].join("\n"), { mode: 0o600 });
    let child;
    try {
      await run("nginx", ["-t", "-p", `${root}/`, "-c", config], { maxBuffer: 1024 * 1024 });
      child = spawn("nginx", ["-p", `${root}/`, "-c", config, "-g", "daemon off; master_process off;"], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      await waitForNginx(httpsPort, child);
      const redirect = await fetch(`http://127.0.0.1:${httpPort}/api/health`, {
        headers: { Host: "videosave.test" },
        redirect: "manual",
        signal: AbortSignal.timeout(5_000)
      });
      if (redirect.status !== 308 || redirect.headers.get("location") !== "https://videosave.test/api/health") {
        throw new Error("Nginx HTTPS redirect contract failed.");
      }
      for (const method of ["GET", "POST", "DELETE", "OPTIONS"]) {
        const result = await httpsJson(httpsPort, method, "/api/health", {
          "X-VideoSave-Client-IP": "203.0.113.10",
          "X-Forwarded-For": "198.51.100.2, 203.0.113.3",
          "X-Real-IP": "198.51.100.4",
          Forwarded: "for=198.51.100.5"
        });
        if (result.status !== 200 || result.body.method !== method) throw new Error("Nginx method proxying failed.");
        const headers = result.body.headers;
        if (headers["x-videosave-client-ip"] !== "127.0.0.1") throw new Error("Trusted identity was not overwritten.");
        for (const name of ["x-forwarded-for", "x-real-ip", "forwarded"]) {
          if (headers[name] !== undefined) throw new Error("Spoofable forwarding header reached the origin.");
        }
      }
      const ipv6 = await httpsJson(httpsPort, "GET", "/api/health", {
        "X-VideoSave-Client-IP": "198.51.100.1",
        "X-Forwarded-For": "203.0.113.1"
      }, "::1");
      if (ipv6.body.headers["x-videosave-client-ip"] !== "::1") {
        throw new Error("Nginx IPv6 trusted identity contract failed.");
      }
      if (ipv6.body.headers["x-forwarded-for"] !== undefined) {
        throw new Error("Nginx IPv6 forwarding header sanitization failed.");
      }
      const file = await httpsJson(httpsPort, "GET", `/api/file/file_${"a".repeat(32)}`);
      if (file.status !== 200) throw new Error("Nginx file route streaming proxy failed.");
    } finally {
      await stopChild(child);
    }
  });
}

async function main() {
  requireLinux();
  const root = await mkdtemp(path.join(os.tmpdir(), "videosave-linux-deployment-"));
  try {
    await verifySystemd(root);
    await verifyNginx(root);
    console.info("Linux systemd and Nginx deployment validation passed.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Linux deployment validation failed.");
    process.exitCode = 1;
  });
}
