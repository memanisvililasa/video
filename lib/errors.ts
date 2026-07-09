import type { ApiError, ApiErrorCode } from "@/lib/types";

export class AppError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "Попробуйте позже"
  };
}
