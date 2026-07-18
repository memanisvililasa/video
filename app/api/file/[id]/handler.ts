import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { Readable } from "node:stream";
import { API_ERROR_CODES, API_ERROR_STATUS, createApiErrorResponse } from "@/lib/errors";
import { checkRateLimit } from "@/lib/security/rate-limit";
import type { DeliverableMediaFile } from "@/lib/storage/file-delivery";
import type { RateLimitKeyInput, RateLimitResult } from "@/lib/security/rate-limit";
import {
  NOOP_HTTP_OBSERVABILITY,
  type HttpObservability
} from "@/lib/observability/http-observer";

export type FileDeliveryRouteDependencies = Readonly<{
  getFile: (fileId: string) => Promise<DeliverableMediaFile | null>;
  checkRateLimit?: (input: RateLimitKeyInput) => RateLimitResult;
  observability?: HttpObservability;
}>;

function errorResponse(code: keyof typeof API_ERROR_CODES, message?: string, status = API_ERROR_STATUS[code]) {
  return NextResponse.json(createApiErrorResponse(API_ERROR_CODES[code], message), { status });
}

function isValidFileId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{8,128}$/.test(id);
}

function wellFormedFilename(filename: string): string {
  return Array.from(filename, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff ? "_" : character;
  }).join("");
}

function contentDisposition(filename: string): string {
  const normalized = wellFormedFilename(filename).replace(/[\u0000-\u001f\u007f]/g, "_");
  const fallback = normalized
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_") || "download";
  if (!/[^\x20-\x7e]/.test(normalized)) return `attachment; filename="${fallback}"`;
  const encoded = encodeURIComponent(normalized).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function createFileDeliveryRouteHandler(dependencies: FileDeliveryRouteDependencies) {
  const rateLimit = dependencies.checkRateLimit ?? checkRateLimit;
  const observability = dependencies.observability ?? NOOP_HTTP_OBSERVABILITY;
  return async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
    return observability.run(request, "job_file", "GET", async (observation) => {
      try {
        const rateLimitResult = rateLimit({ bucket: "file", headers: request.headers });
        if (!rateLimitResult.ok) {
          observation.log("info", "job.file.rejected", {
            outcome: "rejected",
            reasonCode: "rate_limited",
            errorCategory: "validation"
          });
          return NextResponse.json(createApiErrorResponse(rateLimitResult.code, rateLimitResult.message, rateLimitResult.error.details), {
            status: 429,
            headers: { "Retry-After": String(rateLimitResult.retryAfterSeconds) }
          });
        }

        const { id } = await context.params;
        if (!isValidFileId(id)) {
          observation.log("info", "job.file.rejected", {
            outcome: "rejected",
            reasonCode: "invalid_request",
            errorCategory: "validation"
          });
          return errorResponse("DOWNLOAD_FAILED", "Некорректный идентификатор файла.", 400);
        }
        const file = await dependencies.getFile(id);
        if (!file) {
          observation.log("info", "job.file.rejected", {
            outcome: "rejected",
            reasonCode: "job_not_found",
            errorCategory: "validation"
          });
          return errorResponse("DOWNLOAD_FAILED", "Файл не найден или срок хранения истёк.", 404);
        }
        observation.log("info", "job.file.requested", { outcome: "success", reasonCode: "none" });
        return new NextResponse(Readable.toWeb(file.stream) as BodyInit, {
          status: 200,
          headers: {
            "Content-Type": file.contentType,
            "Content-Length": String(file.sizeBytes),
            "Content-Disposition": contentDisposition(file.filename),
            "Cache-Control": "private, max-age=0, no-store",
            "X-Content-Type-Options": "nosniff"
          }
        });
      } catch {
        observation.log("warn", "job.file.rejected", {
          outcome: "failure",
          reasonCode: "internal_error",
          errorCategory: "internal"
        });
        return errorResponse("INTERNAL_ERROR");
      }
    });
  };
}
