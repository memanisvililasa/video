"use client";

import { FormEvent, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { StatusMessage } from "@/components/status-message";
import { VideoResultCard } from "@/components/video-result-card";
import type { CreateDownloadJobData, CreateDownloadJobRequest } from "@/lib/api/media-job-dto";
import {
  INITIAL_MEDIA_DOWNLOAD_UI_STATE,
  canDownloadFile,
  canSubmitJob,
  getSafeStatusMessage,
  getVisibleProgress,
  isJobActive,
  mediaDownloadUiReducer,
  type MediaDownloadUiState,
  type MediaSelectionData,
  type SafeUiError
} from "@/lib/client/media-job-state";
import { API_ERROR_CODES, type ApiResponse, type ExtractRequest, type ExtractResponse, type VideoFormat, type VideoMetadata } from "@/lib/types";

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

function mapMetadataToSelection(metadata: VideoMetadata): MediaSelectionData {
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
        code: API_ERROR_CODES.INTERNAL_ERROR,
        message: "API вернул некорректный ответ."
      }
    };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function postJson<TResponse>(
  path: string,
  body: ExtractRequest | CreateDownloadJobRequest,
  signal?: AbortSignal
): Promise<ApiResponse<TResponse>> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify(body)
  });

  return readApiResponse<TResponse>(response);
}

function statusTone(state: MediaDownloadUiState): "neutral" | "loading" | "success" | "error" | "warning" {
  switch (state.status) {
    case "extracting":
    case "submitting":
    case "queued":
    case "running":
    case "downloading":
      return "loading";
    case "ready":
    case "success":
      return "success";
    case "failed":
    case "network-error":
      return "error";
    case "cancelled":
    case "expired":
    case "polling-timeout":
      return "warning";
    case "idle":
    case "selection-ready":
      return "neutral";
    default: {
      const exhaustive: never = state;
      throw new TypeError(`Unsupported UI state: ${String(exhaustive)}`);
    }
  }
}

function statusTitle(state: MediaDownloadUiState): string {
  switch (state.status) {
    case "idle": return "Готово к проверке";
    case "extracting": return "Получение данных";
    case "selection-ready": return "Форматы получены";
    case "submitting": return "Создание задачи";
    case "queued": return "В очереди";
    case "running": return "Обработка";
    case "ready": return "Файл готов";
    case "downloading": return "Скачивание";
    case "success": return "Скачивание началось";
    case "failed": return "Не удалось выполнить операцию";
    case "cancelled": return "Задача отменена";
    case "expired": return "Файл недоступен";
    case "network-error": return "Ошибка соединения";
    case "polling-timeout": return "Долгая обработка";
    default: {
      const exhaustive: never = state;
      throw new TypeError(`Unsupported UI state: ${String(exhaustive)}`);
    }
  }
}

