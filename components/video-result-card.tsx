import { Icon } from "@/components/icons";
import { StatusMessage } from "@/components/status-message";
import {
  MEDIA_PRESET_OPTIONS,
  getPresetRunningMessage,
  getPresetSubmitLabel,
  getPresetTitle,
  type UserProcessingPreset
} from "@/lib/client/media-preset-options";
import { getSafeResultSummary } from "@/lib/client/media-result-ui";
import {
  canCancelJob,
  canDownloadFile,
  canRetryJobSubmit,
  canSubmitJob,
  getSafeStatusMessage,
  getVisibleProgress,
  type MediaDownloadUiState,
  type MediaJobSelection
} from "@/lib/client/media-job-state";

type VideoResultCardProps = Readonly<{
  state: MediaDownloadUiState;
  cancellationPending: boolean;
  cancellationError: string | null;
  onQualityChange: (qualityId: string) => void;
  onPresetChange: (preset: UserProcessingPreset) => void;
  onRightsChange: (confirmed: boolean) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onDownload: (jobId: string) => void;
  onStartNew: () => void;
  onRetryStatus: () => void;
  onRetrySubmit: () => void;
}>;

const primaryButton = "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 py-3 text-center text-sm font-bold text-white transition hover:bg-[#254FDD] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-200 disabled:cursor-not-allowed disabled:bg-slate-300";
const secondaryButton = "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-3 text-center text-sm font-bold text-ink transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-60";

function MediaHeader({ selection }: { selection: MediaJobSelection }) {
  const result = selection.media;
  return (
    <div className="grid min-w-0 gap-4 sm:grid-cols-[168px_minmax(0,1fr)]">
      <div className="flex aspect-video items-center justify-center rounded-xl bg-gradient-to-br from-[#DDE6FF] via-white to-[#DFF8EF] text-brand sm:aspect-[4/3]">
        <Icon name="play" className="h-10 w-10" />
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="max-w-full break-words rounded-lg bg-blue-50 px-2.5 py-1 text-xs font-bold text-brand">{result.platform}</span>
          <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">{result.duration}</span>
        </div>
        <h3 className="mt-3 break-words text-lg font-extrabold leading-snug tracking-[-.03em] text-ink [overflow-wrap:anywhere]">{result.title}</h3>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          Выберите качество и способ подготовки файла.
        </p>
      </div>
    </div>
  );
}

