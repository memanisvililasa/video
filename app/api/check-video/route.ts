import { NextResponse } from "next/server";
import { resolveMockVideo } from "@/lib/platforms";
import { consumeRateLimit } from "@/lib/rate-limit";
import { getClientIdentifier, validateVideoUrl } from "@/lib/security";
import type { CheckVideoResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BODY_LIMIT_BYTES = 4_096;
const RESPONSE_LIMIT_BYTES = 16_384;

function json(body: CheckVideoResponse, init?: ResponseInit) {
  const serialized = JSON.stringify(body);
  if (new TextEncoder().encode(serialized).byteLength > RESPONSE_LIMIT_BYTES) {
    return NextResponse.json({ status: "error", message: "Размер ответа превышает ограничение безопасности." }, { status: 500 });
  }
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new NextResponse(serialized, { ...init, headers });
}

async function readPayload(request: Request): Promise<{ url?: unknown }> {
  if (request.headers.get("content-type")?.toLowerCase().split(";")[0] !== "application/json") {
    throw new Error("unsupported_content_type");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_json");

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_LIMIT_BYTES) {
      await reader.cancel();
      throw new Error("body_too_large");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(body)) as { url?: unknown };
}

export async function POST(request: Request) {
  const client = getClientIdentifier(request.headers);
  const limit = consumeRateLimit(client);
  if (!limit.allowed) {
    return json({ status: "error", message: "Слишком много запросов. Повторите попытку немного позже." }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(contentLength) || contentLength > BODY_LIMIT_BYTES) {
    return json({ status: "error", message: "Слишком большой запрос." }, { status: 413 });
  }

  let payload: { url?: unknown };
  try {
    payload = await readPayload(request);
  } catch (error) {
    if (error instanceof Error && error.message === "body_too_large") {
      return json({ status: "error", message: "Слишком большой запрос." }, { status: 413 });
    }
    return json({ status: "error", message: "Некорректный формат запроса." }, { status: 400 });
  }

  const result = validateVideoUrl(payload.url);
  if (!result.ok) return json({ status: "error", message: result.message }, { status: 400 });

  try {
    // Intentionally no network request to the submitted URL happens here.
    // A real official provider adapter must verify authorization itself and use a provider-issued URL.
    return json(resolveMockVideo(result.url));
  } catch {
    // Never log submitted URLs, client identifiers, or request bodies.
    console.error("check-video failed: internal_adapter_error");
    return json({ status: "error", message: "Не удалось проверить ссылку. Повторите попытку позже." }, { status: 500 });
  }
}
