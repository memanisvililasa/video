import {
  isProcessingPreset,
  type CreateDownloadJobData,
  type MediaJobApiResult,
  type MediaJobApiSnapshot,
  type ProcessingPreset
} from "@/lib/api/media-job-dto";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";

const FORMAT_ID = /^[a-zA-Z0-9._-]{1,64}$/;
const JOB_ID = /^job_[a-zA-Z0-9_-]{1,124}$/;
const FILE_ID = /^file_[a-zA-Z0-9_-]{1,123}$/;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/;
const MEDIA_IDENTIFIER = /^[a-zA-Z0-9_.-]{1,256}$/;
const FORMAT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9,._-]{0,255}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const UNSAFE_MESSAGE = /https?:\/\/|file:\/\/|(?:^|\s)(?:\/[^\s]+|[a-z]:\\[^\s]+)|stderr|stack|ffmpeg|\s-map(?:\s|$)/i;
const PROTOCOL_ERROR_MESSAGE = "Получен некорректный ответ сервера.";
const NETWORK_ERROR_MESSAGE = "Не удалось связаться с сервером";

export type MediaSelectionOption = Readonly<{
  id: string;
  label: string;
  meta: string;
}>;

export type MediaSelectionData = Readonly<{
  platform: string;
  title: string;
  duration: string;
  qualities: readonly MediaSelectionOption[];
}>;

export type MediaJobSelection = Readonly<{
  media: MediaSelectionData;
  selectedFormatId: string;
  processingPreset: ProcessingPreset;
  rightsConfirmed: boolean;
}>;

export type SafeUiError = Readonly<{
  code: ApiErrorCode;
  message: string;
}>;

type StateBase = Readonly<{ requestGeneration: number }>;
type SelectionStateBase = StateBase & Readonly<{ selection: MediaJobSelection }>;
type JobStateBase = SelectionStateBase & Readonly<{
  jobId: string;
  progress: number;
  processingPreset: ProcessingPreset;
  createdAt: string;
  startedAt: string | null;
  expiresAt: string | null;
}>;

export type MediaDownloadUiState =
  | (StateBase & Readonly<{ status: "idle" }>)
  | (StateBase & Readonly<{ status: "extracting" }>)
  | (SelectionStateBase & Readonly<{ status: "selection-ready" }>)
  | (SelectionStateBase & Readonly<{ status: "submitting" }>)
  | (JobStateBase & Readonly<{ status: "queued" }>)
  | (JobStateBase & Readonly<{ status: "running" }>)
  | (JobStateBase & Readonly<{ status: "ready"; progress: 100; result: MediaJobApiResult }>)
  | (JobStateBase & Readonly<{ status: "downloading"; progress: 100; result: MediaJobApiResult }>)
  | (JobStateBase & Readonly<{ status: "success"; progress: 100; result: MediaJobApiResult }>)
  | (StateBase & Readonly<{
      status: "failed";
      selection?: MediaJobSelection;
      jobId?: string;
      error: SafeUiError;
    }>)
  | (StateBase & Readonly<{
      status: "cancelled";
      selection?: MediaJobSelection;
      jobId?: string;
      message: string;
    }>)
  | (StateBase & Readonly<{
      status: "expired";
      selection?: MediaJobSelection;
      jobId: string;
      message: string;
    }>)
  | (StateBase & Readonly<{
      status: "network-error";
      selection?: MediaJobSelection;
      jobId?: string;
      operation: "extract" | "submit" | "poll" | "download";
      message: string;
    }>)
  | (StateBase & Readonly<{
      status: "polling-timeout";
      selection?: MediaJobSelection;
      jobId: string;
      progress: number;
      message: string;
    }>);

