"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { StatusMessage } from "@/components/status-message";
import { VideoResultCard, type VideoResult } from "@/components/video-result-card";
import type { ApiResponse, DownloadFile, DownloadJob, DownloadRequest, DownloadResponse, ExtractRequest, ExtractResponse, VideoFormat, VideoMetadata } from "@/lib/types";

type DownloaderState = "idle" | "validating" | "extracting" | "ready" | "downloading" | "success" | "error";
type DownloadPayload = {
  job: DownloadJob;
  file?: DownloadFile;
};

function validateUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Вставьте ссылку на публичное видео.";

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "Введите корректный URL, например https://example.com/video.";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Разрешены только ссылки http:// или https://.";
  }

  return null;
}

function formatDuration(seconds?: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "Длительность неизвестна";
  const rounded = Math.floor(seconds);
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatQuality(format: VideoFormat): string {
  const parts = [format.quality, format.ext.toUpperCase()].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : format.label;
}

function formatMeta(format: VideoFormat): string {
  const media = [format.hasVideo ? "видео" : null, format.hasAudio ? "аудио" : null].filter(Boolean).join(" + ");
  const size = format.width && format.height ? `${format.width}x${format.height}` : null;
  return [media || "медиа", size].filter(Boolean).join(" · ");
}

function mapMetadataToResult(metadata: VideoMetadata): VideoResult {
  return {
    platform: metadata.platform,
    title: metadata.title,
    duration: formatDuration(metadata.durationSeconds),
    qualities: metadata.formats.map((format) => ({
      id: format.id,
      label: formatQuality(format),
      meta: formatMeta(format)
    }))
  };
}

async function readApiResponse<T>(response: Response): Promise<ApiResponse<T>> {
  try {
    return await response.json() as ApiResponse<T>;
  } catch {
    return {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "API вернул некорректный ответ."
      }
    };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function formatDownloadMessage(payload: DownloadPayload): string {
  const baseMessage = payload.job.message ?? `Download API принял stub-задание ${payload.job.id}.`;
  if (!payload.file) {
    return `${baseMessage} Реальный серверный download pipeline будет добавлен позже.`;
  }

  return `${baseMessage} Stub-файл: ${payload.file.filename}. Автоматическая отдача через /api/file/[id] отключена до реализации файлового endpoint.`;
}

async function postJson<TResponse>(path: string, body: ExtractRequest | DownloadRequest, signal?: AbortSignal): Promise<ApiResponse<TResponse>> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "omit",
    headers: {
      "Content-Type": "application/json"
    },
    signal,
    body: JSON.stringify(body)
  });

  return readApiResponse<TResponse>(response);
}

