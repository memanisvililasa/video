import http from "node:http";
import net, { type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { resolveSafeAddress } from "@/lib/http/safe-fetch";

const DEFAULT_MAX_TUNNELS = 8;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;

type SafeAddress = Readonly<{ address: string; family: 4 | 6 }>;
type AddressResolver = (hostname: string, timeoutSeconds: number, signal: AbortSignal) => Promise<SafeAddress>;
type SocketConnector = (options: net.NetConnectOpts) => Socket;

export type MetadataEgressGuardOptions = Readonly<{
  signal?: AbortSignal;
  resolveAddress?: AddressResolver;
  connectSocket?: SocketConnector;
  maxTunnels?: number;
  maxBytes?: number;
  idleTimeoutMs?: number;
  dnsTimeoutSeconds?: number;
}>;

export type MetadataEgressGuard = Readonly<{
  proxyUrl: string;
  close(): Promise<void>;
}>;

function parseAuthority(authority: string): { hostname: string; port: 443 } | null {
  if (!authority || authority.length > 512 || /[\u0000-\u0020\u007f]/.test(authority)) return null;
  let hostname: string;
  let portValue: string;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end <= 1 || authority[end + 1] !== ":") return null;
    hostname = authority.slice(1, end);
    portValue = authority.slice(end + 2);
  } else {
    const separator = authority.lastIndexOf(":");
    if (separator <= 0 || authority.slice(0, separator).includes(":")) return null;
    hostname = authority.slice(0, separator);
    portValue = authority.slice(separator + 1);
  }
  if (portValue !== "443") return null;
  return { hostname, port: 443 };
}

function genericProxyFailure(socket: Socket | Duplex, status: 400 | 403 | 429 | 502): void {
  if (!socket.destroyed && socket.writable) {
    socket.end(`HTTP/1.1 ${status} Connection Rejected\r\nConnection: close\r\n\r\n`);
  } else {
    socket.destroy();
  }
}

export async function startMetadataEgressGuard(
  options: MetadataEgressGuardOptions = {}
): Promise<MetadataEgressGuard> {
  if (options.signal?.aborted) throw new Error("Metadata egress guard was cancelled before startup.");
  const maxTunnels = options.maxTunnels ?? DEFAULT_MAX_TUNNELS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const dnsTimeoutSeconds = options.dnsTimeoutSeconds ?? 10;
  if (!Number.isSafeInteger(maxTunnels) || maxTunnels < 1 || maxTunnels > 32) throw new TypeError("maxTunnels is invalid.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new TypeError("maxBytes is invalid.");
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 100 || idleTimeoutMs > 60_000) throw new TypeError("idleTimeoutMs is invalid.");

  const controller = new AbortController();
  const resolveAddress = options.resolveAddress ?? resolveSafeAddress;
  const connectSocket = options.connectSocket ?? ((connectOptions) => net.connect(connectOptions));
  const sockets = new Set<Socket>();
  let activeTunnels = 0;
  let transferredBytes = 0;
  let closing: Promise<void> | undefined;

  const server = http.createServer((_request, response) => {
    response.writeHead(405, { Connection: "close" });
    response.end();
  });
  server.on("clientError", (_error, socket) => genericProxyFailure(socket, 400));
  server.on("connect", (request, client, head) => {
    const clientSocket = client as Socket;
    const authority = parseAuthority(request.url ?? "");
    if (!authority || controller.signal.aborted) {
      genericProxyFailure(clientSocket, 403);
      return;
    }
    if (activeTunnels >= maxTunnels) {
      genericProxyFailure(clientSocket, 429);
      return;
    }
    activeTunnels += 1;
    sockets.add(clientSocket);
    clientSocket.setTimeout(idleTimeoutMs, () => clientSocket.destroy());
    let upstream: Socket | undefined;
    let tunnelClosed = false;
    const closeTunnel = () => {
      if (tunnelClosed) return;
      tunnelClosed = true;
      activeTunnels -= 1;
      sockets.delete(clientSocket);
      if (upstream) sockets.delete(upstream);
    };
    clientSocket.once("close", closeTunnel);
    clientSocket.once("error", () => clientSocket.destroy());
    const countBytes = (chunk: Buffer) => {
      transferredBytes += chunk.length;
      if (transferredBytes > maxBytes) {
        controller.abort();
        for (const socket of sockets) socket.destroy();
      }
    };

    void resolveAddress(authority.hostname, dnsTimeoutSeconds, controller.signal).then((resolved) => {
      if (controller.signal.aborted || clientSocket.destroyed) return;
      upstream = connectSocket({ host: resolved.address, port: authority.port, family: resolved.family });
      sockets.add(upstream);
      upstream.setTimeout(idleTimeoutMs, () => upstream?.destroy());
      let established = false;
      upstream.once("error", () => {
        if (established) clientSocket.destroy();
        else genericProxyFailure(clientSocket, 502);
      });
      upstream.once("close", closeTunnel);
      upstream.once("connect", () => {
        if (!upstream || clientSocket.destroyed) return upstream?.destroy();
        established = true;
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
          countBytes(head);
          upstream.write(head);
        }
        clientSocket.on("data", countBytes);
        upstream.on("data", countBytes);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
    }).catch(() => genericProxyFailure(clientSocket, 403));
  });

  const close = async (): Promise<void> => {
    if (closing) return closing;
    closing = new Promise<void>((resolve) => {
      controller.abort();
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return resolve();
      server.close(() => resolve());
    });
    return closing;
  };
  const onAbort = () => { void close(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  server.once("close", () => options.signal?.removeEventListener("abort", onAbort));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("Metadata egress guard failed to bind to loopback.");
  }
  if (controller.signal.aborted) {
    await close();
    throw new Error("Metadata egress guard was cancelled during startup.");
  }
  return Object.freeze({ proxyUrl: `http://127.0.0.1:${address.port}`, close });
}