export type MediaDownloadUiEvent =
  | Readonly<{ type: "RESET"; requestGeneration: number }>
  | Readonly<{ type: "START_NEW_JOB"; requestGeneration: number }>
  | Readonly<{ type: "EXTRACT_STARTED"; requestGeneration: number }>
  | Readonly<{ type: "EXTRACT_SUCCEEDED"; requestGeneration: number; media: MediaSelectionData }>
  | Readonly<{ type: "EXTRACT_FAILED"; requestGeneration: number; error: SafeUiError }>
  | Readonly<{ type: "SELECTION_UPDATED"; formatId?: string; processingPreset?: ProcessingPreset }>
  | Readonly<{ type: "RIGHTS_UPDATED"; rightsConfirmed: boolean }>
  | Readonly<{ type: "JOB_SUBMIT_STARTED"; requestGeneration: number }>
  | Readonly<{ type: "JOB_CREATED"; requestGeneration: number; data: CreateDownloadJobData }>
  | Readonly<{ type: "JOB_SNAPSHOT_RECEIVED"; requestGeneration: number; snapshot: MediaJobApiSnapshot }>
  | Readonly<{
      type: "JOB_REQUEST_FAILED";
      requestGeneration: number;
      operation: "submit" | "poll";
      network: boolean;
      error?: SafeUiError;
    }>
  | Readonly<{ type: "POLLING_TIMED_OUT"; requestGeneration: number; jobId: string }>
  | Readonly<{ type: "JOB_CANCELLED"; requestGeneration: number; jobId: string }>
  | Readonly<{ type: "DOWNLOAD_STARTED"; jobId: string }>
  | Readonly<{ type: "DOWNLOAD_TRIGGERED"; jobId: string }>
  | Readonly<{ type: "DOWNLOAD_FAILED"; jobId: string }>
  | Readonly<{
      type: "NETWORK_FAILED";
      requestGeneration: number;
      operation: "extract" | "download";
    }>;

export const INITIAL_MEDIA_DOWNLOAD_UI_STATE: MediaDownloadUiState = Object.freeze({
  status: "idle",
  requestGeneration: 0
});

function normalizeProgress(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : 0;
}

function normalizeIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function isValidGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function safeMessage(value: unknown, fallback: string): string {
  return isSafeText(value, 300) && !UNSAFE_MESSAGE.test(value) ? value : fallback;
}

function safeError(value: unknown, fallbackMessage = PROTOCOL_ERROR_MESSAGE): SafeUiError {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.freeze({ code: API_ERROR_CODES.INTERNAL_ERROR, message: fallbackMessage });
  }
  const candidate = value as Partial<SafeUiError>;
  const knownCode = Object.values(API_ERROR_CODES).includes(candidate.code as ApiErrorCode)
    ? candidate.code as ApiErrorCode
    : API_ERROR_CODES.INTERNAL_ERROR;
  return Object.freeze({
    code: knownCode,
    message: safeMessage(candidate.message, fallbackMessage)
  });
}

function freezeMedia(value: MediaSelectionData): MediaSelectionData | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !isSafeText(value?.platform, 100) ||
    UNSAFE_MESSAGE.test(value.platform) ||
    !isSafeText(value?.title, 300) ||
    UNSAFE_MESSAGE.test(value.title) ||
    !isSafeText(value?.duration, 100) ||
    UNSAFE_MESSAGE.test(value.duration) ||
    !Array.isArray(value?.qualities) ||
    value.qualities.length === 0 ||
    value.qualities.length > 100
  ) {
    return null;
  }

  const qualities: MediaSelectionOption[] = [];
  const ids = new Set<string>();
  for (const option of value.qualities) {
    if (
      typeof option !== "object" ||
      option === null ||
      !FORMAT_ID.test(option.id) ||
      ids.has(option.id) ||
      !isSafeText(option.label, 160) ||
      UNSAFE_MESSAGE.test(option.label) ||
      !isSafeText(option.meta, 200) ||
      UNSAFE_MESSAGE.test(option.meta)
    ) {
      return null;
    }
    ids.add(option.id);
    qualities.push(Object.freeze({ id: option.id, label: option.label, meta: option.meta }));
  }

  return Object.freeze({
    platform: value.platform,
    title: value.title,
    duration: value.duration,
    qualities: Object.freeze(qualities)
  });
}