export function VideoDownloader() {
  const [url, setUrl] = useState("");
  const [uiState, dispatch] = useReducer(mediaDownloadUiReducer, INITIAL_MEDIA_DOWNLOAD_UI_STATE);
  const extractAbortRef = useRef<AbortController | null>(null);
  const submitAbortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const validationError = useMemo(() => validateUrl(url), [url]);
  const selection = "selection" in uiState ? uiState.selection : null;
  const submitAllowed = canSubmitJob(uiState);
  const canCheckLink = uiState.status !== "extracting" && !isJobActive(uiState);
  const visibleProgress = getVisibleProgress(uiState);

  function nextGeneration(): number {
    generationRef.current += 1;
    return generationRef.current;
  }

  useEffect(() => {
    return () => {
      extractAbortRef.current?.abort();
      submitAbortRef.current?.abort();
    };
  }, []);

  async function handleExtract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCheckLink) return;

    extractAbortRef.current?.abort();
    submitAbortRef.current?.abort();
    const requestGeneration = nextGeneration();
    dispatch({ type: "EXTRACT_STARTED", requestGeneration });

    const validationMessage = validateUrl(url);
    if (validationMessage) {
      dispatch({
        type: "EXTRACT_FAILED",
        requestGeneration,
        error: { code: API_ERROR_CODES.INVALID_URL, message: validationMessage }
      });
      return;
    }

    const requestBody: ExtractRequest = { url: url.trim() };
    const controller = new AbortController();
    extractAbortRef.current = controller;

    try {
      const apiResponse: ExtractResponse = await postJson<VideoMetadata>("/api/extract", requestBody, controller.signal);
      if (extractAbortRef.current !== controller) return;

      if (!apiResponse.ok) {
        const error: SafeUiError = { code: apiResponse.error.code, message: apiResponse.error.message };
        dispatch({ type: "EXTRACT_FAILED", requestGeneration, error });
        return;
      }

      dispatch({
        type: "EXTRACT_SUCCEEDED",
        requestGeneration,
        media: mapMetadataToSelection(apiResponse.data)
      });
    } catch (requestError) {
      if (isAbortError(requestError)) return;
      dispatch({ type: "NETWORK_FAILED", requestGeneration, operation: "extract" });
    } finally {
      if (extractAbortRef.current === controller) extractAbortRef.current = null;
    }
  }

  async function handleSubmitJob() {
    if (!canSubmitJob(uiState) || uiState.status !== "selection-ready") return;

    submitAbortRef.current?.abort();
    const requestGeneration = nextGeneration();
    const currentSelection = uiState.selection;
    dispatch({ type: "JOB_SUBMIT_STARTED", requestGeneration });

    const requestBody: CreateDownloadJobRequest = {
      url: url.trim(),
      formatId: currentSelection.selectedFormatId,
      processingPreset: currentSelection.processingPreset,
      rightsConfirmed: true
    };
    const controller = new AbortController();
    submitAbortRef.current = controller;

    try {
      const apiResponse = await postJson<CreateDownloadJobData>("/api/download", requestBody, controller.signal);
      if (submitAbortRef.current !== controller) return;

      if (!apiResponse.ok) {
        dispatch({
          type: "JOB_REQUEST_FAILED",
          requestGeneration,
          operation: "submit",
          network: false,
          error: { code: apiResponse.error.code, message: apiResponse.error.message }
        });
        return;
      }

      dispatch({ type: "JOB_CREATED", requestGeneration, data: apiResponse.data });
      // GET polling and DELETE cancellation are intentionally connected in 5.8.5.
    } catch (requestError) {
      if (isAbortError(requestError)) return;
      dispatch({
        type: "JOB_REQUEST_FAILED",
        requestGeneration,
        operation: "submit",
        network: true
      });
    } finally {
      if (submitAbortRef.current === controller) submitAbortRef.current = null;
    }
  }

  function handleUrlChange(value: string) {
    extractAbortRef.current?.abort();
    extractAbortRef.current = null;
    submitAbortRef.current?.abort();
    submitAbortRef.current = null;
    setUrl(value);
    dispatch({ type: "RESET", requestGeneration: nextGeneration() });
  }

  const stateMessage = getSafeStatusMessage(uiState);
  const progressSuffix = visibleProgress !== null && (uiState.status === "queued" || uiState.status === "running")
    ? ` Прогресс: ${Math.round(visibleProgress)}%.`
    : "";

  return (
    <section id="check" className="bg-[#F7F9FF] px-5 py-12 sm:px-8 sm:py-16">
      <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[minmax(0,.86fr)_minmax(420px,1.14fr)] lg:items-start">
        <div>
          <p className="text-xs font-bold uppercase tracking-[.14em] text-brand">Проверка ссылки</p>
          <h2 className="mt-3 text-3xl font-extrabold leading-tight tracking-[-.05em] text-ink sm:text-4xl">
            Скачивание начинается с проверки прав и публичной ссылки
          </h2>
          <p className="mt-4 text-sm leading-6 text-slate-600 sm:text-base">
            Вставьте URL, получите безопасные metadata из API, выберите формат и подтвердите права на контент.
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
          <form onSubmit={handleExtract} className="space-y-4">
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
                  aria-invalid={uiState.status === "failed" || uiState.status === "network-error"}
                  aria-describedby="video-url-status"
                  className="h-12 w-full rounded-xl border border-slate-200 bg-white pl-12 pr-4 text-sm font-medium text-ink outline-none transition placeholder:text-slate-400 focus:border-brand focus:ring-4 focus:ring-blue-100"
                />
              </div>
              <button
                type="submit"
                disabled={!canCheckLink}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-brand px-5 text-sm font-bold text-white transition hover:bg-[#254FDD] disabled:cursor-not-allowed disabled:bg-slate-300 sm:min-w-40"
              >
                <Icon name={uiState.status === "extracting" ? "sparkle" : "arrow"} className="h-4 w-4" />
                {uiState.status === "extracting" ? "Анализируем" : "Проверить ссылку"}
              </button>
            </div>

            <div id="video-url-status">
              {uiState.status === "idle" && validationError && url.trim().length > 0 ? (
                <StatusMessage tone="neutral" title="Проверьте формат" text={validationError} />
              ) : uiState.status !== "idle" ? (
                <StatusMessage
                  tone={statusTone(uiState)}
                  title={statusTitle(uiState)}
                  text={`${stateMessage}${progressSuffix}`}
                />
              ) : null}
            </div>
          </form>

          {selection && (uiState.status === "selection-ready" || uiState.status === "submitting") && (
            <div className="mt-5">
              <VideoResultCard
                result={selection.media}
                selectedQuality={selection.selectedFormatId}
                rightsConfirmed={selection.rightsConfirmed}
                isSubmitting={uiState.status === "submitting"}
                canSubmit={submitAllowed}
                onQualityChange={(formatId) => dispatch({ type: "SELECTION_UPDATED", formatId })}
                onRightsChange={(rightsConfirmed) => dispatch({ type: "RIGHTS_UPDATED", rightsConfirmed })}
                onSubmit={handleSubmitJob}
              />
            </div>
          )}

          {uiState.status === "ready" && canDownloadFile(uiState) && (
            <a
              href={uiState.result.downloadUrl}
              download={uiState.result.filename}
              onClick={() => dispatch({ type: "DOWNLOAD_STARTED", jobId: uiState.jobId })}
              className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 text-sm font-bold text-white transition hover:bg-[#254FDD]"
            >
              <Icon name="download" className="h-4 w-4" />
              Скачать файл
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
