import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { LegalCallout } from "@/components/legal-callout";
import { PageHero } from "@/components/page-hero";

export const metadata: Metadata = { title: "Как это работает", description: "Как VideoSave проверяет ссылку и показывает только доступные легальные способы сохранения видео.", alternates: { canonical: "/how-it-works" } };

const steps = [
  ["01", "Вставьте ссылку", "Укажите публичную ссылку на видео. Мы принимаем только адреса из ограниченного списка известных платформ."],
  ["02", "Проверяем источник", "Сервис определяет платформу и смотрит, есть ли безопасный официальный способ подтвердить доступность сохранения."],
  ["03", "Показываем результат", "Если разрешения нет, объясняем причину и направляем к штатной функции платформы. Мы не пытаемся извлечь файл обходным путём."],
  ["04", "Подтверждаете права", "Перед получением доступного файла вы подтверждаете, что вправе скачать и использовать этот материал."]
];

export default function HowItWorksPage() {
  return <><PageHero eyebrow="Процесс" title="Как работает VideoSave" description="Короткий и прозрачный путь: проверяем источник, соблюдаем правила и показываем только допустимые варианты." /><section className="mx-auto max-w-5xl px-5 py-16 sm:px-8 sm:py-20"><div className="grid gap-4 md:grid-cols-2">{steps.map(([number, title, text]) => <article key={number} className="rounded-2xl border border-slate-100 p-6 shadow-card"><span className="text-sm font-extrabold text-brand">{number}</span><h2 className="mt-8 text-xl font-extrabold tracking-[-.03em] text-ink">{title}</h2><p className="mt-3 text-sm leading-6 text-slate-600">{text}</p></article>)}</div><LegalCallout><strong>Никаких обходов.</strong> VideoSave не обходит DRM, paywall, CAPTCHA, вход в аккаунт, географические ограничения, водяные знаки, настройки приватности или другие технические меры. Если платформа не даёт легального пути, мы рекомендуем её собственный инструмент или обращение к автору.</LegalCallout><div className="rounded-2xl bg-[#F7F9FF] p-7 text-center sm:p-10"><Icon name="link" className="mx-auto h-6 w-6 text-brand" /><h2 className="mt-4 text-2xl font-extrabold tracking-[-.04em] text-ink">Готовы проверить ссылку?</h2><p className="mt-2 text-sm text-slate-600">Проверка не требует регистрации и не даёт нам доступ к вашим аккаунтам.</p><Link href="/#check" className="mt-6 inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white hover:bg-[#254FDD]">Проверить ссылку <Icon name="arrow" className="h-4 w-4" /></Link></div></section></>;
}