function freezeSelection(selection: MediaJobSelection): MediaJobSelection {
  return Object.freeze({
    media: selection.media,
    selectedFormatId: selection.selectedFormatId,
    processingPreset: selection.processingPreset,
    rightsConfirmed: selection.rightsConfirmed
  });
}

function stateSelection(state: MediaDownloadUiState): MediaJobSelection | undefined {
  return "selection" in state ? state.selection : undefined;
}

function stateJobId(state: MediaDownloadUiState): string | undefined {
  return "jobId" in state ? state.jobId : undefined;
}

function isSafeJobId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && JOB_ID.test(value);
}

function freezeResult(value: unknown, expectedPreset: ProcessingPreset): MediaJobApiResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const result = value as Partial<MediaJobApiResult>;
  if (
    typeof result.fileId !== "string" ||
    result.fileId.length > 128 ||
    !FILE_ID.test(result.fileId) ||
    result.downloadUrl !== `/api/file/${result.fileId}` ||
    !isSafeText(result.filename, 180) ||
    UNSAFE_MESSAGE.test(result.filename) ||
    result.filename.includes("/") ||
    result.filename.includes("\\") ||
    typeof result.mimeType !== "string" ||
    !CONTENT_TYPE.test(result.mimeType) ||
    !Number.isSafeInteger(result.sizeBytes) ||
    (result.sizeBytes as number) <= 0 ||
    !isProcessingPreset(result.processingPreset) ||
    result.processingPreset !== expectedPreset
  ) {
    return null;
  }

  const expiresAt = normalizeIso(result.expiresAt);
  const media = result.media;
  if (
    !expiresAt ||
    typeof media !== "object" ||
    media === null ||
    !Number.isFinite(media.durationSeconds) ||
    media.durationSeconds <= 0 ||
    typeof media.formatName !== "string" ||
    !FORMAT_NAME.test(media.formatName) ||
    typeof media.hasVideo !== "boolean" ||
    typeof media.hasAudio !== "boolean" ||
    (media.width !== undefined && (!Number.isSafeInteger(media.width) || media.width <= 0 || media.width > 16_384)) ||
    (media.height !== undefined && (!Number.isSafeInteger(media.height) || media.height <= 0 || media.height > 16_384)) ||
    (media.videoCodec !== undefined && (typeof media.videoCodec !== "string" || !MEDIA_IDENTIFIER.test(media.videoCodec))) ||
    (media.audioCodec !== undefined && (typeof media.audioCodec !== "string" || !MEDIA_IDENTIFIER.test(media.audioCodec)))
  ) {
    return null;
  }

  const safeMedia = Object.freeze({
    durationSeconds: media.durationSeconds,
    formatName: media.formatName,
    hasVideo: media.hasVideo,
    hasAudio: media.hasAudio,
    ...(media.width !== undefined ? { width: media.width } : {}),
    ...(media.height !== undefined ? { height: media.height } : {}),
    ...(media.videoCodec ? { videoCodec: media.videoCodec } : {}),
    ...(media.audioCodec ? { audioCodec: media.audioCodec } : {})
  });

  return Object.freeze({
    fileId: result.fileId,
    filename: result.filename,
    mimeType: result.mimeType,
    sizeBytes: result.sizeBytes as number,
    downloadUrl: `/api/file/${result.fileId}`,
    expiresAt,
    processingPreset: expectedPreset,
    media: safeMedia
  });
}

function protocolFailure(state: MediaDownloadUiState, jobId?: string): MediaDownloadUiState {
  return Object.freeze({
    status: "failed",
    requestGeneration: state.requestGeneration,
    ...(stateSelection(state) ? { selection: stateSelection(state) } : {}),
    ...(jobId ? { jobId } : {}),
    error: safeError(undefined)
  });
}

