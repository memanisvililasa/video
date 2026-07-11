import type {
  CreateDownloadJobData,
  MediaJobApiResult,
  MediaJobApiSnapshot,
  ProcessingPreset
} from "@/lib/api/media-job-dto";
import { API_ERROR_CODES, type ApiErrorCode, type VideoMetadata } from "@/lib/types";

export const PUBLIC_PAGE_URL = "https://public.example/watch/video-42";
export const DIRECT_MEDIA_URL = "https://cdn.example/private-source.mp4";
export const JOB_ID = "job_browser_component_42";
export const FILE_ID = "file_browser_component_42";
export const CREATED_AT = "2026-07-11T12:00:00.000Z";
export const EXPIRES_AT = "2026-07-11T13:00:00.000Z";

export const VIDEO_METADATA: VideoMetadata = Object.freeze({
  id: "public-video-42",
  originalUrl: PUBLIC_PAGE_URL,
  title: "Публичное тестовое видео",
  durationSeconds: 90,
  platform: "Public Media",
  formats: [
    {
      id: "format-720",
      label: "720p MP4",
      quality: "720p",
      ext: "mp4",
      width: 1280,
      height: 720,
      hasVideo: true,
      hasAudio: true
    },
    {
      id: "format-1080",
      label: "1080p MP4",
      quality: "1080p",
      ext: "mp4",
      width: 1920,
      height: 1080,
      hasVideo: true,
      hasAudio: true
    }
  ]
});

export const FAST_POLLING_POLICY = Object.freeze({
  firstPollDelayMs: 20,
  regularPollDelayMs: 20,
  requestTimeoutMs: 250,
  maxPollingDurationMs: 500,
  maxConsecutiveFailures: 2,
  maxRetryAfterMs: 100,
  networkBackoffMs: Object.freeze([10, 10])
});

export type RecordedFetchCall = Readonly<{
  path: string;
  method: string;
  body: string | null;
  credentials: RequestCredentials | undefined;
}>;

export type ScenarioRequest = Readonly<{
  path: string;
  method: string;
  body: string | null;
  signal: AbortSignal | null;
}>;

export type FetchStep = Response | Error | ((request: ScenarioRequest) => Response | Promise<Response>);

export type DeferredResponse = Readonly<{
  step: FetchStep;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  getSignal: () => AbortSignal | null;
}>;

export function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export function success<T>(data: T, status = 200): Response {
  return jsonResponse(status, { ok: true, data });
}

export function failure(code: ApiErrorCode, message: string, status: number): Response {
  return jsonResponse(status, { ok: false, error: { code, message } });
}

export function createJobData(preset: ProcessingPreset = "original", jobId = JOB_ID): CreateDownloadJobData {
  return {
    jobId,
    status: "queued",
    progress: 0,
    processingPreset: preset,
    createdAt: CREATED_AT,
    expiresAt: null,
    statusUrl: `/api/jobs/${jobId}`,
    cancelUrl: `/api/jobs/${jobId}`
  };
}

export function readyResult(
  preset: ProcessingPreset = "original",
  overrides: Partial<MediaJobApiResult> = {}
): MediaJobApiResult {
  const audioOnly = preset === "audio-only";
  return {
    fileId: FILE_ID,
    filename: audioOnly ? "public-video.m4a" : "public-video.mp4",
    mimeType: audioOnly ? "audio/mp4" : "video/mp4",
    sizeBytes: 1_572_864,
    downloadUrl: `/api/file/${FILE_ID}`,
    expiresAt: EXPIRES_AT,
    processingPreset: preset,
    media: {
      durationSeconds: 90,
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      hasVideo: !audioOnly,
      hasAudio: true,
      ...(!audioOnly ? { width: 1920, height: 1080, videoCodec: "h264" } : {}),
      audioCodec: "aac"
    },
    ...overrides
  };
}

