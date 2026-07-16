import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startMetadataEgressGuard } from "@/lib/extractors/yt-dlp/egress-guard";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing address"));
      resolve(address.port);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function connect(proxyUrl: string): Promise<net.Socket> {
  const url = new URL(proxyUrl);
  const socket = net.connect({ host: url.hostname, port: Number(url.port) });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function readUntil(socket: net.Socket, pattern: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      value += chunk.toString("utf8");
      if (pattern.test(value)) {
        socket.off("data", onData);
        resolve(value);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

describe("yt-dlp metadata egress guard", () => {
  it("accepts only a policy-resolved HTTPS CONNECT tunnel", async () => {
    const upstream = net.createServer((socket) => socket.pipe(socket));
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));
    const guard = await startMetadataEgressGuard({
      resolveAddress: async () => ({ address: "127.0.0.1", family: 4 }),
      connectSocket: () => net.connect({ host: "127.0.0.1", port: upstreamPort })
    });
    cleanup.push(() => guard.close());
    const socket = await connect(guard.proxyUrl);
    cleanup.push(async () => { socket.destroy(); });
    socket.write("CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\n");
    await expect(readUntil(socket, /200 Connection Established/)).resolves.toMatch(/200 Connection Established/);
    socket.write("probe");
    await expect(readUntil(socket, /probe/)).resolves.toContain("probe");
  });

  it("rejects non-443 CONNECT before DNS resolution", async () => {
    let resolved = false;
    const guard = await startMetadataEgressGuard({
      resolveAddress: async () => { resolved = true; return { address: "203.0.113.1", family: 4 }; }
    });
    cleanup.push(() => guard.close());
    const socket = await connect(guard.proxyUrl);
    cleanup.push(async () => { socket.destroy(); });
    socket.write("CONNECT public.example:80 HTTP/1.1\r\nHost: public.example:80\r\n\r\n");
    await expect(readUntil(socket, /403 Connection Rejected/)).resolves.toMatch(/403/);
    expect(resolved).toBe(false);
  });

  it("returns a generic rejection when SSRF validation fails", async () => {
    const guard = await startMetadataEgressGuard({
      resolveAddress: async () => { throw new Error("blocked-private-address"); }
    });
    cleanup.push(() => guard.close());
    const socket = await connect(guard.proxyUrl);
    cleanup.push(async () => { socket.destroy(); });
    socket.write("CONNECT blocked.example:443 HTTP/1.1\r\nHost: blocked.example:443\r\n\r\n");
    const response = await readUntil(socket, /403 Connection Rejected/);
    expect(response).not.toContain("blocked-private-address");
    expect(response).not.toContain("blocked.example");
  });
});
