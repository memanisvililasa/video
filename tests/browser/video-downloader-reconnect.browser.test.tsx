import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { VideoDownloader } from "@/components/video-downloader";
import { MEDIA_JOB_SESSION_STORAGE_KEY } from "@/lib/client/media-job-state";
import {
  FAST_POLLING_POLICY,
  MediaJobFetchScenario,
  PUBLIC_PAGE_URL,
  VIDEO_METADATA,
  jobSnapshot,
  success
} from "@/tests/browser/helpers/media-job-fetch-scenario";

const RIGHTS_LABEL = "Я подтверждаю, что скачиваю своё видео или контент, на который у меня есть разрешение.";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VideoDownloader session reconnect", () => {
  it("resumes a live local job after remount without persisting or resubmitting its source URL", async () => {
    const initialScenario = new MediaJobFetchScenario();
    vi.stubGlobal("fetch", initialScenario.fetch);
    const initial = await render(
      <VideoDownloader pollingPolicy={{ ...FAST_POLLING_POLICY, firstPollDelayMs: 500 }} />
    );
    await userEvent.fill(initial.getByLabelText("Ссылка на видео"), PUBLIC_PAGE_URL);
    await userEvent.click(initial.getByRole("button", { name: "Проверить ссылку" }));
    await expect.element(initial.getByText(VIDEO_METADATA.title)).toBeVisible();
    await userEvent.click(initial.getByLabelText(RIGHTS_LABEL));
    await userEvent.click(initial.getByRole("button", { name: "Подготовить оригинал" }));
    await expect.element(initial.getByText("Задача поставлена в очередь")).toBeVisible();

    const persisted = globalThis.sessionStorage.getItem(MEDIA_JOB_SESSION_STORAGE_KEY);
    expect(persisted).not.toBeNull();
    expect(persisted).not.toContain(PUBLIC_PAGE_URL);
    expect(persisted).not.toMatch(/sourceUrl|rightsConfirmed":true|cookie|authorization/i);
    await initial.unmount();

    const reconnectScenario = new MediaJobFetchScenario();
    reconnectScenario.getSteps.push(success(jobSnapshot("ready")));
    vi.stubGlobal("fetch", reconnectScenario.fetch);
    const reconnected = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);

    await expect.element(reconnected.getByRole("link", { name: "Скачать файл" })).toBeVisible();
    await expect.element(reconnected.getByText("public-video.mp4")).toBeVisible();
    expect(reconnectScenario.extractCalls).toHaveLength(0);
    expect(reconnectScenario.downloadCalls).toHaveLength(0);
    expect(reconnectScenario.pollCalls).toHaveLength(1);
  });

  it("rejects and removes a malformed URL-bearing persisted payload", async () => {
    globalThis.sessionStorage.setItem(MEDIA_JOB_SESSION_STORAGE_KEY, JSON.stringify({
      version: 1,
      sourceUrl: "https://private.example/video.mp4?token=secret"
    }));
    const scenario = new MediaJobFetchScenario();
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);

    await expect.element(screen.getByRole("button", { name: "Проверить ссылку" })).toBeVisible();
    expect(globalThis.sessionStorage.getItem(MEDIA_JOB_SESSION_STORAGE_KEY)).toBeNull();
    expect(scenario.calls).toHaveLength(0);
  });
});
