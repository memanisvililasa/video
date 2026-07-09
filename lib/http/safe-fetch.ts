import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { AppError } from "@/lib/errors";
import { API_ERROR_CODES } from "@/lib/types";
import { validateOutboundHostname, validateRedirectHostname } from "@/lib/security/ssrf";

const DEFAULT_METADATA_TIMEOUT_SECONDS = 10;
const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_REDIRECTS = 3;
const USER_AGENT = "VideoSave-SafeFetcher/1.0";

export type SafeHeaders = Record<string, string>;

export type SafeFetchOptions = {
  timeoutSeconds?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
};

export type SafeResponseMetadata = {
  finalUrl: URL;
  statusCode: number;
  headers: SafeHeaders;
  contentType?: string;
  contentLength?: number;
};

export type SafeDownloadOptions = SafeFetchOptions & {
  maxBytes: number;
};

export type SafeDownloadResult = SafeResponseMetadata & {
  sizeBytes: number;
};

type RequestMethod = "HEAD" | "GET";

type RequestResult = SafeResponseMetadata & {
  stream?: http.IncomingMessage;
};

type RequestLookupOptions = {
  all?: boolean;
};

type RequestLookupCallback = (error: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: 4 | 6 }>, family?: 4 | 6) => void;

function assertSafeUrl(url: URL, redirect = false): URL {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(API_ERROR_CODES.INVALID_URL, "Разрешены только HTTP(S)-ссылки.", 400);
  }

  if (url.username || url.password) {
    throw new AppError(API_ERROR_CODES.INVALID_URL, "Ссылка не должна содержать логин или пароль.", 400);
  }

  const safety = redirect ? validateRedirectHostname(url.hostname) : validateOutboundHostname(url.hostname);
  if (!safety.ok) {
    throw new AppError(safety.code, safety.message, 400);
  }

  return url;
}

function normalizeHeaderValue(value: string | string[] | number | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") return String(value);
  return value;
}

function normalizeHeaders(headers: http.IncomingHttpHeaders): SafeHeaders {
  const normalized: SafeHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const headerValue = normalizeHeaderValue(value);
    if (headerValue !== undefined) normalized[key.toLowerCase()] = headerValue;
  }
  return normalized;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isRedirectStatus(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

function getRequestModule(url: URL): typeof http | typeof https {
  return url.protocol === "https:" ? https : http;
}

async function resolveSafeAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const outboundSafety = validateOutboundHostname(hostname);
  if (!outboundSafety.ok) {
    throw new AppError(outboundSafety.code, outboundSafety.message, 400);
  }

  let addresses;
  try {
    addresses = await lookup(outboundSafety.hostname, { all: true, verbatim: false });
  } catch {
    throw new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Не удалось проверить адрес источника.", 502);
  }

  if (addresses.length === 0) {
    throw new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Не удалось проверить адрес источника.", 502);
  }

  for (const address of addresses) {
    const addressSafety = validateOutboundHostname(address.address);
    if (!addressSafety.ok) {
      throw new AppError(addressSafety.code, addressSafety.message, 400);
    }
  }

  const [first] = addresses;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

function getRedirectTarget(currentUrl: URL, location: string | undefined): URL {
  if (!location) {
    throw new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Источник вернул redirect без Location.", 502);
  }

  let target: URL;
  try {
    target = new URL(location, currentUrl);
  } catch {
    throw new AppError(API_ERROR_CODES.INVALID_URL, "Источник вернул некорректный redirect.", 400);
  }

  target.hash = "";
  return assertSafeUrl(target, true);
}

function createAbortError(): AppError {
  return new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Запрос к источнику был остановлен.", 502);
}

async function requestOnce(url: URL, method: RequestMethod, headers: SafeHeaders, options: Required<SafeFetchOptions>): Promise<RequestResult> {
  assertSafeUrl(url);
  const resolved = await resolveSafeAddress(url.hostname);

  return new Promise<RequestResult>((resolve, reject) => {
    if (options.signal.aborted) {
      reject(createAbortError());
      return;
    }

    const transport = getRequestModule(url);
    const request = transport.request(
      url,
      {
        method,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "*/*",
          Connection: "close",
          ...headers
        },
        lookup: (_hostname, lookupOptions, callback) => {
          const options = typeof lookupOptions === "object" && lookupOptions !== null ? lookupOptions as RequestLookupOptions : {};
          const done = callback as RequestLookupCallback;
          if (options.all) {
            done(null, [resolved]);
            return;
          }

          done(null, resolved.address, resolved.family);
        },
        timeout: options.timeoutSeconds * 1000
      },
      (response) => {
        const normalizedHeaders = normalizeHeaders(response.headers);
        resolve({
          finalUrl: url,
          statusCode: response.statusCode ?? 0,
          headers: normalizedHeaders,
          contentType: normalizedHeaders["content-type"]?.split(";")[0]?.trim().toLowerCase(),
          contentLength: parseContentLength(normalizedHeaders["content-length"]),
          stream: response
        });
      }
    );

    const abort = () => {
      request.destroy(createAbortError());
    };

    options.signal.addEventListener("abort", abort, { once: true });

    request.on("timeout", () => {
      request.destroy(new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Источник не ответил вовремя.", 504));
    });

    request.on("error", (error) => {
      options.signal.removeEventListener("abort", abort);
      reject(error instanceof AppError ? error : new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Не удалось получить ответ источника.", 502));
    });

    request.on("close", () => {
      options.signal.removeEventListener("abort", abort);
    });

    request.end();
  });
}

async function requestWithRedirects(
  initialUrl: URL,
  method: RequestMethod,
  headers: SafeHeaders,
  options: SafeFetchOptions
): Promise<RequestResult> {
  const requestOptions: Required<SafeFetchOptions> = {
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_METADATA_TIMEOUT_SECONDS,
    maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    signal: options.signal ?? new AbortController().signal
  };

  let currentUrl = assertSafeUrl(new URL(initialUrl.toString()));
  for (let redirectCount = 0; redirectCount <= requestOptions.maxRedirects; redirectCount += 1) {
    const result = await requestOnce(currentUrl, method, headers, requestOptions);

    if (!isRedirectStatus(result.statusCode)) {
      return result;
    }

    result.stream?.destroy();
    if (redirectCount === requestOptions.maxRedirects) {
      throw new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Источник вернул слишком много redirect-ов.", 502);
    }

    currentUrl = getRedirectTarget(currentUrl, result.headers.location);
  }

  throw new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Источник вернул слишком много redirect-ов.", 502);
}

function assertReadableStatus(result: SafeResponseMetadata): void {
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Источник не вернул доступный медиафайл.", 502, {
      statusCode: result.statusCode
    });
  }
}

