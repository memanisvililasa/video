"use client";

import { useState } from "react";
import { Icon } from "@/components/icons";
import type { CheckVideoResponse } from "@/lib/types";

const DEMO_URL = "https://demo.videosave.local/allowed/creative-commons-clip";

export function LinkChecker() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<CheckVideoResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setResult(null);
    if (!url.trim()) { setError("Вставьте ссылку, чтобы продолжить."); return; }
    setIsLoading(true);
    try {
      const response = await fetch("/api/check-video", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: url.trim() }), cache: "no-store" });
      const data = await response.json() as CheckVideoResponse;
      if (!response.ok && data.status === "error") setError(data.message);
      else setResult(data);
    } catch {
      setError("Не удалось соединиться с сервисом. Проверьте подключение и повторите попытку.");
    } finally { setIsLoading(false); }
  }

  return (
    <div id="check" className="scroll-mt-24">
      <form onSubmit={submit} className="rounded-2xl border border-slate-200 bg-white p-2 shadow-soft sm:flex sm:items-center sm:gap-2 sm:p-2.5">
        <label className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 sm:px-4" aria-label="Ссылка на видео">
          <Icon name="link" className="h-5 w-5 shrink-0 text-slate-400" />
          <input value={url} onChange={(event) => setUrl(event.target.value)} type="url" inputMode="url" autoComplete="url" placeholder="Вставьте ссылку на видео" className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-slate-400" />
        </label>
        <button disabled={isLoading} type="submit" className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-6 py-3.5 text-sm font-bold text-white shadow-[0_10px_20px_rgba(53,99,246,.24)] transition hover:bg-[#254FDD] disabled:cursor-wait disabled:opacity-75 sm:w-auto">
          {isLoading ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />Проверяем…</> : <>Проверить <Icon name="arrow" className="h-4 w-4" /></>}
        </button>
      </form>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-500"><span>Поддерживаются только проверенные домены.</span><button type="button" onClick={() => setUrl(DEMO_URL)} className="font-semibold text-brand hover:text-[#254FDD]">Попробовать демо</button></div>
      {error && <div role="alert" className="mt-5 flex gap-3 rounded-2xl border border-rose-100 bg-rose-50 p-4 text-sm text-rose-800"><Icon name="info" className="h-5 w-5 shrink-0" />{error}</div>}
      {result?.status === "error" && <div role="alert" className="mt-5 flex gap-3 rounded-2xl border border-rose-100 bg-rose-50 p-4 text-sm text-rose-800"><Icon name="info" className="h-5 w-5 shrink-0" />{result.message}</div>}
      {result?.status === "not_allowed" && <NotAllowedResult result={result} />}
      {result?.status === "allowed" && <AllowedResult result={result} />}
    </div>
  );
}

function NotAllowedResult({ result }: { result: Extract<CheckVideoResponse, { status: "not_allowed" }> }) {
  return <section aria-live="polite" className="mt-6 overflow-hidden rounded-2xl border border-amber-200 bg-white shadow-card"><div className="flex gap-4 border-b border-amber-100 bg-amber-50 px-5 py-4"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white text-amber-600 shadow-sm"><Icon name="shield" className="h-5 w-5" /></span><div><p className="text-sm font-bold text-amber-950">Скачивание через VideoSave недоступно</p><p className="mt-1 text-sm leading-6 text-amber-800">{result.reason}</p></div></div><div className="p-5"><p className="text-xs font-bold uppercase tracking-[.12em] text-slate-400">{result.platform}</p><p className="mt-2 text-sm leading-6 text-slate-600">{result.officialOption}</p></div></section>;
}

function AllowedResult({ result }: { result: Extract<CheckVideoResponse, { status: "allowed" }> }) {
  const [confirmed, setConfirmed] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  return <section aria-live="polite" className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card"><div className="grid sm:grid-cols-[200px_1fr]"><div className="relative min-h-48 overflow-hidden bg-slate-100"><img src={result.thumbnail} alt="Превью разрешённого демонстрационного видео" className="absolute inset-0 h-full w-full object-cover" /><span className="absolute bottom-3 right-3 rounded-lg bg-[#101827]/80 px-2 py-1 text-xs font-bold text-white">{result.duration}</span></div><div className="p-5 sm:p-6"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">Разрешено</span>{result.isDemo && <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-bold text-brand">Демо-ответ</span>}</div><h2 className="mt-3 text-xl font-extrabold tracking-[-.035em] text-ink">{result.title}</h2><p className="mt-1 text-sm text-slate-500">Автор: {result.author} · {result.platform}</p><div className="mt-5 rounded-xl border border-blue-100 bg-blue-50/70 p-3.5"><label className="flex cursor-pointer items-start gap-3 text-sm leading-5 text-blue-950"><input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" className="mt-0.5 h-4 w-4 rounded border-blue-300 accent-brand" /><span>Я подтверждаю, что имею право скачать и использовать это видео.</span></label></div><div className="mt-4 space-y-2">{result.formats.map((format) => <div key={format.quality} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 px-3.5 py-3"><span className="text-sm font-bold text-ink">{format.quality}</span><span className="text-xs text-slate-500">{format.format} · {format.size}</span><a href={confirmed ? format.downloadUrl : undefined} onClick={(event) => { if (!confirmed) { event.preventDefault(); return; } setDownloaded(true); }} aria-disabled={!confirmed} className="ml-auto inline-flex items-center gap-1.5 text-sm font-bold text-brand transition hover:text-[#254FDD] aria-disabled:cursor-not-allowed aria-disabled:text-slate-300"><Icon name="download" className="h-4 w-4" />Скачать</a></div>)}</div>{downloaded && <p className="mt-3 text-xs leading-5 text-slate-500">Скачан демонстрационный файл. В рабочем адаптере здесь будет только временная ссылка, выданная официальным источником.</p>}</div></div></section>;
}
