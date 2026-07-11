import {
  isProcessingPreset,
  type CreateDownloadJobData,
  type CreateDownloadJobRequest,
  type MediaJobApiSnapshot
} from "@/lib/api/media-job-dto";
import {
  canCancelJob,
  isJobActive,
  type MediaDownloadUiEvent,
  type MediaDownloadUiState,
  type SafeUiError
} from "@/lib/client/media-job-state";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";

const JOB_ID = /^job_[a-zA-Z0-9_-]{1,124}$/;
const API_ERROR_CODE_SET: ReadonlySet<string> = new Set(Object.values(API_ERROR_CODES));
const JOB_STATUSES = new Set(["queued", "running", "ready", "failed", "cancelled", "expired"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const INTERNAL_DETAIL_PATTERN = /https?:\/\/|file:\/\/|(?:^|\s)(?:\/[^\s]+|[a-z]:\\[^\s]+)|stderr|stack|ffmpeg|\s-map(?:\s|$)/i;

export const DEFAULT_MEDIA_JOB_POLLING_POLICY = Object.freeze({
  firstPollDelayMs: 750,
  regularPollDelayMs: 1_250,
  requestTimeoutMs: 15_000,
  maxPollingDurationMs: 20 * 60 * 1_000,
  maxConsecutiveFailures: 5,
  maxRetryAfterMs: 30_000,
  networkBackoffMs: Object.freeze([2_000, 4_000, 8_000, 15_000, 30_000] as const)
});

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export type MediaJobPollingPolicy = Readonly<{
  firstPollDelayMs: number;
  regularPollDelayMs: number;
  requestTimeoutMs: number;
  maxPollingDurationMs: number;
  maxConsecutiveFailures: number;
  maxRetryAfterMs: number;
  networkBackoffMs: readonly number[];
}>;

export type CancellationRequestState = Readonly<{
  pending: boolean;
  error: string | null;
}>;

export type MediaJobPollerDependencies = Readonly<{
  dispatch: (event: MediaDownloadUiEvent) => void;
  getState: () => MediaDownloadUiState;
  fetch: typeof globalThis.fetch;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
  onCancellationStateChange?: (state: CancellationRequestState) => void;
  policy?: Partial<MediaJobPollingPolicy>;
}>;

export type MediaJobPollingController = Readonly<{
  submitJob: (request: CreateDownloadJobRequest, requestGeneration: number) => Promise<void>;
  cancelActiveJob: () => Promise<void>;
  resumePolling: () => boolean;
  stop: () => void;
  dispose: () => void;
  getActiveJobId: () => string | null;
}>;

type ActiveJob = {
  jobId: string;
  requestGeneration: number;
  startedAt: number;
  consecutiveFailures: number;
};

class ProtocolError extends Error {
  constructor() {
    super("Invalid API response.");
    this.name = "ProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeJobId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && JOB_ID.test(value);
}

function isJsonResponse(response: Response): boolean {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function safeApiError(value: unknown, fallback = "Не удалось выполнить запрос."): SafeUiError {
  if (!isRecord(value)) return Object.freeze({ code: API_ERROR_CODES.INTERNAL_ERROR, message: fallback });
  const code = typeof value.code === "string" && API_ERROR_CODE_SET.has(value.code)
    ? value.code as ApiErrorCode
    : API_ERROR_CODES.INTERNAL_ERROR;
  const message = typeof value.message === "string" &&
    value.message.length > 0 &&
    value.message.length <= 300 &&
    !CONTROL_CHARACTERS.test(value.message) &&
    !INTERNAL_DETAIL_PATTERN.test(value.message)
    ? value.message
    : fallback;
  return Object.freeze({ code, message });
}

async function readJson(response: Response): Promise<unknown> {
  if (!isJsonResponse(response)) throw new ProtocolError();
  try {
    return await response.json() as unknown;
  } catch {
    throw new ProtocolError();
  }
}

function parseFailure(value: unknown): SafeUiError | null {
  if (!isRecord(value) || value.ok !== false || !isRecord(value.error)) return null;
  return safeApiError(value.error);
}

function parseCreateData(value: unknown, request: CreateDownloadJobRequest): CreateDownloadJobData | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) return null;
  const data = value.data;
  if (
    !isSafeJobId(data.jobId) ||
    data.status !== "queued" ||
    typeof data.progress !== "number" ||
    !Number.isFinite(data.progress) ||
    !isProcessingPreset(data.processingPreset) ||
    data.processingPreset !== request.processingPreset ||
    typeof data.createdAt !== "string" ||
    !Number.isFinite(Date.parse(data.createdAt)) ||
    data.expiresAt !== null ||
    data.statusUrl !== `/api/jobs/${data.jobId}` ||
    data.cancelUrl !== `/api/jobs/${data.jobId}`
  ) {
    return null;
  }
  return Object.freeze({
    jobId: data.jobId,
    status: "queued",
    progress: Math.min(100, Math.max(0, data.progress)),
    processingPreset: data.processingPreset,
    createdAt: new Date(Date.parse(data.createdAt)).toISOString(),
    expiresAt: null,
    statusUrl: `/api/jobs/${data.jobId}`,
    cancelUrl: `/api/jobs/${data.jobId}`
  });
}

function parseSnapshot(value: unknown): MediaJobApiSnapshot | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) return null;
  const data = value.data;
  if (!isSafeJobId(data.jobId) || typeof data.status !== "string" || !JOB_STATUSES.has(data.status)) return null;
  return data as unknown as MediaJobApiSnapshot;
}

