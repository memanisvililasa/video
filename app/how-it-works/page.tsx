import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { LegalCallout } from "@/components/legal-callout";
import { PageHero } from "@/components/page-hero";

export const metadata: Metadata = { title: "Как это работает", description: "Как VideoSave проверяет ссылку и показывает только доступные легальные способы сохранения видео.", alternates: { canonical: "/how-it-works" } };

const steps = [
  ["01", "Вставьте поддерживаемую ссылку", "Укажите публичный HTTP(S)-адрес файла .mp4, .webm или .mov, одиночную страницу Vimeo, YouTube watch-видео или Short."],
  ["02", "Проверяем источник", "Сервис проверяет URL, redirects, адрес назначения, Content-Type и размер без cookies или доступа к аккаунтам. Vimeo использует progressive HTTPS; YouTube может безопасно объединить отдельные видео- и аудиопотоки."],
  ["03", "Выберите результат", "После metadata выберите оригинал, совместимый MP4 или M4A и подтвердите право скачать материал."],
  ["04", "Получите проверенный файл", "Локальная задача загружает, проверяет и при необходимости обрабатывает медиа. Скачивание начинается только после явного нажатия."]
];

export default function HowItWorksPage() {
  return <><PageHero eyebrow="Процесс" title="Как работает VideoSave" description="Короткий и прозрачный путь: проверяем источник, соблюдаем правила и показываем только допустимые варианты." /><section className="mx-auto max-w-5xl px-5 py-16 sm:px-8 sm:py-20"><div className="grid gap-4 md:grid-cols-2">{steps.map(([number, title, text]) => <article key={number} className="rounded-2xl border border-slate-100 p-6 shadow-card"><span className="text-sm font-extrabold text-brand">{number}</span><h2 className="mt-8 text-xl font-extrabold tracking-[-.03em] text-ink">{title}</h2><p className="mt-3 text-sm leading-6 text-slate-600">{text}</p></article>)}</div><LegalCallout><strong>Никаких обходов.</strong> VideoSave не обходит DRM, paywall, CAPTCHA, вход в аккаунт, географические ограничения, водяные знаки, настройки приватности или другие технические меры. Если платформа не даёт легального пути, мы рекомендуем её собственный инструмент или обращение к автору.</LegalCallout><div className="rounded-2xl bg-[#F7F9FF] p-7 text-center sm:p-10"><Icon name="link" className="mx-auto h-6 w-6 text-brand" /><h2 className="mt-4 text-2xl font-extrabold tracking-[-.04em] text-ink">Готовы проверить ссылку?</h2><p className="mt-2 text-sm text-slate-600">Проверка не требует регистрации и не даёт нам доступ к вашим аккаунтам.</p><Link href="/#check" className="mt-6 inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white hover:bg-[#254FDD]">Проверить ссылку <Icon name="arrow" className="h-4 w-4" /></Link></div></section></>;
}
