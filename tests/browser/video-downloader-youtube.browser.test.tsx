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

const SHORTS_URL = "https://youtube.com/shorts/AbCdEfGhI_1?si=removed-by-server";
const RIGHTS_LABEL = "Я подтверждаю, что скачиваю своё видео или контент, на который у меня есть разрешение.";
const YOUTUBE_METADATA: VideoMetadata = Object.freeze({
  id: "youtube-fixture",
  originalUrl: "https://www.youtube.com/",
  title: "Публичный YouTube Short",
  durationSeconds: 30,
  platform: "YouTube",
  formats: [
    { id: "pf_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", label: "1080p MP4", quality: "1080p", ext: "mp4", width: 1080, height: 1920, hasVideo: true, hasAudio: true },
    { id: "pf_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", label: "720p MP4", quality: "720p", ext: "mp4", width: 720, height: 1280, hasVideo: true, hasAudio: true }
  ]
});

afterEach(() => vi.unstubAllGlobals());

describe("VideoDownloader public YouTube and Shorts flow", () => {
  it.each([1, 2, 3])("repeats Shorts metadata → pair selection → job → ready deterministically (%s/3)", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.extractSteps[0] = success(YOUTUBE_METADATA);
    scenario.downloadSteps[0] = success(createJobData("compatible-mp4"), 202);
    scenario.getSteps.push(
      success(jobSnapshot("running", { preset: "compatible-mp4", progress: 62 })),
      success(jobSnapshot("ready", { preset: "compatible-mp4", result: undefined }))
    );
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await userEvent.fill(screen.getByLabelText("Ссылка на видео"), SHORTS_URL);
    await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
    await expect.element(screen.getByText(YOUTUBE_METADATA.title)).toBeVisible();
    await expect.element(screen.getByText("1080 × 1920 · Контейнер: MP4 · с аудио")).toBeVisible();
    await userEvent.click(screen.getByText("720p", { exact: true }));
    await userEvent.click(screen.getByText("Совместимый MP4", { exact: true }));
    await userEvent.click(screen.getByLabelText(RIGHTS_LABEL));
    await userEvent.click(screen.getByRole("button", { name: "Подготовить MP4" }));
    await expect.element(screen.getByRole("link", { name: "Скачать файл" })).toBeVisible();
    const request = JSON.parse(scenario.downloadCalls[0]?.body ?? "null") as Record<string, unknown>;
    expect(request).toEqual({
      url: SHORTS_URL,
      formatId: YOUTUBE_METADATA.formats[1].id,
      processingPreset: "compatible-mp4",
      rightsConfirmed: true
    });
    expect(JSON.stringify(request)).not.toMatch(/googlevideo|videoplayback|mediaUrl|cookie|header/i);
    expect(document.body.textContent).not.toMatch(/googlevideo|videoplayback|yt-dlp|stderr/i);
    await screen.unmount();
    vi.unstubAllGlobals();
  });

  it.each([
    [API_ERROR_CODES.PRIVATE_CONTENT, "Приватный контент не поддерживается.", 403],
    [API_ERROR_CODES.LOGIN_REQUIRED, "Для этого видео требуется авторизация.", 401],
    [API_ERROR_CODES.MEMBERS_ONLY, "Видео только для участников или платных подписчиков не поддерживается.", 403],
    [API_ERROR_CODES.LIVE_NOT_SUPPORTED, "Прямые эфиры и премьеры не поддерживаются.", 422]
  ] as const)("shows safe YouTube restriction error %s", async (code, message, status) => {
    const scenario = new MediaJobFetchScenario();
    scenario.extractSteps[0] = failure(code, message, status);
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await userEvent.fill(screen.getByLabelText("Ссылка на видео"), SHORTS_URL);
    await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
    await expect.element(screen.getByText(message)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/stderr|yt-dlp|googlevideo|videoplayback/i);
  });

  it("keeps Reddit pages unsupported", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.extractSteps[0] = failure(API_ERROR_CODES.UNSUPPORTED_URL, "Этот источник пока не поддерживается.", 400);
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await userEvent.fill(screen.getByLabelText("Ссылка на видео"), "https://www.reddit.com/r/videos/comments/fixture");
    await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
    await expect.element(screen.getByText("Этот источник пока не поддерживается.")).toBeVisible();
  });

  it("does not persist a Shorts URL and cancellation never publishes a result", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.extractSteps[0] = success(YOUTUBE_METADATA);
    scenario.deleteSteps.push(success(jobSnapshot("cancelled")));
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={{ ...FAST_POLLING_POLICY, firstPollDelayMs: 500 }} />);
    await userEvent.fill(screen.getByLabelText("Ссылка на видео"), SHORTS_URL);
    await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
    await expect.element(screen.getByText(YOUTUBE_METADATA.title)).toBeVisible();
    await userEvent.click(screen.getByLabelText(RIGHTS_LABEL));
    await userEvent.click(screen.getByRole("button", { name: "Подготовить оригинал" }));
    const persisted = sessionStorage.getItem(MEDIA_JOB_SESSION_STORAGE_KEY) ?? "";
    expect(persisted).not.toContain(SHORTS_URL);
    expect(persisted).not.toMatch(/sourceUrl|googlevideo|videoplayback/i);
    await userEvent.click(screen.getByRole("button", { name: "Отменить" }));
    await expect.element(screen.getByText("Подготовка файла отменена").first()).toBeVisible();
    expect(screen.getByRole("link", { name: "Скачать файл" }).query()).toBeNull();
  });
});