function parseRetryAfter(response: Response, maximumMs: number): number | null {
  const value = response.headers.get("retry-after")?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1) return null;
  return Math.min(maximumMs, seconds * 1_000);
}

function canonicalJobRoute(jobId: string): string {
  if (!isSafeJobId(jobId)) throw new ProtocolError();
  return `/api/jobs/${encodeURIComponent(jobId)}`;
}

function mergePolicy(value: Partial<MediaJobPollingPolicy> | undefined): MediaJobPollingPolicy {
  const merged = { ...DEFAULT_MEDIA_JOB_POLLING_POLICY, ...value };
  const positive = (candidate: number, fallback: number) =>
    Number.isFinite(candidate) && candidate > 0 ? Math.trunc(candidate) : fallback;
  return Object.freeze({
    firstPollDelayMs: positive(merged.firstPollDelayMs, DEFAULT_MEDIA_JOB_POLLING_POLICY.firstPollDelayMs),
    regularPollDelayMs: positive(merged.regularPollDelayMs, DEFAULT_MEDIA_JOB_POLLING_POLICY.regularPollDelayMs),
    requestTimeoutMs: positive(merged.requestTimeoutMs, DEFAULT_MEDIA_JOB_POLLING_POLICY.requestTimeoutMs),
    maxPollingDurationMs: positive(merged.maxPollingDurationMs, DEFAULT_MEDIA_JOB_POLLING_POLICY.maxPollingDurationMs),
    maxConsecutiveFailures: positive(merged.maxConsecutiveFailures, DEFAULT_MEDIA_JOB_POLLING_POLICY.maxConsecutiveFailures),
    maxRetryAfterMs: positive(merged.maxRetryAfterMs, DEFAULT_MEDIA_JOB_POLLING_POLICY.maxRetryAfterMs),
    networkBackoffMs: Object.freeze(
      merged.networkBackoffMs.length > 0
        ? merged.networkBackoffMs.map((delay, index) =>
            positive(delay, DEFAULT_MEDIA_JOB_POLLING_POLICY.networkBackoffMs[index] ?? 30_000)
          )
        : [...DEFAULT_MEDIA_JOB_POLLING_POLICY.networkBackoffMs]
    )
  });
}