export function VideoDownloader() {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<DownloaderState>("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<VideoResult | null>(null);
  const [selectedQuality, setSelectedQuality] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState("");
  const extractAbortRef = useRef<AbortController | null>(null);
  const downloadAbortRef = useRef<AbortController | null>(null);

  const validationError = useMemo(() => validateUrl(url), [url]);
  const canSubmit = state !== "validating" && state !== "extracting" && state !== "downloading";

  useEffect(() => {
    return () => {
      extractAbortRef.current?.abort();
      downloadAbortRef.current?.abort();
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    extractAbortRef.current?.abort();
    downloadAbortRef.current?.abort();

    const message = validateUrl(url);
    setError("");
    setDownloadMessage("");
    setResult(null);
    setSelectedQuality("");
    setRightsConfirmed(false);

    if (message) {
      setError(message);
      setState("error");
      return;
    }

    setState("validating");

    const requestBody: ExtractRequest = { url: url.trim() };
    const controller = new AbortController();
    extractAbortRef.current = controller;
    setState("extracting");

    try {
      const apiResponse: ExtractResponse = await postJson<VideoMetadata>("/api/extract", requestBody, controller.signal);
      if (extractAbortRef.current !== controller) return;

      if (!apiResponse.ok) {
        setError(apiResponse.error.message);
        setState("error");
        return;
      }

      const nextResult = mapMetadataToResult(apiResponse.data);
      if (nextResult.qualities.length === 0) {
        setError("API не вернул доступные форматы.");
        setState("error");
        return;
      }

      setResult(nextResult);
      setSelectedQuality(nextResult.qualities[0].id);
      setState("ready");
    } catch (requestError) {
      if (isAbortError(requestError)) return;
      setError("Не удалось связаться с API проверки ссылки.");
      setState("error");
    } finally {
      if (extractAbortRef.current === controller) {
        extractAbortRef.current = null;
      }
    }
  }

  async function handleDownload() {
    if (!rightsConfirmed || !selectedQuality) return;
    if (state === "downloading") return;

    downloadAbortRef.current?.abort();

    setError("");
    setDownloadMessage("");
    setState("downloading");

    const requestBody: DownloadRequest = {
      url: url.trim(),
      formatId: selectedQuality
    };
    const controller = new AbortController();
    downloadAbortRef.current = controller;

    try {
      const apiResponse: DownloadResponse = await postJson<DownloadPayload>("/api/download", requestBody, controller.signal);
      if (downloadAbortRef.current !== controller) return;

      if (!apiResponse.ok) {
        setError(apiResponse.error.message);
        setState("error");
        return;
      }

      setDownloadMessage(formatDownloadMessage(apiResponse.data));
      setState("success");
    } catch (requestError) {
      if (isAbortError(requestError)) return;
      setError("Не удалось связаться с API подготовки файла.");
      setState("error");
    } finally {
      if (downloadAbortRef.current === controller) {
        downloadAbortRef.current = null;
      }
    }
  }

  function handleUrlChange(value: string) {
    extractAbortRef.current?.abort();
    extractAbortRef.current = null;
    downloadAbortRef.current?.abort();
    downloadAbortRef.current = null;
    setUrl(value);
    setError("");
    setDownloadMessage("");
    setResult(null);
    setSelectedQuality("");
    setRightsConfirmed(false);
    if (state !== "idle") setState("idle");
  }

  return (
    <section id="check" className="bg-[#F7F9FF] px-5 py-12 sm:px-8 sm:py-16">
      <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[minmax(0,.86fr)_minmax(420px,1.14fr)] lg:items-start">
        <div>
          <p className="text-xs font-bold uppercase tracking-[.14em] text-brand">Проверка ссылки</p>
          <h2 className="mt-3 text-3xl font-extrabold leading-tight tracking-[-.05em] text-ink sm:text-4xl">
            Скачивание начинается с проверки прав и публичной ссылки
          </h2>
          <p className="mt-4 text-sm leading-6 text-slate-600 sm:text-base">
            Вставьте URL, получите безопасные metadata из API skeleton, выберите формат и подтвердите права на контент.
          </p>
          <div className="mt-6">
            <StatusMessage
              tone="warning"
              title="Правовое предупреждение"
              text="Скачивайте только свои видео или контент, на который у вас есть разрешение."
            />
          </div>
        </div>

        <div className="rounded-2xl border border-blue-100 bg-white p-4 shadow-soft sm:p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <label htmlFor="video-url" className="block text-sm font-bold text-ink">
              Ссылка на видео
            </label>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <div className="relative">
                <Icon name="link" className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
                <input
                  id="video-url"
                  type="url"
                  inputMode="url"
                  value={url}
                  onChange={(event) => handleUrlChange(event.target.value)}
                  placeholder="https://example.com/video"
                  aria-invalid={state === "error"}
                  aria-describedby="video-url-status"
                  className="h-12 w-full rounded-xl border border-slate-200 bg-white pl-12 pr-4 text-sm font-medium text-ink outline-none transition placeholder:text-slate-400 focus:border-brand focus:ring-4 focus:ring-blue-100"
                />
              </div>
              <button
                type="submit"
                disabled={!canSubmit}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-brand px-5 text-sm font-bold text-white transition hover:bg-[#254FDD] disabled:cursor-not-allowed disabled:bg-slate-300 sm:min-w-40"
              >
                <Icon name={state === "validating" || state === "extracting" ? "sparkle" : "arrow"} className="h-4 w-4" />
                {state === "validating" ? "Проверяем" : state === "extracting" ? "Анализируем" : "Проверить ссылку"}
              </button>
            </div>

            <div id="video-url-status">
              {state === "idle" && validationError && url.trim().length > 0 && (
                <StatusMessage tone="neutral" title="Проверьте формат" text={validationError} />
              )}
              {state === "validating" && <StatusMessage tone="loading" title="Валидация URL" text="Проверяем формат ссылки и допустимый протокол." />}
              {state === "extracting" && <StatusMessage tone="loading" title="Получение данных" text="Запрашиваем безопасные stub metadata через /api/extract." />}
              {state === "error" && <StatusMessage tone="error" title="Ссылка не прошла проверку" text={error} />}
              {state === "success" && (
                <StatusMessage tone="success" title="API skeleton ответил" text={downloadMessage || "Запрос обработан в безопасном stub-режиме без создания файла."} />
              )}
            </div>
          </form>

          {result && (state === "ready" || state === "downloading" || state === "success") && (
            <div className="mt-5">
              <VideoResultCard
                result={result}
                selectedQuality={selectedQuality}
                rightsConfirmed={rightsConfirmed}
                isDownloading={state === "downloading"}
                onQualityChange={setSelectedQuality}
                onRightsChange={setRightsConfirmed}
                onDownload={handleDownload}
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
