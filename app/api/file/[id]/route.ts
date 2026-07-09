import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { API_ERROR_CODES, API_ERROR_STATUS, createApiErrorResponse } from "@/lib/errors";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { getPreparedFile } from "@/lib/storage/local-storage";

function errorResponse(code: keyof typeof API_ERROR_CODES, message?: string, status = API_ERROR_STATUS[code]) {
  return NextResponse.json(createApiErrorResponse(API_ERROR_CODES[code], message), { status });
}

function isValidFileId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{8,128}$/.test(id);
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const rateLimit = checkRateLimit({ bucket: "file", headers: request.headers });
    if (!rateLimit.ok) {
      return NextResponse.json(createApiErrorResponse(rateLimit.code, rateLimit.message, rateLimit.error.details), {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.retryAfterSeconds)
        }
      });
    }

    const { id } = await context.params;
    if (!isValidFileId(id)) {
      return errorResponse("DOWNLOAD_FAILED", "Некорректный идентификатор файла.", 400);
    }

    const file = await getPreparedFile(id);
    if (!file) {
      return errorResponse("DOWNLOAD_FAILED", "Файл не найден или срок хранения истёк.", 404);
    }

    const stream = Readable.toWeb(createReadStream(file.path));
    return new NextResponse(stream as BodyInit, {
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
}
