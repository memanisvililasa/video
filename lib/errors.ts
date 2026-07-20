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
  INVALID_REQUEST: "Проверьте данные запроса и повторите попытку.",
  RIGHTS_NOT_CONFIRMED: "Подтвердите права на загрузку этого контента.",
  UNSUPPORTED_PRESET: "Выбранный режим обработки не поддерживается.",
  INVALID_FORMAT: "Выбран некорректный формат медиа.",
  INVALID_URL: "Укажите корректную HTTP(S)-ссылку на видео.",
  UNSUPPORTED_PLATFORM: "Эта видеоплатформа не поддерживается.",
  UNSUPPORTED_URL: "Этот источник пока не поддерживается.",
  PRIVATE_OR_LOCAL_URL: "Локальные и внутренние адреса не поддерживаются.",
  AUTH_REQUIRED: "Видео требует авторизации и не может быть обработано.",
  PROTECTED_CONTENT: "Защищённый или приватный контент не поддерживается.",
  RATE_LIMITED: "Слишком много запросов. Повторите попытку позже.",
  FILE_TOO_LARGE: "Файл превышает допустимый размер.",
  VIDEO_TOO_LONG: "Видео превышает допустимую длительность.",
  VIDEO_RESOLUTION_TOO_HIGH: "Разрешение видео превышает допустимое.",
  EXTRACTION_FAILED: "Не удалось получить данные видео.",
  CONTENT_UNAVAILABLE: "Видео удалено или недоступно.",
  LOGIN_REQUIRED: "Для этого видео требуется авторизация.",
  PRIVATE_CONTENT: "Приватный контент не поддерживается.",
  MEMBERS_ONLY: "Видео только для участников или платных подписчиков не поддерживается.",
  DRM_PROTECTED: "Видео защищено DRM и не поддерживается.",
  GEO_RESTRICTED: "Видео недоступно в текущем регионе.",
  REGION_RESTRICTED: "Видео недоступно в текущем регионе.",
  AGE_RESTRICTED: "Видео требует подтверждения возраста и не поддерживается.",
  CAPTCHA_OR_BOT_CHALLENGE: "Источник требует дополнительной проверки и не может быть обработан.",
  PHOTO_POST_NOT_SUPPORTED: "Публикации с фотографиями и карусели не поддерживаются.",
  LIVE_NOT_SUPPORTED: "Прямые эфиры и премьеры не поддерживаются.",
  PLAYLIST_NOT_SUPPORTED: "Плейлисты и подборки не поддерживаются.",
  EXTERNAL_MEDIA_NOT_SUPPORTED: "Пост содержит видео с неподдерживаемого внешнего источника.",
  POST_HAS_NO_VIDEO: "Пост не содержит поддерживаемого видео.",
  GALLERY_NOT_SUPPORTED: "Галереи Reddit не поддерживаются.",
  SOURCE_HAS_NO_AUDIO: "Исходное видео не содержит аудиодорожку.",
  NO_SUPPORTED_FORMAT: "Для видео не найден безопасный поддерживаемый формат.",
  EXTRACTOR_TIMEOUT: "Получение данных видео превысило допустимое время.",
  EXTRACTOR_FAILED: "Не удалось получить данные страницы видео.",
  SOURCE_EXPIRED: "Ссылка на источник истекла. Повторите анализ видео.",
  DOWNLOAD_FAILED: "Не удалось подготовить файл.",
  MERGE_FAILED: "Не удалось объединить видео и аудио.",
  OUTPUT_INVALID: "Полученный медиафайл не прошёл проверку.",
  FFMPEG_NOT_AVAILABLE: "Сервис обработки медиа временно недоступен.",
  FFPROBE_FAILED: "Не удалось проверить медиафайл.",
  INVALID_MEDIA_FILE: "Файл повреждён или не является поддерживаемым медиафайлом.",
  AUDIO_STREAM_NOT_FOUND: "В медиафайле не найдена аудиодорожка.",
  UNSUPPORTED_CODEC: "Кодек не поддерживается выбранным режимом обработки.",
  PROCESSING_FAILED: "Не удалось обработать медиафайл.",
  PROCESSING_TIMEOUT: "Обработка медиафайла превысила допустимое время.",
  OUTPUT_TOO_LARGE: "Подготовленный файл превышает допустимый размер.",
  JOB_CANCELLED: "Задание было отменено.",
  JOB_NOT_FOUND: "Задание не найдено или срок его хранения истёк.",
  QUEUE_FULL: "Очередь обработки заполнена. Повторите попытку позже.",
  INVALID_JOB_STATE: "Операция недоступна для текущего состояния задания.",
  INTERNAL_ERROR: "Попробуйте позже."
};

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  INVALID_REQUEST: 400,
  RIGHTS_NOT_CONFIRMED: 403,
  UNSUPPORTED_PRESET: 422,
  INVALID_FORMAT: 422,
  INVALID_URL: 400,
  UNSUPPORTED_PLATFORM: 400,
  UNSUPPORTED_URL: 400,
  PRIVATE_OR_LOCAL_URL: 400,
  AUTH_REQUIRED: 401,
  PROTECTED_CONTENT: 403,
  RATE_LIMITED: 429,
  FILE_TOO_LARGE: 413,
  VIDEO_TOO_LONG: 422,
  VIDEO_RESOLUTION_TOO_HIGH: 422,
  EXTRACTION_FAILED: 502,
  CONTENT_UNAVAILABLE: 404,
  LOGIN_REQUIRED: 401,
  PRIVATE_CONTENT: 403,
  MEMBERS_ONLY: 403,
  DRM_PROTECTED: 403,
  GEO_RESTRICTED: 403,
  REGION_RESTRICTED: 403,
  AGE_RESTRICTED: 403,
  CAPTCHA_OR_BOT_CHALLENGE: 403,
  PHOTO_POST_NOT_SUPPORTED: 422,
  LIVE_NOT_SUPPORTED: 422,
  PLAYLIST_NOT_SUPPORTED: 422,
  EXTERNAL_MEDIA_NOT_SUPPORTED: 422,
  POST_HAS_NO_VIDEO: 422,
  GALLERY_NOT_SUPPORTED: 422,
  SOURCE_HAS_NO_AUDIO: 422,
  NO_SUPPORTED_FORMAT: 422,
  EXTRACTOR_TIMEOUT: 504,
  EXTRACTOR_FAILED: 502,
  SOURCE_EXPIRED: 410,
  DOWNLOAD_FAILED: 500,
  MERGE_FAILED: 500,
  OUTPUT_INVALID: 422,
  FFMPEG_NOT_AVAILABLE: 503,
  FFPROBE_FAILED: 500,
  INVALID_MEDIA_FILE: 422,
  AUDIO_STREAM_NOT_FOUND: 422,
  UNSUPPORTED_CODEC: 415,
  PROCESSING_FAILED: 500,
  PROCESSING_TIMEOUT: 504,
  OUTPUT_TOO_LARGE: 413,
  JOB_CANCELLED: 409,
  JOB_NOT_FOUND: 404,
  QUEUE_FULL: 503,
  INVALID_JOB_STATE: 409,
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
