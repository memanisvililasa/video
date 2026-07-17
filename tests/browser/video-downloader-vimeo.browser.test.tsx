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

const VIMEO_URL = "https://vimeo.com/123456789";
const RIGHTS_LABEL = "Я подтверждаю, что скачиваю своё видео или контент, на который у меня есть разрешение.";
const VIMEO_METADATA: VideoMetadata = Object.freeze({
  id: "vimeo-fixture",
  originalUrl: "https://vimeo.com/",
  title: "Публичное Vimeo-видео",
  durationSeconds: 90,
  platform: "Vimeo",
  formats: [
    { id: "pf_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", label: "1080p MP4", quality: "1080p", ext: "mp4", width: 1920, height: 1080, hasVideo: true, hasAudio: true },
    { id: "pf_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", label: "720p MP4", quality: "720p", ext: "mp4", width: 1280, height: 720, hasVideo: true, hasAudio: true }
  ]
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VideoDownloader public Vimeo flow", () => {
  it.each([1, 2, 3])("repeats Vimeo metadata → format → job → ready flow deterministically (%s/3)", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.extractSteps[0] = success(VIMEO_METADATA);
    scenario.downloadSteps[0] = success(createJobData("compatible-mp4"), 202);
    scenario.getSteps.push(
      success(jobSnapshot("running", { preset: "compatible-mp4", progress: 60 })),
      success(jobSnapshot("ready", { preset: "compatible-mp4" }))
    );
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);

    await userEvent.fill(screen.getByLabelText("Ссылка на видео"), VIMEO_URL);
    await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
    await expect.element(screen.getByText(VIMEO_METADATA.title)).toBeVisible();
    const qualityGroup = screen.getByRole("group", { name: "Качество и формат" });
    await expect.element(qualityGroup.getByRole("radio", { name: /1080p/ })).toBeVisible();
    await expect.element(screen.getByText("1920 × 1080 · Контейнер: MP4 · с аудио")).toBeVisible();
    await userEvent.click(screen.getByText("720p", { exact: true }));
    await userEvent.click(screen.getByText("Совместимый MP4", { exact: true }));
    await userEvent.click(screen.getByLabelText(RIGHTS_LABEL));
    await userEvent.click(screen.getByRole("button", { name: "Подготовить MP4" }));
    await expect.element(screen.getByRole("link", { name: "Скачать файл" })).toBeVisible();

    const request = JSON.parse(scenario.downloadCalls[0]?.body ?? "null") as Record<string, unknown>;
    expect(request).toEqual({
      url: VIMEO_URL,
      formatId: VIMEO_METADATA.formats[1].id,
      processingPreset: "compatible-mp4",
      rightsConfirmed: true
    });
    expect(JSON.stringify(request)).not.toMatch(/cdn|signed|mediaUrl|cookies|headers/i);
    expect(document.body.textContent).not.toMatch(/media\.example|signature=/i);
    await screen.unmount();
    vi.unstubAllGlobals();
  });

  it.each([
    [API_ERROR_CODES.PRIVATE_CONTENT, "Приватный контент не поддерживается.", 403],
    [API_ERROR_CODES.LOGIN_REQUIRED, "Для этого видео требуется авторизация.", 401]
  ] as const)("shows safe Vimeo restriction error %s", async (code, message, status) => {
    const scenario = new MediaJobFetchScenario();
    scenario.extractSteps[0] = failure(code, message, status);
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await userEvent.fill(screen.getByLabelText("Ссылка на видео"), VIMEO_URL);
    await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
    await expect.element(screen.getByText(message)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/stderr|yt-dlp|https:\/\/.*cdn/i);
  });

  it("keeps other platform pages unsupported", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.extractSteps[0] = failure(API_ERROR_CODES.UNSUPPORTED_URL, "Этот источник пока не поддерживается.", 400);
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await userEvent.fill(screen.getByLabelText("Ссылка на видео"), "https://www.youtube.com/watch?v=fixture");
    await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
    await expect.element(screen.getByText("Этот источник пока не поддерживается.")).toBeVisible();
  });

  it("does not persist a Vimeo page URL across reconnect and does not publish after cancellation", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.extractSteps[0] = success(VIMEO_METADATA);
    scenario.deleteSteps.push(success(jobSnapshot("cancelled")));
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={{ ...FAST_POLLING_POLICY, firstPollDelayMs: 500 }} />);
    await userEvent.fill(screen.getByLabelText("Ссылка на видео"), VIMEO_URL);
    await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
    await expect.element(screen.getByText(VIMEO_METADATA.title)).toBeVisible();
    await userEvent.click(screen.getByLabelText(RIGHTS_LABEL));
    await userEvent.click(screen.getByRole("button", { name: "Подготовить оригинал" }));
    const persisted = globalThis.sessionStorage.getItem(MEDIA_JOB_SESSION_STORAGE_KEY) ?? "";
    expect(persisted).not.toContain(VIMEO_URL);
    expect(persisted).not.toMatch(/sourceUrl|cdn|signature/i);
    await userEvent.click(screen.getByRole("button", { name: "Отменить" }));
    await expect.element(screen.getByText("Подготовка файла отменена").first()).toBeVisible();
    expect(screen.getByRole("link", { name: "Скачать файл" }).query()).toBeNull();
  });
});