function jobBase(
  state: MediaDownloadUiState,
  snapshot: MediaJobApiSnapshot
): JobStateBase | null {
  const selection = stateSelection(state);
  const createdAt = normalizeIso(snapshot.createdAt);
  if (
    !selection ||
    !isSafeJobId(snapshot.jobId) ||
    !createdAt ||
    !isProcessingPreset(snapshot.processingPreset) ||
    snapshot.processingPreset !== selection.processingPreset
  ) {
    return null;
  }
  return Object.freeze({
    requestGeneration: state.requestGeneration,
    selection,
    jobId: snapshot.jobId,
    progress: normalizeProgress(snapshot.progress),
    processingPreset: snapshot.processingPreset,
    createdAt,
    startedAt: normalizeIso(snapshot.startedAt),
    expiresAt: normalizeIso(snapshot.expiresAt)
  });
}

export function mapApiSnapshotToUiState(
  state: MediaDownloadUiState,
  snapshot: MediaJobApiSnapshot
): MediaDownloadUiState {
  if (!isJobActive(state) && state.status !== "polling-timeout") return state;
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    return protocolFailure(state, stateJobId(state));
  }
  const activeJobId = stateJobId(state);
  if (activeJobId && snapshot.jobId !== activeJobId) return state;
  if (state.status === "running" && snapshot.status === "queued") return state;

  const base = jobBase(state, snapshot);
  if (!base) return protocolFailure(state, activeJobId ?? snapshot.jobId);

  switch (snapshot.status) {
    case "queued":
      return Object.freeze({ ...base, status: "queued" });
    case "running":
      return Object.freeze({ ...base, status: "running" });
    case "ready": {
      const result = freezeResult((snapshot as { result?: unknown }).result, base.processingPreset);
      if (!result) return protocolFailure(state, snapshot.jobId);
      return Object.freeze({ ...base, status: "ready", progress: 100, result });
    }
    case "failed":
      return Object.freeze({
        status: "failed",
        requestGeneration: state.requestGeneration,
        selection: base.selection,
        jobId: base.jobId,
        error: safeError((snapshot as { error?: unknown }).error, "Не удалось обработать задачу.")
      });
    case "cancelled":
      return Object.freeze({
        status: "cancelled",
        requestGeneration: state.requestGeneration,
        selection: base.selection,
        jobId: base.jobId,
        message: "Подготовка файла отменена"
      });
    case "expired":
      return Object.freeze({
        status: "expired",
        requestGeneration: state.requestGeneration,
        selection: base.selection,
        jobId: base.jobId,
        message: "Срок хранения файла истёк"
      });
    default: {
      const exhaustive: never = snapshot;
      throw new TypeError(`Unsupported job snapshot: ${String(exhaustive)}`);
    }
  }
}

function canStartExtract(state: MediaDownloadUiState): boolean {
  return !["extracting", "submitting", "queued", "running", "downloading"].includes(state.status);
}

function isTerminalForNewJob(state: MediaDownloadUiState): boolean {
  return ["ready", "success", "failed", "cancelled", "expired", "network-error", "polling-timeout"].includes(state.status);
}

function generationMatches(state: MediaDownloadUiState, generation: number): boolean {
  return isValidGeneration(generation) && generation === state.requestGeneration;
}

