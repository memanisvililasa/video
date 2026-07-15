import "server-only";
import type { NextRequest } from "next/server";
import { getWebObservability, getWebReadinessProbe } from "@/lib/observability/web";

export type InternalWebResource = "live" | "ready" | "metrics";

const NO_CACHE_HEADERS = Object.freeze({
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff"
});

function expectedProductionHost(source: Readonly<Record<string, string | undefined>>): string | null {
  if (source.APP_PROCESS_ROLE?.trim() !== "web") return null;
  const host = source.HOSTNAME?.trim();
  const port = source.PORT?.trim();
  if ((host !== "127.0.0.1" && host !== "::1") || !port || !/^[1-9]\d{0,4}$/.test(port)) return null;
  const parsedPort = Number(port);
  if (parsedPort > 65_535) return null;
  return host === "::1" ? `[::1]:${port}` : `${host}:${port}`;
}

export function isInternalWebRequest(
  request: Pick<NextRequest, "headers">,
  source: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  let host: string | null;
  try {
    host = request.headers.get("host");
  } catch {
    return false;
  }
  if (!host || host.length > 96 || host.includes(",") || /[\u0000-\u001f\u007f]/.test(host)) return false;
  if (source.NODE_ENV?.trim() === "production") return host === expectedProductionHost(source);
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::(?:0|[1-9]\d{0,4}))?$/.test(host) &&
    Number(host.match(/:(\d+)$/)?.[1] ?? "0") <= 65_535;
}

function jsonResponse(status: number, body: Readonly<Record<string, string>>, head: boolean): Response {
  return new Response(head ? null : JSON.stringify(body), {
    status,
    headers: {
      ...NO_CACHE_HEADERS,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function rejection(status: number, statusValue: string, head: boolean): Response {
  return jsonResponse(status, Object.freeze({ status: statusValue }), head);
}

export async function handleInternalWebRequest(
  request: NextRequest,
  resource: InternalWebResource,
  source: Readonly<Record<string, string | undefined>> = process.env
): Promise<Response> {
  const method = request.method.toUpperCase();
  const head = method === "HEAD";
  if (!isInternalWebRequest(request, source)) return rejection(404, "not_found", head);
  if (method !== "GET" && method !== "HEAD") return rejection(405, "method_not_allowed", head);
  if (request.headers.has("content-length") || request.headers.has("transfer-encoding")) {
    return rejection(400, "body_not_allowed", head);
  }
  if (resource === "live") return jsonResponse(200, Object.freeze({ status: "live" }), head);
  if (resource === "ready") {
    const result = await (await getWebReadinessProbe()).check();
    if (result.ready) return jsonResponse(200, Object.freeze({ status: "ready" }), head);
    return jsonResponse(503, Object.freeze({ status: "not_ready", reason: result.reasonCategory }), head);
  }
  try {
    const body = (await getWebObservability()).metrics.registry.render();
    return new Response(head ? null : body, {
      status: 200,
      headers: {
        ...NO_CACHE_HEADERS,
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8"
      }
    });
  } catch {
    return rejection(503, "metrics_unavailable", head);
  }
}

export function rejectInternalWebMethod(request: NextRequest): Promise<Response> {
  return handleInternalWebRequest(request, "live");
}
