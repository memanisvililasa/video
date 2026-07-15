import "server-only";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { WorkerObservabilityConfig } from "@/lib/config/env";
import type { ReadinessProbe } from "@/lib/observability/readiness-probe";
import type { ProcessObservability } from "@/lib/observability/runtime";

const INTERNAL_PREFIX = "/internal/observability/";
const MAX_HEADER_BYTES = 8 * 1024;
const REQUEST_TIMEOUT_MS = 2_000;
const MAX_CONNECTIONS = 16;

export type WorkerObservabilityListener = Readonly<{
  start(): Promise<Readonly<{ host: "127.0.0.1" | "::1"; port: number }>>;
  close(): Promise<void>;
  address(): Readonly<{ host: "127.0.0.1" | "::1"; port: number }> | null;
}>;

function responseHeaders(contentType: string): Readonly<Record<string, string>> {
  return Object.freeze({
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    Connection: "close"
  });
}

function send(
  response: ServerResponse,
  statusCode: number,
  body: string,
  head: boolean,
  contentType = "application/json; charset=utf-8"
): void {
  const output = head ? "" : body;
  response.writeHead(statusCode, {
    ...responseHeaders(contentType),
    "Content-Length": String(Buffer.byteLength(output, "utf8"))
  });
  response.end(output);
}

function json(status: string): string { return JSON.stringify({ status }); }

function validHostHeader(request: IncomingMessage, host: "127.0.0.1" | "::1", port: number): boolean {
  const value = request.headers.host;
  const expected = host === "::1" ? `[::1]:${port}` : `${host}:${port}`;
  return typeof value === "string" && value === expected;
}

export function createWorkerObservabilityListener(options: Readonly<{
  config: WorkerObservabilityConfig;
  observability: ProcessObservability;
  readiness: ReadinessProbe;
}>): WorkerObservabilityListener {
  if (options.config.host !== "127.0.0.1" && options.config.host !== "::1") {
    throw new TypeError("Worker observability listener requires an explicit loopback host.");
  }
  let server: Server | null = null;
  let startPromise: Promise<Readonly<{ host: "127.0.0.1" | "::1"; port: number }>> | null = null;
  let closePromise: Promise<void> | null = null;
  let boundAddress: Readonly<{ host: "127.0.0.1" | "::1"; port: number }> | null = null;
  const sockets = new Set<Socket>();

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method?.toUpperCase() ?? "";
    const head = method === "HEAD";
    if (!boundAddress || !validHostHeader(request, boundAddress.host, boundAddress.port)) {
      send(response, 404, json("not_found"), head);
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      send(response, 405, json("method_not_allowed"), head);
      return;
    }
    if (request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined) {
      send(response, 400, json("body_not_allowed"), head);
      return;
    }
    const path = request.url?.includes("?") ? undefined : request.url;
    if (path === `${INTERNAL_PREFIX}live`) {
      send(response, 200, json("live"), head);
      return;
    }
    if (path === `${INTERNAL_PREFIX}ready`) {
      const result = await options.readiness.check();
      send(response, result.ready ? 200 : 503, result.ready
        ? json("ready")
        : JSON.stringify({ status: "not_ready", reason: result.reasonCategory }), head);
      return;
    }
    if (path === `${INTERNAL_PREFIX}metrics`) {
      try {
        await options.observability.collectMetrics();
        const body = options.observability.metrics.registry.render();
        send(response, 200, body, head, "text/plain; version=0.0.4; charset=utf-8");
      } catch {
        send(response, 503, json("metrics_unavailable"), head);
      }
      return;
    }
    send(response, 404, json("not_found"), head);
  }

  function start(): Promise<Readonly<{ host: "127.0.0.1" | "::1"; port: number }>> {
    if (startPromise) return startPromise;
    if (closePromise) return Promise.reject(new Error("Worker observability listener is closing."));
    startPromise = new Promise((resolve, reject) => {
      const instance = createServer({
        maxHeaderSize: MAX_HEADER_BYTES,
        requireHostHeader: true,
        keepAlive: false
      }, (request, response) => {
        void handle(request, response).catch(() => {
          if (!response.headersSent) send(response, 503, json("unavailable"), request.method === "HEAD");
          else response.destroy();
        });
      });
      server = instance;
      instance.requestTimeout = REQUEST_TIMEOUT_MS;
      instance.headersTimeout = REQUEST_TIMEOUT_MS;
      instance.keepAliveTimeout = 1_000;
      instance.maxHeadersCount = 32;
      instance.maxConnections = MAX_CONNECTIONS;
      instance.on("connection", (socket) => {
        sockets.add(socket);
        socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
        socket.once("close", () => sockets.delete(socket));
      });
      const onError = (error: Error): void => {
        instance.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        instance.off("error", onError);
        const address = instance.address();
        if (!address || typeof address === "string") {
          instance.close();
          reject(new Error("Worker observability listener address is invalid."));
          return;
        }
        boundAddress = Object.freeze({ host: options.config.host, port: address.port });
        resolve(boundAddress);
      };
      instance.once("error", onError);
      instance.once("listening", onListening);
      instance.listen({ host: options.config.host, port: options.config.port, exclusive: true });
    });
    return startPromise;
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const instance = server;
      if (!instance) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
          resolve();
        }, 500);
        instance.close(() => {
          clearTimeout(timer);
          resolve();
        });
        instance.closeIdleConnections();
      });
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      boundAddress = null;
      server = null;
    })();
    return closePromise;
  }

  return Object.freeze({ start, close, address: () => boundAddress });
}