export function createMediaJobPollingController(
  dependencies: MediaJobPollerDependencies
): MediaJobPollingController {
  const policy = mergePolicy(dependencies.policy);
  const now = dependencies.now ?? Date.now;
  const schedule = dependencies.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const clear = dependencies.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle));
  let disposed = false;
  let lifecycle = 0;
  let pollEpoch = 0;
  let activeJob: ActiveJob | undefined;
  let pollTimer: TimerHandle | undefined;
  let requestTimer: TimerHandle | undefined;
  let postController: AbortController | undefined;
  let pollController: AbortController | undefined;
  let deleteController: AbortController | undefined;
  let cancellationPromise: Promise<void> | undefined;

  function emitCancellationState(pending: boolean, error: string | null): void {
    if (!disposed) dependencies.onCancellationStateChange?.(Object.freeze({ pending, error }));
  }

  function clearTimer(handle: TimerHandle | undefined): void {
    if (handle !== undefined) clear(handle);
  }

  function stopPolling(abortRequest = true): void {
    pollEpoch += 1;
    clearTimer(pollTimer);
    clearTimer(requestTimer);
    pollTimer = undefined;
    requestTimer = undefined;
    if (abortRequest) pollController?.abort();
    pollController = undefined;
  }

  function stop(): void {
    lifecycle += 1;
    stopPolling();
    postController?.abort();
    deleteController?.abort();
    postController = undefined;
    deleteController = undefined;
    cancellationPromise = undefined;
    activeJob = undefined;
    emitCancellationState(false, null);
  }

  function isCurrent(token: number, epoch?: number): boolean {
    return !disposed && token === lifecycle && (epoch === undefined || epoch === pollEpoch);
  }

  function timeoutPolling(job: ActiveJob): void {
    if (!activeJob || activeJob.jobId !== job.jobId || activeJob.requestGeneration !== job.requestGeneration) return;
    stopPolling();
    activeJob = undefined;
    dependencies.dispatch({
      type: "POLLING_TIMED_OUT",
      requestGeneration: job.requestGeneration,
      jobId: job.jobId
    });
  }

  function schedulePoll(delayMs: number, token: number): void {
    const job = activeJob;
    if (!job || !isCurrent(token)) return;
    clearTimer(pollTimer);
    const remaining = policy.maxPollingDurationMs - (now() - job.startedAt);
    if (remaining <= 0) {
      timeoutPolling(job);
      return;
    }
    const epoch = pollEpoch;
    pollTimer = schedule(() => {
      pollTimer = undefined;
      if (!isCurrent(token, epoch) || !activeJob) return;
      if (now() - activeJob.startedAt >= policy.maxPollingDurationMs) {
        timeoutPolling(activeJob);
        return;
      }
      void pollOnce(token, epoch);
    }, Math.min(Math.max(1, delayMs), remaining));
  }

  function retryDelay(failureCount: number): number {
    return policy.networkBackoffMs[Math.min(failureCount - 1, policy.networkBackoffMs.length - 1)] ?? 30_000;
  }

  function handleTransientFailure(token: number, suggestedDelay?: number): void {
    const job = activeJob;
    if (!job || !isCurrent(token)) return;
    job.consecutiveFailures += 1;
    if (now() - job.startedAt >= policy.maxPollingDurationMs) {
      timeoutPolling(job);
      return;
    }
    if (job.consecutiveFailures >= policy.maxConsecutiveFailures) {
      stopPolling();
      activeJob = undefined;
      dependencies.dispatch({
        type: "JOB_REQUEST_FAILED",
        requestGeneration: job.requestGeneration,
        operation: "poll",
        network: true
      });
      return;
    }
    schedulePoll(Math.max(retryDelay(job.consecutiveFailures), suggestedDelay ?? 0), token);
  }

  function finishTerminal(): void {
    stopPolling();
    activeJob = undefined;
  }

  async function pollOnce(token: number, epoch: number): Promise<void> {
    const job = activeJob;
    if (!job || !isCurrent(token, epoch)) return;
    const controller = new AbortController();
    let requestTimedOut = false;
    pollController = controller;
    requestTimer = schedule(() => {
      requestTimedOut = true;
      controller.abort();
    }, policy.requestTimeoutMs);

    try {
      const response = await dependencies.fetch(canonicalJobRoute(job.jobId), {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal
      });
      clearTimer(requestTimer);
      requestTimer = undefined;
      if (pollController === controller) pollController = undefined;
      if (!isCurrent(token, epoch) || activeJob?.jobId !== job.jobId) return;

      if (response.status === 429) {
        handleTransientFailure(token, parseRetryAfter(response, policy.maxRetryAfterMs) ?? undefined);
        return;
      }
      if (response.status >= 500 && response.status <= 599) {
        handleTransientFailure(token);
        return;
      }

      const payload = await readJson(response);
      if (!isCurrent(token, epoch) || activeJob?.jobId !== job.jobId) return;
      const failure = parseFailure(payload);
      if (!response.ok || failure) {
        if (response.status === 404 && failure?.code === API_ERROR_CODES.JOB_NOT_FOUND) {
          finishTerminal();
          dependencies.dispatch({
            type: "JOB_NOT_FOUND",
            requestGeneration: job.requestGeneration,
            jobId: job.jobId
          });
          return;
        }
        finishTerminal();
        dependencies.dispatch({
          type: "JOB_REQUEST_FAILED",
          requestGeneration: job.requestGeneration,
          operation: "poll",
          network: false,
          error: failure ?? Object.freeze({
            code: API_ERROR_CODES.INTERNAL_ERROR,
            message: "Получен некорректный ответ сервера."
          })
        });
        return;
      }

      const snapshot = parseSnapshot(payload);
      if (!snapshot) throw new ProtocolError();
      if (snapshot.jobId !== job.jobId) {
        handleTransientFailure(token);
        return;
      }

      job.consecutiveFailures = 0;
      emitCancellationState(false, null);
      dependencies.dispatch({
        type: "JOB_SNAPSHOT_RECEIVED",
        requestGeneration: job.requestGeneration,
        snapshot
      });

      if (snapshot.status === "queued" || snapshot.status === "running") {
        if (now() - job.startedAt >= policy.maxPollingDurationMs) timeoutPolling(job);
        else schedulePoll(policy.regularPollDelayMs, token);
      } else {
        finishTerminal();
      }
    } catch (error) {
      clearTimer(requestTimer);
      requestTimer = undefined;
      if (pollController === controller) pollController = undefined;
      if (!isCurrent(token, epoch) || activeJob?.jobId !== job.jobId) return;
      if (controller.signal.aborted && !requestTimedOut) return;
      if (error instanceof ProtocolError) {
        finishTerminal();
        dependencies.dispatch({
          type: "JOB_REQUEST_FAILED",
          requestGeneration: job.requestGeneration,
          operation: "poll",
          network: false,
          error: Object.freeze({
            code: API_ERROR_CODES.INTERNAL_ERROR,
            message: "Получен некорректный ответ сервера."
          })
        });
        return;
      }
      handleTransientFailure(token);
    }
  }

  function activateJob(data: CreateDownloadJobData, requestGeneration: number, token: number): void {
    activeJob = {
      jobId: data.jobId,
      requestGeneration,
      startedAt: now(),
      consecutiveFailures: 0
    };
    stopPolling(false);
    schedulePoll(policy.firstPollDelayMs, token);
  }

  async function submitJob(request: CreateDownloadJobRequest, requestGeneration: number): Promise<void> {
    if (disposed || postController || cancellationPromise || isJobActive(dependencies.getState())) return;
    stop();
    const token = lifecycle;
    dependencies.dispatch({ type: "JOB_SUBMIT_STARTED", requestGeneration });
    const controller = new AbortController();
    postController = controller;

    try {
      const response = await dependencies.fetch("/api/download", {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal
      });
      if (!isCurrent(token) || postController !== controller) return;
      const payload = await readJson(response);
      if (!isCurrent(token) || postController !== controller) return;
      const failure = parseFailure(payload);
      if (!response.ok || failure) {
        dependencies.dispatch({
          type: "JOB_REQUEST_FAILED",
          requestGeneration,
          operation: "submit",
          network: false,
          error: failure ?? Object.freeze({
            code: API_ERROR_CODES.INTERNAL_ERROR,
            message: "Получен некорректный ответ сервера."
          })
        });
        return;
      }
      if (response.status !== 202) throw new ProtocolError();
      const data = parseCreateData(payload, request);
      if (!data) throw new ProtocolError();
      dependencies.dispatch({ type: "JOB_CREATED", requestGeneration, data });
      activateJob(data, requestGeneration, token);
    } catch (error) {
      if (!isCurrent(token) || controller.signal.aborted) return;
      dependencies.dispatch({
        type: "JOB_REQUEST_FAILED",
        requestGeneration,
        operation: "submit",
        network: !(error instanceof ProtocolError),
        ...(error instanceof ProtocolError
          ? {
              error: Object.freeze({
                code: API_ERROR_CODES.INTERNAL_ERROR,
                message: "Получен некорректный ответ сервера."
              })
            }
          : {})
      });
    } finally {
      if (postController === controller) postController = undefined;
    }
  }

  function resumeAfterCancellationFailure(token: number, job: ActiveJob): void {
    if (!isCurrent(token)) return;
    const state = dependencies.getState();
    if (
      !canCancelJob(state) ||
      (state.status !== "queued" && state.status !== "running") ||
      state.jobId !== job.jobId ||
      state.requestGeneration !== job.requestGeneration
    ) return;
    activeJob = { ...job, startedAt: now(), consecutiveFailures: 0 };
    schedulePoll(policy.firstPollDelayMs, token);
  }

  async function performCancellation(token: number, job: ActiveJob): Promise<void> {
    const controller = new AbortController();
    let finalError: string | null = null;
    deleteController = controller;
    emitCancellationState(true, null);
    stopPolling();

    try {
      const response = await dependencies.fetch(canonicalJobRoute(job.jobId), {
        method: "DELETE",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal
      });
      if (!isCurrent(token) || deleteController !== controller) return;
      const payload = await readJson(response);
      if (!isCurrent(token) || deleteController !== controller) return;
      const failure = parseFailure(payload);
      if (!response.ok || failure) {
        if (response.status === 404 && failure?.code === API_ERROR_CODES.JOB_NOT_FOUND) {
          activeJob = undefined;
          dependencies.dispatch({
            type: "JOB_NOT_FOUND",
            requestGeneration: job.requestGeneration,
            jobId: job.jobId
          });
          return;
        }
        finalError = failure?.message ?? "Не удалось отменить подготовку файла";
        resumeAfterCancellationFailure(token, job);
        return;
      }

      const snapshot = parseSnapshot(payload);
      if (!snapshot) throw new ProtocolError();
      if (snapshot.jobId !== job.jobId) {
        finalError = "Не удалось подтвердить отмену задачи";
        resumeAfterCancellationFailure(token, job);
        return;
      }
      dependencies.dispatch({
        type: "JOB_SNAPSHOT_RECEIVED",
        requestGeneration: job.requestGeneration,
        snapshot
      });
      if (snapshot.status === "queued" || snapshot.status === "running") {
        finalError = "Отмена ещё не подтверждена";
        resumeAfterCancellationFailure(token, job);
      } else {
        activeJob = undefined;
      }
    } catch (error) {
      if (!isCurrent(token) || controller.signal.aborted) return;
      finalError = error instanceof ProtocolError
        ? "Получен некорректный ответ сервера"
        : "Не удалось отменить подготовку файла";
      resumeAfterCancellationFailure(token, job);
    } finally {
      if (deleteController === controller) deleteController = undefined;
      if (isCurrent(token)) emitCancellationState(false, finalError);
      cancellationPromise = undefined;
    }
  }

  function cancelActiveJob(): Promise<void> {
    if (cancellationPromise) return cancellationPromise;
    const state = dependencies.getState();
    if (
      !canCancelJob(state) ||
      (state.status !== "queued" && state.status !== "running") ||
      !activeJob ||
      state.jobId !== activeJob.jobId
    ) return Promise.resolve();
    const token = lifecycle;
    const job = { ...activeJob };
    cancellationPromise = performCancellation(token, job);
    return cancellationPromise;
  }

  function resumePolling(): boolean {
    const state = dependencies.getState();
    if (
      disposed ||
      (state.status !== "network-error" && state.status !== "polling-timeout") ||
      !state.jobId ||
      !isSafeJobId(state.jobId)
    ) {
      return false;
    }
    stopPolling();
    activeJob = {
      jobId: state.jobId,
      requestGeneration: state.requestGeneration,
      startedAt: now(),
      consecutiveFailures: 0
    };
    schedulePoll(policy.firstPollDelayMs, lifecycle);
    return true;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stop();
  }

  return Object.freeze({
    submitJob,
    cancelActiveJob,
    resumePolling,
    stop,
    dispose,
    getActiveJobId: () => activeJob?.jobId ?? null
  });
}
