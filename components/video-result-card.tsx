import { Icon } from "@/components/icons";
import { StatusMessage } from "@/components/status-message";

export type VideoQuality = {
  id: string;
  label: string;
  meta: string;
};

export type VideoResult = {
  platform: string;
  title: string;
  duration: string;
  qualities: VideoQuality[];
};

export function VideoResultCard({
  result,
  selectedQuality,
  rightsConfirmed,
  isDownloading,
  onQualityChange,
  onRightsChange,
  onDownload
}: {
  result: VideoResult;
  selectedQuality: string;
  rightsConfirmed: boolean;
  isDownloading: boolean;
  onQualityChange: (qualityId: string) => void;
  onRightsChange: (confirmed: boolean) => void;
  onDownload: () => void;
}) {
  return (
    <article className="rounded-2xl border border-slate-100 bg-white p-4 shadow-card sm:p-5">
      <div className="grid gap-4 sm:grid-cols-[168px_1fr]">
        <div className="flex aspect-video items-center justify-center rounded-xl bg-gradient-to-br from-[#DDE6FF] via-white to-[#DFF8EF] text-brand sm:aspect-[4/3]">
          <Icon name="play" className="h-10 w-10" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-lg bg-blue-50 px-2.5 py-1 text-xs font-bold text-brand">{result.platform}</span>
            <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">{result.duration}</span>
          </div>
          <h3 className="mt-3 text-lg font-extrabold leading-snug tracking-[-.03em] text-ink">{result.title}</h3>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Metadata получены через API skeleton. Реальная подготовка файла и выдача download URL ещё не реализованы.
          </p>
        </div>
      </div>

      <fieldset className="mt-5">
        <legend className="text-sm font-bold text-ink">Качество</legend>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {result.qualities.map((quality) => (
            <label key={quality.id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-100 px-3 py-3 transition hover:border-blue-100">
              <input
                type="radio"
                name="quality"
                value={quality.id}
                checked={selectedQuality === quality.id}
                onChange={() => onQualityChange(quality.id)}
                className="mt-1 h-4 w-4 accent-brand"
              />
              <span>
                <span className="block text-sm font-bold text-ink">{quality.label}</span>
                <span className="block text-xs leading-5 text-slate-500">{quality.meta}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
        <input
          type="checkbox"
          checked={rightsConfirmed}
          onChange={(event) => onRightsChange(event.target.checked)}
          className="mt-1 h-4 w-4 accent-brand"
        />
        <span>Я подтверждаю, что скачиваю своё видео или контент, на который у меня есть разрешение.</span>
      </label>

      <button
        type="button"
        disabled={!rightsConfirmed || isDownloading}
        onClick={onDownload}
        className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 text-sm font-bold text-white transition hover:bg-[#254FDD] disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        <Icon name={isDownloading ? "sparkle" : "download"} className="h-4 w-4" />
        {isDownloading ? "Отправляем в API" : "Запросить подготовку"}
      </button>

      {!rightsConfirmed && (
        <div className="mt-4">
          <StatusMessage tone="warning" title="Нужно подтверждение прав" text="Кнопка скачивания активируется только после подтверждения прав на контент." />
        </div>
      )}
    </article>
  );
}
