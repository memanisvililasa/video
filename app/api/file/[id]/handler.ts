import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { Readable } from "node:stream";
import { API_ERROR_CODES, API_ERROR_STATUS, createApiErrorResponse } from "@/lib/errors";
import { checkRateLimit } from "@/lib/security/rate-limit";
import type { DeliverableMediaFile } from "@/lib/storage/file-delivery";
import type { RateLimitKeyInput, RateLimitResult } from "@/lib/security/rate-limit";

export type FileDeliveryRouteDependencies = Readonly<{
  getFile: (fileId: string) => Promise<DeliverableMediaFile | null>;
  checkRateLimit?: (input: RateLimitKeyInput) => RateLimitResult;
}>;

function errorResponse(code: keyof typeof API_ERROR_CODES, message?: string, status = API_ERROR_STATUS[code]) {
  return NextResponse.json(createApiErrorResponse(API_ERROR_CODES[code], message), { status });
}

function isValidFileId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{8,128}$/.test(id);
}

export function createFileDeliveryRouteHandler(dependencies: FileDeliveryRouteDependencies) {
  const rateLimit = dependencies.checkRateLimit ?? checkRateLimit;
  return async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
    try {
      const rateLimitResult = rateLimit({ bucket: "file", headers: request.headers });
      if (!rateLimitResult.ok) {
        return NextResponse.json(createApiErrorResponse(rateLimitResult.code, rateLimitResult.message, rateLimitResult.error.details), {
          status: 429,
          headers: { "Retry-After": String(rateLimitResult.retryAfterSeconds) }
        });
      }

      const { id } = await context.params;
      if (!isValidFileId(id)) {
        return errorResponse("DOWNLOAD_FAILED", "Некорректный идентификатор файла.", 400);
      }
      const file = await dependencies.getFile(id);
      if (!file) {
        return errorResponse("DOWNLOAD_FAILED", "Файл не найден или срок хранения истёк.", 404);
      }
      return new NextResponse(Readable.toWeb(file.stream) as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": file.contentType,
          "Content-Length": String(file.sizeBytes),
          "Content-Disposition": `attachment; filename="${file.filename.replace(/["\\]/g, "_")}"`,
          "Cache-Control": "private, max-age=0, no-store",
          "X-Content-Type-Options": "nosniff"
        }
      });
    } catch {
      return errorResponse("INTERNAL_ERROR");
    }
  };
}
