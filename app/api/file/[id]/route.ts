import { NextRequest, NextResponse } from "next/server";
import { API_ERROR_CODES, API_ERROR_STATUS, createApiErrorResponse } from "@/lib/errors";
import { checkRateLimit } from "@/lib/security/rate-limit";

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

    return errorResponse("DOWNLOAD_FAILED", "Реальная отдача файла ещё не реализована.", 501);
  } catch {
    return errorResponse("INTERNAL_ERROR");
  }
}
