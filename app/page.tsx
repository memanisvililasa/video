import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icons";

const benefits = [
  { icon: "check" as const, title: "Без регистрации", text: "Не просим создать аккаунт для проверки ссылки." },
  { icon: "lock" as const, title: "Временные файлы", text: "Будущая версия будет хранить подготовленные файлы только ограниченное время." },
  { icon: "shield" as const, title: "Только разрешённый контент", text: "Сервис проектируется без обхода DRM, авторизации и приватного доступа." },
  { icon: "bolt" as const, title: "Готовится новая архитектура", text: "Extractor layer, FFmpeg и storage будут добавлены следующими этапами." }
];

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  description: "VideoSave пересобирается как безопасный сервис для публичных видео, которые пользователь имеет право скачивать."
};

export default function HomePage() {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "VideoSave",
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Web",
    description: "Сервис для работы с публичными видео, на которые у пользователя есть права.",
    offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" }
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
      <section className="relative overflow-hidden bg-[#F7F9FF] pb-16 pt-16 sm:pb-24 sm:pt-24">
        <div className="absolute left-1/2 top-[-16rem] h-[38rem] w-[60rem] -translate-x-1/2 rounded-full bg-[#E1E9FF] blur-3xl" />
        <div className="absolute left-[-14rem] top-56 h-80 w-80 rounded-full bg-[#E8FFF6] blur-3xl" />
        <div className="relative mx-auto max-w-4xl px-5 text-center sm:px-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-white/90 px-3 py-1.5 text-xs font-bold text-brand shadow-sm">
            <Icon name="shield" className="h-3.5 w-3.5" />
            Базовая структура пересборки
          </div>
          <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-extrabold leading-[1.04] tracking-[-.065em] text-ink sm:text-6xl">
            VideoSave готовится к новой <span className="text-brand">безопасной архитектуре</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
            Demo downloader удалён. Реальная форма анализа ссылок и скачивания будет добавлена следующим этапом.
          </p>
          <div id="check" className="mx-auto mt-9 max-w-3xl rounded-2xl border border-blue-100 bg-white p-6 text-left shadow-soft">
            <div className="flex gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-50 text-brand">
                <Icon name="info" className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-lg font-extrabold tracking-[-.03em] text-ink">Этап 1 завершает очистку demo-частей</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Frontend downloader, реальные extractor-ы, FFmpeg и временное хранение файлов пока намеренно не реализованы.
                </p>
              </div>
            </div>
          </div>
          <p className="mt-5 text-xs leading-5 text-slate-500">
            Скачивайте только свои видео или контент, на который у вас есть разрешение.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-5 py-16 sm:px-8 sm:py-20">
        <div className="text-center">
          <p className="text-xs font-bold uppercase tracking-[.14em] text-brand">Что осталось в базе</p>
          <h2 className="mt-3 text-3xl font-extrabold tracking-[-.05em] text-ink sm:text-4xl">Фундамент для следующих этапов</h2>
        </div>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {benefits.map((benefit) => (
            <article key={benefit.title} className="rounded-2xl border border-slate-100 bg-white p-5 shadow-card">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-brand">
                <Icon name={benefit.icon} className="h-5 w-5" />
              </span>
              <h3 className="mt-5 text-base font-bold text-ink">{benefit.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-500">{benefit.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-5 pb-16 sm:px-8 sm:pb-20">
        <div className="rounded-3xl bg-ink px-6 py-10 text-center sm:px-12 sm:py-14">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-white/10 text-white">
            <Icon name="shield" className="h-6 w-6" />
          </span>
          <h2 className="mt-5 text-3xl font-extrabold tracking-[-.05em] text-white">Следующий этап — frontend downloader</h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            После подтверждения будет добавлена форма, состояния обработки, карточка результата и работа с новыми API endpoints.
          </p>
          <Link href="/how-it-works" className="mt-6 inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-bold text-ink transition hover:bg-blue-50">
            Подробнее о процессе <Icon name="arrow" className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </>
  );
}