export function jobSnapshot(
  status: MediaJobApiSnapshot["status"],
  options: Readonly<{
    preset?: ProcessingPreset;
    progress?: number;
    result?: MediaJobApiResult;
    errorCode?: ApiErrorCode;
    errorMessage?: string;
    jobId?: string;
  }> = {}
): MediaJobApiSnapshot {
  const preset = options.preset ?? "original";
  const jobId = options.jobId ?? JOB_ID;
  const common = {
    jobId,
    progress: options.progress ?? (status === "ready" ? 100 : status === "running" ? 48 : 0),
    processingPreset: preset,
    createdAt: CREATED_AT,
    startedAt: status === "queued" ? null : CREATED_AT,
    completedAt: ["ready", "failed", "cancelled"].includes(status) ? CREATED_AT : null,
    expiresAt: ["ready", "failed", "cancelled", "expired"].includes(status) ? EXPIRES_AT : null
  };
  switch (status) {
    case "ready":
      return { ...common, status, result: options.result ?? readyResult(preset) };
    case "failed":
      return {
        ...common,
        status,
        error: {
          code: options.errorCode ?? API_ERROR_CODES.PROCESSING_FAILED,
          message: options.errorMessage ?? "Не удалось обработать медиафайл."
        }
      };
    case "queued":
    case "running":
    case "cancelled":
    case "expired":
      return { ...common, status };
    default: {
      const exhaustive: never = status;
      throw new TypeError(String(exhaustive));
    }
  }
}

export function deferredResponse({ rejectOnAbort = false }: { rejectOnAbort?: boolean } = {}): DeferredResponse {
  let resolvePromise!: (response: Response) => void;
  let rejectPromise!: (error: Error) => void;
  let signal: AbortSignal | null = null;
  const step: FetchStep = (request) => {
    signal = request.signal;
    return new Promise<Response>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
      if (rejectOnAbort) {
        request.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      }
    });
  };
  return Object.freeze({
    step,
    resolve: (response) => resolvePromise(response),
    reject: (error) => rejectPromise(error),
    getSignal: () => signal
  });
}

export class MediaJobFetchScenario {
  readonly calls: RecordedFetchCall[] = [];
  readonly extractSteps: FetchStep[] = [success(VIDEO_METADATA)];
  readonly downloadSteps: FetchStep[] = [success(createJobData(), 202)];
  readonly getSteps: FetchStep[] = [];
  readonly deleteSteps: FetchStep[] = [];
  getFallback: FetchStep | null = null;
  maxConcurrentGets = 0;
  private concurrentGets = 0;

  get extractCalls(): readonly RecordedFetchCall[] {
    return this.calls.filter((call) => call.path === "/api/extract" && call.method === "POST");
  }

  get downloadCalls(): readonly RecordedFetchCall[] {
    return this.calls.filter((call) => call.path === "/api/download" && call.method === "POST");
  }

  get pollCalls(): readonly RecordedFetchCall[] {
    return this.calls.filter((call) => call.path === `/api/jobs/${JOB_ID}` && call.method === "GET");
  }

  get cancelCalls(): readonly RecordedFetchCall[] {
    return this.calls.filter((call) => call.path === `/api/jobs/${JOB_ID}` && call.method === "DELETE");
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    this.calls.push(Object.freeze({ path, method, body, credentials: init?.credentials }));

    let step: FetchStep | undefined;
    let polling = false;
    if (path === "/api/extract" && method === "POST") step = this.extractSteps.shift();
    else if (path === "/api/download" && method === "POST") step = this.downloadSteps.shift();
    else if (path === `/api/jobs/${JOB_ID}` && method === "GET") {
      step = this.getSteps.shift() ?? this.getFallback ?? undefined;
      polling = true;
    } else if (path === `/api/jobs/${JOB_ID}` && method === "DELETE") step = this.deleteSteps.shift();
    else throw new TypeError("Browser test blocked a non-canonical request.");

    if (!step) throw new TypeError("Browser test scenario has no response for this canonical request.");
    if (step instanceof Error) throw step;

    if (polling) {
      this.concurrentGets += 1;
      this.maxConcurrentGets = Math.max(this.maxConcurrentGets, this.concurrentGets);
    }
    try {
      return typeof step === "function"
        ? await step(Object.freeze({ path, method, body, signal }))
        : step;
    } finally {
      if (polling) this.concurrentGets -= 1;
    }
  };
}
