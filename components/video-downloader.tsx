"use client";

import { FormEvent, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { StatusMessage } from "@/components/status-message";
import { VideoResultCard } from "@/components/video-result-card";
import type { CreateDownloadJobRequest } from "@/lib/api/media-job-dto";
import {
  INITIAL_MEDIA_DOWNLOAD_UI_STATE,
  MEDIA_JOB_SESSION_STORAGE_KEY,
  canRetryJobSubmit,
  canSubmitJob,
  getSafeStatusMessage,
  isJobActive,
  isTerminalState,
  mediaDownloadUiReducer,
  restoreMediaJobSession,
  serializeMediaJobSession,
  type MediaDownloadUiState,
  type MediaSelectionData,
  type SafeUiError
} from "@/lib/client/media-job-state";
import {
  createMediaJobPollingController,
  type CancellationRequestState,
  type MediaJobPollingPolicy,
  type MediaJobPollingController
} from "@/lib/client/media-job-poller";
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
  const quality = format.quality?.trim();
  if (quality?.toLowerCase() === "source") return "Исходное качество";
  return quality || format.label || "Доступное качество";
}

function formatMeta(format: VideoFormat): string {
  const resolution = format.width && format.height ? `${format.width} × ${format.height}` : null;
  const container = format.ext ? `Контейнер: ${format.ext.toUpperCase()}` : null;
  const audio = format.hasAudio === true ? "с аудио" : format.hasAudio === false ? "без аудио" : null;
  return [resolution, container, audio].filter(Boolean).join(" · ") || "Параметры источника";
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
  body: ExtractRequest,
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

function statusTone(state: MediaDownloadUiState): "info" | "progress" | "success" | "error" | "warning" {
  switch (state.status) {
    case "extracting":
    case "submitting":
    case "queued":
    case "running":
    case "downloading":
      return "progress";
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
      return "info";
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
    case "failed": return "Не удалось подготовить файл";
    case "cancelled": return "Подготовка файла отменена";
    case "expired": return "Срок хранения файла истёк";
    case "network-error": return "Не удалось получить статус задачи";
    case "polling-timeout": return "Подготовка занимает больше времени, чем ожидалось";
    default: {
      const exhaustive: never = state;
      throw new TypeError(`Unsupported UI state: ${String(exhaustive)}`);
    }
  }
}

export type VideoDownloaderProps = Readonly<{
  pollingPolicy?: Partial<MediaJobPollingPolicy>;
}>;

export function VideoDownloader({ pollingPolicy }: VideoDownloaderProps = {}) {
  const [url, setUrl] = useState("");
  const [uiState, dispatch] = useReducer(mediaDownloadUiReducer, INITIAL_MEDIA_DOWNLOAD_UI_STATE);
  const [cancellationState, setCancellationState] = useState<CancellationRequestState>({
    pending: false,
    error: null
  });
  const extractAbortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const stateRef = useRef(uiState);
  const pollingControllerRef = useRef<MediaJobPollingController | null>(null);
  const restoredJobIdRef = useRef<string | null>(null);
  stateRef.current = uiState;

  const validationError = useMemo(() => validateUrl(url), [url]);
  const selection = "selection" in uiState ? uiState.selection : null;
  const canCheckLink = uiState.status !== "extracting" && !isJobActive(uiState);

  function nextGeneration(): number {
    generationRef.current += 1;
    return generationRef.current;
  }

  useEffect(() => {
    const controller = createMediaJobPollingController({
      dispatch,
      getState: () => stateRef.current,
      fetch: (input, init) => globalThis.fetch(input, init),
      onCancellationStateChange: setCancellationState,
      policy: pollingPolicy
    });
    pollingControllerRef.current = controller;
    return () => {
      extractAbortRef.current?.abort();
      controller.dispose();
      if (pollingControllerRef.current === controller) pollingControllerRef.current = null;
    };
  }, [pollingPolicy]);

  useEffect(() => {
    try {
      const raw = globalThis.sessionStorage.getItem(MEDIA_JOB_SESSION_STORAGE_KEY);
      const restored = restoreMediaJobSession(raw);
      if (restored && "jobId" in restored && typeof restored.jobId === "string") {
        restoredJobIdRef.current = restored.jobId;
      }
      else globalThis.sessionStorage.removeItem(MEDIA_JOB_SESSION_STORAGE_KEY);
      dispatch({ type: "RESTORE_SESSION", raw, nowMs: Date.now() });
    } catch {
      restoredJobIdRef.current = null;
    }
  }, []);

  useEffect(() => {
    const restoredJobId = restoredJobIdRef.current;
    if (
      restoredJobId &&
      uiState.status === "network-error" &&
      uiState.operation === "poll" &&
      uiState.jobId === restoredJobId
    ) {
      restoredJobIdRef.current = null;
      pollingControllerRef.current?.resumePolling();
    }
  }, [uiState]);

  useEffect(() => {
    try {
      const serialized = serializeMediaJobSession(uiState);
      if (serialized) globalThis.sessionStorage.setItem(MEDIA_JOB_SESSION_STORAGE_KEY, serialized);
      else globalThis.sessionStorage.removeItem(MEDIA_JOB_SESSION_STORAGE_KEY);
    } catch {
      // Storage may be unavailable in privacy-restricted browser contexts.
    }
  }, [uiState]);

  async function handleExtract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCheckLink) return;

    extractAbortRef.current?.abort();
    pollingControllerRef.current?.stop();
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
    if ((!canSubmitJob(uiState) && !canRetryJobSubmit(uiState)) || !("selection" in uiState)) return;

    const requestGeneration = nextGeneration();
    const currentSelection = uiState.selection;
    if (!currentSelection || currentSelection.rightsConfirmed !== true) return;

    const requestBody: CreateDownloadJobRequest = {
      url: url.trim(),
      formatId: currentSelection.selectedFormatId,
      processingPreset: currentSelection.processingPreset,
      rightsConfirmed: currentSelection.rightsConfirmed
    };
    await pollingControllerRef.current?.submitJob(requestBody, requestGeneration);
  }

  function handleUrlChange(value: string) {
    extractAbortRef.current?.abort();
    extractAbortRef.current = null;
    pollingControllerRef.current?.stop();
    setUrl(value);
    dispatch({ type: "RESET", requestGeneration: nextGeneration() });
  }

  function handleStartNewJob() {
    extractAbortRef.current?.abort();
    extractAbortRef.current = null;
    pollingControllerRef.current?.stop();
    setCancellationState({ pending: false, error: null });
    dispatch({ type: "START_NEW_JOB", requestGeneration: nextGeneration() });
  }

  function handleDownloadClick(jobId: string) {
    dispatch({ type: "DOWNLOAD_STARTED", jobId });
    dispatch({ type: "DOWNLOAD_TRIGGERED", jobId });
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
                  disabled={isJobActive(uiState)}
                  onChange={(event) => handleUrlChange(event.target.value)}
                  placeholder="https://reddit.com/r/…/comments/…"
                  aria-invalid={uiState.status === "failed" || uiState.status === "network-error"}
                  aria-describedby="video-url-status"
                  className="h-12 w-full rounded-xl border border-slate-200 bg-white pl-12 pr-4 text-sm font-medium text-ink outline-none transition placeholder:text-slate-400 focus:border-brand focus:ring-4 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
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
                <StatusMessage tone="info" title="Проверьте формат" text={validationError} />
              ) : !selection && uiState.status !== "idle" ? (
                <StatusMessage
                  tone={statusTone(uiState)}
                  title={statusTitle(uiState)}
                  text={getSafeStatusMessage(uiState)}
                />
              ) : null}
            </div>
          </form>

          {selection && (
            <div className="mt-5">
              <VideoResultCard
                state={uiState}
                cancellationPending={cancellationState.pending}
                cancellationError={cancellationState.error}
                onQualityChange={(formatId) => dispatch({ type: "SELECTION_UPDATED", formatId })}
                onPresetChange={(processingPreset) => dispatch({ type: "SELECTION_UPDATED", processingPreset })}
                onRightsChange={(rightsConfirmed) => dispatch({ type: "RIGHTS_UPDATED", rightsConfirmed })}
                onSubmit={handleSubmitJob}
                onCancel={() => void pollingControllerRef.current?.cancelActiveJob()}
                onDownload={handleDownloadClick}
                onStartNew={handleStartNewJob}
                onRetryStatus={() => { pollingControllerRef.current?.resumePolling(); }}
                onRetrySubmit={() => void handleSubmitJob()}
              />
            </div>
          )}

          {!selection && isTerminalState(uiState) && (
            <button
              type="button"
              onClick={handleStartNewJob}
              className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-bold text-ink transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-100"
            >
              <Icon name="arrow" className="h-4 w-4" />
              Начать заново
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
