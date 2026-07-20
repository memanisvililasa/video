import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { VideoDownloader } from "@/components/video-downloader";
import { MEDIA_JOB_SESSION_STORAGE_KEY } from "@/lib/client/media-job-state";
import { API_ERROR_CODES, type VideoMetadata } from "@/lib/types";
import {
  FAST_POLLING_POLICY,
  MediaJobFetchScenario,
  createJobData,
  failure,
  jobSnapshot,
  success
} from "@/tests/browser/helpers/media-job-fetch-scenario";

const REDDIT_URL = "https://www.reddit.com/r/videos/comments/abc123/owner_authorized_fixture/?utm_source=share";
const RIGHTS_LABEL = "Я подтверждаю, что скачиваю своё видео или контент, на который у меня есть разрешение.";
const REDDIT_METADATA: VideoMetadata = Object.freeze({
  id: "reddit-fixture",
  originalUrl: "https://www.reddit.com/",
  title: "Публичное Reddit-видео",
  durationSeconds: 42,
  platform: "Reddit",
  formats: [
    { id: "rf_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", label: "1080p MP4", quality: "1080p", ext: "mp4", width: 1920, height: 1080, hasVideo: true, hasAudio: true },
    { id: "rf_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", label: "720p MP4", quality: "720p", ext: "mp4", width: 1280, height: 720, hasVideo: true, hasAudio: true }
  ]
});

const SILENT_REDDIT_METADATA: VideoMetadata = Object.freeze({
  ...REDDIT_METADATA,
  id: "reddit-silent-fixture",
  title: "Публичное Reddit-видео без аудио",
  formats: [
    { id: "rf_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", label: "720p MP4 · без аудио", quality: "720p", ext: "mp4", width: 1280, height: 720, hasVideo: true, hasAudio: false }
  ]
});

afterEach(() => vi.unstubAllGlobals());

describe("VideoDownloader public Reddit-hosted video flow", () => {
  it.each([1, 2, 3])("repeats Reddit metadata → format → job → ready deterministically (%s/3)", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.extractSteps[0] = success(REDDIT_METADATA);
    scenario.downloadSteps[0] = success(createJobData("compatible-mp4"), 202);
    scenario.getSteps.push(
      success(jobSnapshot("running", { preset: "compatible-mp4", progress: 64 })),
      success(jobSnapshot("ready", { preset: "compatible-mp4" }))
    );
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);

    await userEvent.fill(screen.getByLabelText("Ссылка на видео"), REDDIT_URL);
    await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
    await expect.element(screen.getByText(REDDIT_METADATA.title)).toBeVisible();
    await expect.element(screen.getByText("1920 × 1080 · Контейнер: MP4 · с аудио")).toBeVisible();
    await userEvent.click(screen.getByText("720p", { exact: true }));
    await userEvent.click(screen.getByText("Совместимый MP4", { exact: true }));
    await userEvent.click(screen.getByLabelText(RIGHTS_LABEL));
    await userEvent.click(screen.getByRole("button", { name: "Подготовить MP4" }));
    await expect.element(screen.getByRole("link", { name: "Скачать файл" })).toBeVisible();

    const request = JSON.parse(scenario.downloadCalls[0]?.body ?? "null") as Record<string, unknown>;
    expect(request).toEqual({
      url: REDDIT_URL,
      formatId: REDDIT_METADATA.formats[1].id,
      processingPreset: "compatible-mp4",
      rightsConfirmed: true
    });
    expect(JSON.stringify(request)).not.toMatch(/v\.redd\.it|DASH_|audio_url|fallback_url|mediaUrl|cookie|header/i);
    expect(document.body.textContent).not.toMatch(/v\.redd\.it|DASH_|audio_url|fallback_url|stderr/i);
    await screen.unmount();
    vi.unstubAllGlobals();
  });

  it.each([
    [API_ERROR_CODES.EXTERNAL_MEDIA_NOT_SUPPORTED, "Пост содержит видео с неподдерживаемого внешнего источника.", 422],
    [API_ERROR_CODES.GALLERY_NOT_SUPPORTED, "Галереи Reddit не поддерживаются.", 422],
    [API_ERROR_CODES.POST_HAS_NO_VIDEO, "Пост не содержит поддерживаемого видео.", 422],
    [API_ERROR_CODES.LOGIN_REQUIRED, "Для этого видео требуется авторизация.", 401]
  ] as const)("shows safe Reddit restriction error %s", async (code, message, status) => {
    const scenario = new MediaJobFetchScenario();
    scenario.extractSteps[0] = failure(code, message, status);
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await userEvent.fill(screen.getByLabelText("Ссылка на видео"), REDDIT_URL);
    await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
    await expect.element(screen.getByText(message)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/v\.redd\.it|DASH_|audio_url|fallback_url|stderr|cookie/i);
  });

  it("shows silent-video truth, keeps the source URL out of session state, and never publishes after cancellation", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.extractSteps[0] = success(SILENT_REDDIT_METADATA);
    scenario.deleteSteps.push(success(jobSnapshot("cancelled")));
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={{ ...FAST_POLLING_POLICY, firstPollDelayMs: 500 }} />);
    await userEvent.fill(screen.getByLabelText("Ссылка на видео"), REDDIT_URL);
    await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
    await expect.element(screen.getByText(SILENT_REDDIT_METADATA.title)).toBeVisible();
    await expect.element(screen.getByText("1280 × 720 · Контейнер: MP4 · без аудио")).toBeVisible();
    await userEvent.click(screen.getByLabelText(RIGHTS_LABEL));
    await userEvent.click(screen.getByRole("button", { name: "Подготовить оригинал" }));
    const persisted = sessionStorage.getItem(MEDIA_JOB_SESSION_STORAGE_KEY) ?? "";
    expect(persisted).not.toContain(REDDIT_URL);
    expect(persisted).not.toMatch(/sourceUrl|v\.redd\.it|DASH_|audio_url|fallback_url/i);
    await userEvent.click(screen.getByRole("button", { name: "Отменить" }));
    await expect.element(screen.getByText("Подготовка файла отменена").first()).toBeVisible();
    expect(screen.getByRole("link", { name: "Скачать файл" }).query()).toBeNull();
  });

  it("keeps TikTok pages unsupported", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.extractSteps[0] = failure(API_ERROR_CODES.UNSUPPORTED_URL, "Этот источник пока не поддерживается.", 400);
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await userEvent.fill(screen.getByLabelText("Ссылка на видео"), "https://www.tiktok.com/@creator/video/123456789");
    await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
    await expect.element(screen.getByText("Этот источник пока не поддерживается.")).toBeVisible();
  });
});