export async function safeHead(url: URL, options: SafeFetchOptions = {}): Promise<SafeResponseMetadata> {
  const result = await requestWithRedirects(url, "HEAD", {}, {
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_METADATA_TIMEOUT_SECONDS,
    maxRedirects: options.maxRedirects,
    signal: options.signal
  });
  result.stream?.destroy();
  assertReadableStatus(result);
  return result;
}

export async function safeGetMetadata(url: URL, options: SafeFetchOptions = {}): Promise<SafeResponseMetadata> {
  const result = await requestWithRedirects(url, "GET", { Range: "bytes=0-0" }, {
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_METADATA_TIMEOUT_SECONDS,
    maxRedirects: options.maxRedirects,
    signal: options.signal
  });
  result.stream?.destroy();
  assertReadableStatus(result);
  return result;
}

export async function safeDownloadToFile(url: URL, destinationPath: string, options: SafeDownloadOptions): Promise<SafeDownloadResult> {
  const result = await requestWithRedirects(url, "GET", {}, {
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_DOWNLOAD_TIMEOUT_SECONDS,
    maxRedirects: options.maxRedirects,
    signal: options.signal
  });

  assertReadableStatus(result);

  if (typeof result.contentLength === "number" && result.contentLength > options.maxBytes) {
    result.stream?.destroy();
    throw new AppError(API_ERROR_CODES.FILE_TOO_LARGE, "Файл превышает допустимый размер.", 413);
  }

  const stream = result.stream;
  if (!stream) {
    throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED, "Источник не вернул тело файла.", 502);
  }

  const file = createWriteStream(destinationPath, { flags: "wx" });
  let sizeBytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => {
        sizeBytes += chunk.length;
        if (sizeBytes > options.maxBytes) {
          stream.destroy(new AppError(API_ERROR_CODES.FILE_TOO_LARGE, "Файл превышает допустимый размер.", 413));
        }
      });

      stream.on("error", reject);
      file.on("error", reject);
      file.on("finish", resolve);
      stream.pipe(file);
    });
  } catch (error) {
    file.destroy();
    stream.destroy();
    await rm(destinationPath, { force: true }).catch(() => undefined);
    throw error instanceof AppError ? error : new AppError(API_ERROR_CODES.DOWNLOAD_FAILED, "Не удалось сохранить файл.", 500);
  }

  return {
    ...result,
    sizeBytes
  };
}
