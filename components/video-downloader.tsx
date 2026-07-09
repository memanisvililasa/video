"use client";

import { FormEvent, useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import { StatusMessage } from "@/components/status-message";
import { VideoResultCard, type VideoResult } from "@/components/video-result-card";

type DownloaderState = "idle" | "validating" | "extracting" | "ready" | "downloading" | "success" | "error";

const mockResult: VideoResult = {
  platform: "Public video",
  title: "Публичное видео готово к проверке",
  duration: "03:42",
  qualities: [
    { id: "1080p", label: "MP4 1080p", meta: "Видео + аудио" },
    { id: "720p", label: "MP4 720p", meta: "Оптимальный размер" },
    { id: "audio", label: "Audio", meta: "Только звук" }
  ]
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

function getPlatformLabel(value: string): string {
  try {
    return new URL(value.trim()).hostname.replace(/^www\./, "");
  } catch {
    return "Public video";
  }
}

export function VideoDownloader() {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<DownloaderState>("idle");
  const [error, setError] = useState("");
  const [selectedQuality, setSelectedQuality] = useState(mockResult.qualities[0].id);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);

  const validationError = useMemo(() => validateUrl(url), [url]);
  const canSubmit = state !== "validating" && state !== "extracting" && state !== "downloading";
  const result = { ...mockResult, platform: getPlatformLabel(url) };

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const message = validateUrl(url);
    setError("");
    setRightsConfirmed(false);

    if (message) {
      setError(message);
      setState("error");
      return;
    }

    setState("validating");

    // Этап 2: безопасный frontend mock. Реальный API анализа ссылки будет подключён на Этапе 3.
    window.setTimeout(() => {
      setState("extracting");
      window.setTimeout(() => setState("ready"), 700);
    }, 450);
  }

  function handleDownload() {
    if (!rightsConfirmed) return;

    setState("downloading");

    // Этап 2: имитация клиентского состояния. Серверный download flow появится только на Этапе 3.
    window.setTimeout(() => setState("success"), 650);
  }

  function handleUrlChange(value: string) {
    setUrl(value);
    setError("");
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
            Вставьте URL, выберите качество и подтвердите права на контент. Сейчас работает только frontend mock без серверного скачивания.
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
              {state === "extracting" && <StatusMessage tone="loading" title="Получение данных" text="Имитируем клиентское состояние анализа. Backend пока не вызывается." />}
              {state === "error" && <StatusMessage tone="error" title="Ссылка не прошла проверку" text={error} />}
              {state === "success" && (
                <StatusMessage tone="success" title="Frontend flow завершён" text="На Этапе 3 эта кнопка будет получать подготовленный файл через API." />
              )}
            </div>
          </form>

          {(state === "ready" || state === "downloading" || state === "success") && (
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
