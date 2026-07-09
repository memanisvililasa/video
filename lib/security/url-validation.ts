import { createApiError } from "@/lib/errors";
import { API_ERROR_CODES, type ApiError } from "@/lib/types";
import { normalizeInputString, validateNoControlCharacters } from "@/lib/security/sanitize";
import { checkHostnameSafety } from "@/lib/security/ssrf";

const DEFAULT_MAX_URL_LENGTH = 2048;

export type UrlValidationSuccess = {
  ok: true;
  url: URL;
  hostname: string;
  normalizedUrl: string;
};

export type UrlValidationFailure = {
  ok: false;
  error: ApiError;
  code: ApiError["code"];
  message: string;
};

export type UrlValidation = UrlValidationSuccess | UrlValidationFailure;

export type ValidateVideoUrlOptions = {
  maxLength?: number;
  allowedPorts?: readonly string[];
};

function urlFailure(code: ApiError["code"], message: string): UrlValidationFailure {
  const error = createApiError(code, message);
  return { ok: false, error, code: error.code, message: error.message };
}

export function validateVideoUrl(value: unknown, options: ValidateVideoUrlOptions = {}): UrlValidation {
  if (typeof value !== "string") {
    return urlFailure(API_ERROR_CODES.INVALID_URL, "Укажите ссылку на видео.");
  }

  const controlCharacters = validateNoControlCharacters(value);
  if (!controlCharacters.ok) {
    return urlFailure(API_ERROR_CODES.INVALID_URL, "Ссылка содержит недопустимые управляющие символы.");
  }

  const normalizedInput = normalizeInputString(value);
  if (!normalizedInput.ok || !normalizedInput.value) {
    return urlFailure(API_ERROR_CODES.INVALID_URL, "Укажите ссылку на видео.");
  }

  const maxLength = options.maxLength ?? DEFAULT_MAX_URL_LENGTH;
  if (normalizedInput.value.length > maxLength) {
    return urlFailure(API_ERROR_CODES.INVALID_URL, "Ссылка превышает допустимую длину.");
  }

  let url: URL;
  try {
    url = new URL(normalizedInput.value);
  } catch {
    return urlFailure(API_ERROR_CODES.INVALID_URL, "Введите корректную ссылку формата https://…");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return urlFailure(API_ERROR_CODES.INVALID_URL, "Разрешены только HTTP(S)-ссылки.");
  }

  if (url.username || url.password) {
    return urlFailure(API_ERROR_CODES.INVALID_URL, "Ссылка не должна содержать логин или пароль.");
  }

  if (!url.hostname) {
    return urlFailure(API_ERROR_CODES.INVALID_URL, "Hostname отсутствует.");
  }

  const allowedPorts = options.allowedPorts ?? ["", "80", "443"];
  if (!allowedPorts.includes(url.port)) {
    return urlFailure(API_ERROR_CODES.INVALID_URL, "Ссылка содержит недопустимый порт.");
  }

  const hostSafety = checkHostnameSafety(url.hostname);
  if (!hostSafety.ok) {
    return { ok: false, error: hostSafety.error, code: hostSafety.code, message: hostSafety.message };
  }

  url.hostname = hostSafety.hostname;
  url.hash = "";

  return {
    ok: true,
    url,
    hostname: hostSafety.hostname,
    normalizedUrl: url.toString()
  };
}