export function mediaDownloadUiReducer(
  state: MediaDownloadUiState,
  event: MediaDownloadUiEvent
): MediaDownloadUiState {
  switch (event.type) {
    case "RESET":
      return isValidGeneration(event.requestGeneration) && event.requestGeneration >= state.requestGeneration
        ? Object.freeze({ status: "idle", requestGeneration: event.requestGeneration })
        : state;
    case "START_NEW_JOB":
      return isTerminalForNewJob(state) && isValidGeneration(event.requestGeneration) && event.requestGeneration > state.requestGeneration
        ? Object.freeze({ status: "idle", requestGeneration: event.requestGeneration })
        : state;
    case "EXTRACT_STARTED":
      return canStartExtract(state) && isValidGeneration(event.requestGeneration) && event.requestGeneration > state.requestGeneration
        ? Object.freeze({ status: "extracting", requestGeneration: event.requestGeneration })
        : state;
    case "EXTRACT_SUCCEEDED": {
      if (state.status !== "extracting" || !generationMatches(state, event.requestGeneration)) return state;
      const media = freezeMedia(event.media);
      if (!media) return protocolFailure(state);
      const selection = freezeSelection({
        media,
        selectedFormatId: media.qualities[0]?.id ?? "",
        processingPreset: "original",
        rightsConfirmed: false
      });
      return Object.freeze({ status: "selection-ready", requestGeneration: state.requestGeneration, selection });
    }
    case "EXTRACT_FAILED":
      return state.status === "extracting" && generationMatches(state, event.requestGeneration)
        ? Object.freeze({
            status: "failed",
            requestGeneration: state.requestGeneration,
            error: safeError(event.error, "Не удалось получить данные видео.")
          })
        : state;
    case "SELECTION_UPDATED": {
      if (state.status !== "selection-ready") return state;
      const formatId = event.formatId ?? state.selection.selectedFormatId;
      const preset = event.processingPreset ?? state.selection.processingPreset;
      if (!FORMAT_ID.test(formatId) || !state.selection.media.qualities.some((item) => item.id === formatId)) return state;
      if (!isProcessingPreset(preset)) return state;
      return Object.freeze({
        ...state,
        selection: freezeSelection({ ...state.selection, selectedFormatId: formatId, processingPreset: preset })
      });
    }
    case "RIGHTS_UPDATED":
      return state.status === "selection-ready"
        ? Object.freeze({
            ...state,
            selection: freezeSelection({ ...state.selection, rightsConfirmed: event.rightsConfirmed === true })
          })
        : state;
    case "JOB_SUBMIT_STARTED":
      return state.status === "selection-ready" &&
        canSubmitJob(state) &&
        isValidGeneration(event.requestGeneration) &&
        event.requestGeneration > state.requestGeneration
        ? Object.freeze({
            status: "submitting",
            requestGeneration: event.requestGeneration,
            selection: state.selection
          })
        : state;
    case "JOB_CREATED": {
      if (state.status !== "submitting" || !generationMatches(state, event.requestGeneration)) return state;
      if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) {
        return protocolFailure(state);
      }
      const createdAt = normalizeIso(event.data.createdAt);
      if (
        event.data.status !== "queued" ||
        !isSafeJobId(event.data.jobId) ||
        !createdAt ||
        !isProcessingPreset(event.data.processingPreset) ||
        event.data.processingPreset !== state.selection.processingPreset
      ) {
        return protocolFailure(state, event.data.jobId);
      }
      return Object.freeze({
        status: "queued",
        requestGeneration: state.requestGeneration,
        selection: state.selection,
        jobId: event.data.jobId,
        progress: normalizeProgress(event.data.progress),
        processingPreset: event.data.processingPreset,
        createdAt,
        startedAt: null,
        expiresAt: null
      });
    }
    case "JOB_SNAPSHOT_RECEIVED":
      return generationMatches(state, event.requestGeneration)
        ? mapApiSnapshotToUiState(state, event.snapshot)
        : state;
    case "JOB_REQUEST_FAILED": {
      if (!generationMatches(state, event.requestGeneration) || !["submitting", "queued", "running", "polling-timeout"].includes(state.status)) {
        return state;
      }
      if (!event.network) {
        return Object.freeze({
          status: "failed",
          requestGeneration: state.requestGeneration,
          ...(stateSelection(state) ? { selection: stateSelection(state) } : {}),
          ...(stateJobId(state) ? { jobId: stateJobId(state) } : {}),
          error: safeError(event.error, "Не удалось создать или обновить задачу.")
        });
      }
      return Object.freeze({
        status: "network-error",
        requestGeneration: state.requestGeneration,
        ...(stateSelection(state) ? { selection: stateSelection(state) } : {}),
        ...(stateJobId(state) ? { jobId: stateJobId(state) } : {}),
        operation: event.operation,
        message: NETWORK_ERROR_MESSAGE
      });
    }
    case "NETWORK_FAILED":
      return generationMatches(state, event.requestGeneration) &&
        ((event.operation === "extract" && state.status === "extracting") ||
          (event.operation === "download" && state.status === "downloading"))
        ? Object.freeze({
            status: "network-error",
            requestGeneration: state.requestGeneration,
            ...(stateSelection(state) ? { selection: stateSelection(state) } : {}),
            ...(stateJobId(state) ? { jobId: stateJobId(state) } : {}),
            operation: event.operation,
            message: NETWORK_ERROR_MESSAGE
          })
        : state;
    case "POLLING_TIMED_OUT":
      return generationMatches(state, event.requestGeneration) &&
        (state.status === "queued" || state.status === "running") &&
        state.jobId === event.jobId
        ? Object.freeze({
            status: "polling-timeout",
            requestGeneration: state.requestGeneration,
            selection: state.selection,
            jobId: state.jobId,
            progress: normalizeProgress(state.progress),
            message: "Подготовка занимает больше времени, чем ожидалось"
          })
        : state;
    case "JOB_CANCELLED":
      return generationMatches(state, event.requestGeneration) &&
        (state.status === "queued" || state.status === "running") &&
        state.jobId === event.jobId
        ? Object.freeze({
            status: "cancelled",
            requestGeneration: state.requestGeneration,
            selection: state.selection,
            jobId: state.jobId,
            message: "Подготовка файла отменена"
          })
        : state;
    case "DOWNLOAD_STARTED":
      return state.status === "ready" && state.jobId === event.jobId
        ? Object.freeze({ ...state, status: "downloading" })
        : state;
    case "DOWNLOAD_TRIGGERED":
      return state.status === "downloading" && state.jobId === event.jobId
        ? Object.freeze({ ...state, status: "success" })
        : state;
    case "DOWNLOAD_FAILED":
      return state.status === "downloading" && state.jobId === event.jobId
        ? Object.freeze({ ...state, status: "ready" })
        : state;
    default: {
      const exhaustive: never = event;
      throw new TypeError(`Unsupported media download event: ${String(exhaustive)}`);
    }
  }
}