function SelectionView({
  state,
  onQualityChange,
  onPresetChange,
  onRightsChange,
  onSubmit
}: Pick<VideoResultCardProps, "state" | "onQualityChange" | "onPresetChange" | "onRightsChange" | "onSubmit">) {
  if (state.status !== "selection-ready" && state.status !== "submitting") return null;
  const { selection } = state;
  const locked = state.status === "submitting";
  const submitAllowed = canSubmitJob(state);

  return (
    <article className="min-w-0 rounded-2xl border border-slate-100 bg-white p-4 shadow-card sm:p-5">
      <MediaHeader selection={selection} />

      <fieldset disabled={locked} aria-disabled={locked} className="mt-5 disabled:opacity-70">
        <legend className="text-sm font-bold text-ink">Качество и формат</legend>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {selection.media.qualities.map((quality, index) => {
            const inputId = `video-quality-${index}`;
            const descriptionId = `${inputId}-description`;
            return (
              <div key={quality.id} className="relative min-w-0">
                <input
                  id={inputId}
                  type="radio"
                  name="video-quality"
                  checked={selection.selectedFormatId === quality.id}
                  onChange={() => onQualityChange(quality.id)}
                  aria-describedby={descriptionId}
                  className="peer sr-only"
                />
                <label
                  htmlFor={inputId}
                  className="flex min-h-full cursor-pointer items-start gap-3 rounded-xl border border-slate-200 px-3 py-3 transition hover:border-blue-200 peer-checked:border-brand peer-checked:bg-blue-50/70 peer-focus-visible:outline-none peer-focus-visible:ring-4 peer-focus-visible:ring-blue-200 peer-disabled:cursor-not-allowed"
                >
                  <span aria-hidden="true" className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 border-slate-300 bg-white text-brand">
                    {selection.selectedFormatId === quality.id && <span className="h-2 w-2 rounded-full bg-brand" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block break-words text-sm font-bold text-ink">{quality.label}</span>
                    <span id={descriptionId} className="mt-0.5 block break-words text-xs leading-5 text-slate-500">{quality.meta}</span>
                  </span>
                </label>
              </div>
            );
          })}
        </div>
      </fieldset>

      <fieldset disabled={locked} aria-disabled={locked} className="mt-6 disabled:opacity-70">
        <legend className="text-sm font-bold text-ink">Что подготовить</legend>
        <div className="mt-3 grid gap-3">
          {MEDIA_PRESET_OPTIONS.map((option) => {
            const inputId = `processing-preset-${option.value}`;
            const descriptionId = `${inputId}-description`;
            return (
              <div key={option.value} className="relative min-w-0">
                <input
                  id={inputId}
                  type="radio"
                  name="processing-preset"
                  checked={selection.processingPreset === option.value}
                  onChange={() => onPresetChange(option.value)}
                  aria-describedby={descriptionId}
                  className="peer sr-only"
                />
                <label
                  htmlFor={inputId}
                  className="block cursor-pointer rounded-xl border border-slate-200 px-4 py-3 transition hover:border-blue-200 peer-checked:border-brand peer-checked:bg-blue-50/70 peer-focus-visible:outline-none peer-focus-visible:ring-4 peer-focus-visible:ring-blue-200 peer-disabled:cursor-not-allowed"
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="break-words text-sm font-bold text-ink">{option.title}</span>
                    {selection.processingPreset === option.value && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-blue-100 px-2 py-0.5 text-xs font-bold text-brand">
                        <Icon name="check" className="h-3.5 w-3.5" />
                        Выбрано
                      </span>
                    )}
                    {option.benefit && <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800">{option.benefit}</span>}
                  </span>
                  <span id={descriptionId} className="mt-1 block break-words text-xs leading-5 text-slate-600">
                    {option.description}
                    {option.value === "audio-only" && <span className="block font-semibold text-ink">Результат: M4A.</span>}
                    {option.note && <span className="block text-slate-500">{option.note}</span>}
                  </span>
                </label>
              </div>
            );
          })}
        </div>
      </fieldset>

      <label className={`mt-5 flex items-start gap-3 rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950 ${locked ? "cursor-not-allowed opacity-70" : "cursor-pointer"}`}>
        <input
          type="checkbox"
          checked={selection.rightsConfirmed}
          disabled={locked}
          onChange={(event) => onRightsChange(event.target.checked)}
          className="mt-1 h-4 w-4 shrink-0 accent-brand focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-200"
        />
        <span>Я подтверждаю, что скачиваю своё видео или контент, на который у меня есть разрешение.</span>
      </label>

      <button
        type="button"
        disabled={!submitAllowed}
        aria-disabled={!submitAllowed}
        onClick={onSubmit}
        className={`mt-4 ${primaryButton}`}
      >
        <Icon name={locked ? "sparkle" : "arrow"} className="h-4 w-4 shrink-0" />
        {locked ? "Создаём задачу…" : getPresetSubmitLabel(selection.processingPreset)}
      </button>

      {!selection.rightsConfirmed && !locked && (
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Для создания задачи необходимо подтвердить права на контент.
        </p>
      )}
    </article>
  );
}

function ActiveJobView({
  state,
  cancellationPending,
  cancellationError,
  onCancel
}: Pick<VideoResultCardProps, "state" | "cancellationPending" | "cancellationError" | "onCancel">) {
  if (state.status !== "queued" && state.status !== "running") return null;
  const progress = getVisibleProgress(state) ?? 0;
  const safeProgress = Math.round(Math.min(100, Math.max(0, progress)));
  const statusText = cancellationPending
    ? "Отменяем подготовку файла"
    : state.status === "queued"
      ? "Задача поставлена в очередь"
      : getPresetRunningMessage(state.selection.processingPreset);

  return (
    <article className="min-w-0 rounded-2xl border border-blue-100 bg-white p-4 shadow-card sm:p-5" aria-labelledby="active-job-title">
      <StatusMessage
        tone="progress"
        title={statusText}
        text={`Выбранный режим: ${getPresetTitle(state.selection.processingPreset)}.`}
      />
      <div className="mt-5">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span id="active-job-title" className="font-bold text-ink">Подготовка файла</span>
          <span className="shrink-0 font-bold tabular-nums text-brand">{safeProgress}%</span>
        </div>
        <div
          role="progressbar"
          aria-label="Прогресс подготовки файла"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={safeProgress}
          className="mt-2 h-3 overflow-hidden rounded-full bg-slate-100"
        >
          <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${safeProgress}%` }} />
        </div>
      </div>

      <button
        type="button"
        disabled={cancellationPending || !canCancelJob(state)}
        aria-disabled={cancellationPending || !canCancelJob(state)}
        onClick={onCancel}
        className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-red-200 bg-white px-5 py-3 text-sm font-bold text-red-700 transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-100 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Icon name={cancellationPending ? "sparkle" : "x"} className="h-4 w-4 shrink-0" />
        {cancellationPending ? "Отменяем…" : "Отменить"}
      </button>

      {cancellationError && (
        <div className="mt-3">
          <StatusMessage tone="error" title="Отмена не подтверждена" text={cancellationError} />
        </div>
      )}
    </article>
  );
}

function ReadyView({ state, onDownload, onStartNew }: Pick<VideoResultCardProps, "state" | "onDownload" | "onStartNew">) {
  if (state.status !== "ready" && state.status !== "downloading" && state.status !== "success") return null;
  const summary = getSafeResultSummary(state.result, state.selection.processingPreset);
  const downloadable = state.status === "ready" && canDownloadFile(state) && summary !== null;

  return (
    <article className="min-w-0 rounded-2xl border border-emerald-100 bg-white p-4 shadow-card sm:p-5">
      <StatusMessage
        tone="success"
        title={state.status === "success" ? "Скачивание началось" : "Файл готов"}
        text={state.status === "success" ? "Запрос на скачивание передан браузеру." : "Проверьте данные и нажмите «Скачать файл»."}
      />

      {summary ? (
        <div className="mt-5 min-w-0 rounded-xl bg-slate-50 p-4">
          <p className="text-xs font-bold uppercase tracking-[.12em] text-slate-500">Итоговый файл</p>
          <p className="mt-2 break-words text-base font-extrabold text-ink [overflow-wrap:anywhere]">{summary.filename}</p>
          <dl className="mt-4 grid min-w-0 gap-3 text-sm sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-slate-500">Режим</dt>
              <dd className="mt-1 break-words font-bold text-ink">{getPresetTitle(state.selection.processingPreset)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-slate-500">Формат и MIME</dt>
              <dd className="mt-1 break-words font-bold text-ink [overflow-wrap:anywhere]">{summary.formatLabel}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Размер</dt>
              <dd className="mt-1 font-bold text-ink">{summary.sizeLabel}</dd>
            </div>
          </dl>
          <ul className="mt-4 flex min-w-0 flex-wrap gap-2" aria-label="Параметры готового файла">
            {summary.details.map((detail) => (
              <li key={detail} className="max-w-full break-words rounded-lg bg-white px-2.5 py-1 text-xs font-semibold text-slate-600">{detail}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="mt-4">
          <StatusMessage tone="error" title="Файл недоступен для скачивания" text="Сервер не вернул безопасную ссылку на готовый файл." />
        </div>
      )}

      {downloadable && summary && (
        <a
          href={summary.downloadUrl}
          download={summary.filename}
          onClick={() => onDownload(state.jobId)}
          className={`mt-5 ${primaryButton}`}
        >
          <Icon name="download" className="h-4 w-4 shrink-0" />
          Скачать файл
        </a>
      )}

      <button type="button" onClick={onStartNew} className={`mt-3 ${secondaryButton}`}>
        <Icon name="arrow" className="h-4 w-4 shrink-0" />
        Подготовить другой файл
      </button>
    </article>
  );
}

function TerminalView({
  state,
  onStartNew,
  onRetryStatus,
  onRetrySubmit
}: Pick<VideoResultCardProps, "state" | "onStartNew" | "onRetryStatus" | "onRetrySubmit">) {
  if (!["failed", "cancelled", "expired", "network-error", "polling-timeout"].includes(state.status)) return null;

  const title = state.status === "failed"
    ? "Не удалось подготовить файл"
    : state.status === "cancelled"
      ? "Подготовка файла отменена"
      : state.status === "expired"
        ? "Срок хранения файла истёк"
        : state.status === "network-error"
          ? "Не удалось получить статус задачи"
          : "Подготовка занимает больше времени, чем ожидалось";
  const tone = state.status === "failed" || state.status === "network-error" ? "error" : "warning";
  const canRetryStatus = state.status === "polling-timeout" || (state.status === "network-error" && Boolean(state.jobId));
  const canRetrySubmit = canRetryJobSubmit(state);

  return (
    <article className="min-w-0 rounded-2xl border border-slate-100 bg-white p-4 shadow-card sm:p-5">
      <StatusMessage tone={tone} title={title} text={getSafeStatusMessage(state)} />

      {canRetryStatus && (
        <button type="button" onClick={onRetryStatus} className={`mt-4 ${primaryButton}`}>
          <Icon name="arrow" className="h-4 w-4 shrink-0" />
          Повторить
        </button>
      )}
      {canRetrySubmit && (
        <button type="button" onClick={onRetrySubmit} className={`mt-4 ${primaryButton}`}>
          <Icon name="arrow" className="h-4 w-4 shrink-0" />
          Повторить
        </button>
      )}
      <button type="button" onClick={onStartNew} className={`mt-3 ${secondaryButton}`}>
        <Icon name="arrow" className="h-4 w-4 shrink-0" />
        Начать заново
      </button>
    </article>
  );
}

export function VideoResultCard(props: VideoResultCardProps) {
  if (!("selection" in props.state) || !props.state.selection) return null;
  return (
    <div className="min-w-0">
      <SelectionView {...props} />
      <ActiveJobView {...props} />
      <ReadyView {...props} />
      <TerminalView {...props} />
    </div>
  );
}
