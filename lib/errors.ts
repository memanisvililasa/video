import { API_ERROR_CODES, type ApiError, type ApiErrorCode, type ApiResponse, type ApiSuccess } from "@/lib/types";

export { API_ERROR_CODES };

type LegacyApiErrorCode = "PUBLIC_ACCESS_DENIED" | "METADATA_FAILED" | "VALIDATION_ERROR" | "NOT_IMPLEMENTED";
type AppErrorCode = ApiErrorCode | LegacyApiErrorCode;

const LEGACY_ERROR_CODE_MAP: Record<LegacyApiErrorCode, ApiErrorCode> = {
  PUBLIC_ACCESS_DENIED: API_ERROR_CODES.PROTECTED_CONTENT,
  METADATA_FAILED: API_ERROR_CODES.EXTRACTION_FAILED,
  VALIDATION_ERROR: API_ERROR_CODES.INVALID_URL,
  NOT_IMPLEMENTED: API_ERROR_CODES.INTERNAL_ERROR
};

function isLegacyErrorCode(code: AppErrorCode): code is LegacyApiErrorCode {
  return Object.prototype.hasOwnProperty.call(LEGACY_ERROR_CODE_MAP, code);
}

export const API_ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  INVALID_URL: "Укажите корректную HTTP(S)-ссылку на видео.",
  UNSUPPORTED_URL: "Этот источник пока не поддерживается.",
  PRIVATE_OR_LOCAL_URL: "Локальные и внутренние адреса не поддерживаются.",
  AUTH_REQUIRED: "Видео требует авторизации и не может быть обработано.",
  PROTECTED_CONTENT: "Защищённый или приватный контент не поддерживается.",
  RATE_LIMITED: "Слишком много запросов. Повторите попытку позже.",
  FILE_TOO_LARGE: "Файл превышает допустимый размер.",
  VIDEO_TOO_LONG: "Видео превышает допустимую длительность.",
  EXTRACTION_FAILED: "Не удалось получить данные видео.",
  DOWNLOAD_FAILED: "Не удалось подготовить файл.",
  INTERNAL_ERROR: "Попробуйте позже."
};

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  INVALID_URL: 400,
  UNSUPPORTED_URL: 400,
  PRIVATE_OR_LOCAL_URL: 400,
  AUTH_REQUIRED: 401,
  PROTECTED_CONTENT: 403,
  RATE_LIMITED: 429,
  FILE_TOO_LARGE: 413,
  VIDEO_TOO_LONG: 422,
  EXTRACTION_FAILED: 502,
  DOWNLOAD_FAILED: 500,
  INTERNAL_ERROR: 500
};

function normalizeErrorCode(code: AppErrorCode): ApiErrorCode {
  return isLegacyErrorCode(code) ? LEGACY_ERROR_CODE_MAP[code] : code;
}

export class AppError extends Error {
  public readonly code: ApiErrorCode;

  constructor(
    code: AppErrorCode,
    message?: string,
    public readonly status?: number,
    public readonly details?: Record<string, unknown>
  ) {
    const normalizedCode = normalizeErrorCode(code);
    super(message ?? API_ERROR_MESSAGES[normalizedCode]);
    this.name = "AppError";
    this.code = normalizedCode;
  }
}

export function createApiError(code: ApiErrorCode, message = API_ERROR_MESSAGES[code], details?: Record<string, unknown>): ApiError {
  return details ? { code, message, details } : { code, message };
}

export function createApiErrorResponse(code: ApiErrorCode, message?: string, details?: Record<string, unknown>): ApiResponse<never> {
  return {
    ok: false,
    error: createApiError(code, message ?? API_ERROR_MESSAGES[code], details)
  };
}

export function createApiSuccessResponse<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

export function getApiErrorStatus(error: unknown): number {
  if (error instanceof AppError) {
    return error.status ?? API_ERROR_STATUS[error.code];
  }

  return API_ERROR_STATUS.INTERNAL_ERROR;
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof AppError) {
    return createApiError(error.code, error.message, error.details);
  }

  return createApiError(API_ERROR_CODES.INTERNAL_ERROR);
}

export function toApiErrorResponse(error: unknown): ApiResponse<never> {
  return {
    ok: false,
    error: toApiError(error)
  };
}