export function canSubmitJob(state: MediaDownloadUiState): boolean {
  return (
    state.status === "selection-ready" &&
    state.selection.rightsConfirmed === true &&
    FORMAT_ID.test(state.selection.selectedFormatId) &&
    state.selection.media.qualities.some((item) => item.id === state.selection.selectedFormatId) &&
    isProcessingPreset(state.selection.processingPreset)
  );
}

export function canCancelJob(state: MediaDownloadUiState): boolean {
  return state.status === "queued" || state.status === "running";
}

export function canDownloadFile(state: MediaDownloadUiState): boolean {
  return state.status === "ready" && freezeResult(state.result, state.processingPreset) !== null;
}

export function isJobActive(state: MediaDownloadUiState): boolean {
  return state.status === "submitting" || state.status === "queued" || state.status === "running";
}

export function isTerminalState(state: MediaDownloadUiState): boolean {
  return ["ready", "success", "failed", "cancelled", "expired", "network-error", "polling-timeout"].includes(state.status);
}

export function getVisibleProgress(state: MediaDownloadUiState): number | null {
  return "progress" in state ? normalizeProgress(state.progress) : null;
}

export function getSafeStatusMessage(state: MediaDownloadUiState): string {
  switch (state.status) {
    case "idle":
      return "Вставьте ссылку на публичное видео";
    case "extracting":
      return "Проверяем ссылку и получаем доступные форматы";
    case "selection-ready":
      return "Выберите формат и подтвердите права на контент";
    case "submitting":
      return "Создаём задачу";
    case "queued":
      return "Задача поставлена в очередь";
    case "running":
      return "Файл обрабатывается";
    case "ready":
      return "Файл готов к скачиванию";
    case "downloading":
      return "Скачивание файла запрошено";
    case "success":
      return "Скачивание файла инициировано";
    case "failed":
      return safeMessage(state.error.message, "Не удалось обработать задачу.");
    case "cancelled":
      return "Подготовка файла отменена";
    case "expired":
      return "Срок хранения файла истёк";
    case "network-error":
      return NETWORK_ERROR_MESSAGE;
    case "polling-timeout":
      return "Подготовка занимает больше времени, чем ожидалось";
    default: {
      const exhaustive: never = state;
      throw new TypeError(`Unsupported media download state: ${String(exhaustive)}`);
    }
  }
}
