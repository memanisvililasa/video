import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { LinkChecker } from "@/components/link-checker";

const benefits = [
  { icon: "check" as const, title: "Без регистрации", text: "Не просим создать аккаунт для проверки ссылки." },
  { icon: "lock" as const, title: "Без хранения файлов", text: "Не сохраняем медиа на своих серверах." },
  { icon: "shield" as const, title: "Только разрешённый контент", text: "Работаем с правами, правилами платформ и официальными методами." },
  { icon: "bolt" as const, title: "Быстро и безопасно", text: "Проверка без доступа к вашим аккаунтам и приватным данным." }
];

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  description: "Проверяйте доступные легальные способы сохранить видео, на которое у вас есть права. Без обхода ограничений платформ."
};

export default function HomePage() {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "VideoSave",
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Web",
    description: "Сервис для проверки доступных легальных способов сохранить видео, на которое у пользователя есть права.",
    offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" }
  };

  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
    <section className="relative overflow-hidden bg-[#F7F9FF] pb-16 pt-16 sm:pb-24 sm:pt-24"><div className="absolute left-1/2 top-[-16rem] h-[38rem] w-[60rem] -translate-x-1/2 rounded-full bg-[#E1E9FF] blur-3xl" /><div className="absolute left-[-14rem] top-56 h-80 w-80 rounded-full bg-[#E8FFF6] blur-3xl" /><div className="relative mx-auto max-w-4xl px-5 text-center sm:px-8"><div className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-white/90 px-3 py-1.5 text-xs font-bold text-brand shadow-sm"><Icon name="shield" className="h-3.5 w-3.5" />Соблюдаем правила платформ</div><h1 className="mx-auto mt-6 max-w-3xl text-4xl font-extrabold leading-[1.04] tracking-[-.065em] text-ink sm:text-6xl">Скачивайте разрешённые видео <span className="text-brand">безопасно</span></h1><p className="mx-auto mt-6 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">Вставьте ссылку на видео, а мы проверим доступные легальные варианты сохранения.</p><div className="mx-auto mt-9 max-w-3xl text-left"><LinkChecker /></div><p className="mt-5 text-xs leading-5 text-slate-500">Продолжая, вы подтверждаете, что не используете сервис для обхода DRM, приватности, ограничений доступа или правил платформ.</p></div></section>
    <section className="mx-auto max-w-7xl px-5 py-16 sm:px-8 sm:py-20"><div className="text-center"><p className="text-xs font-bold uppercase tracking-[.14em] text-brand">Прозрачный подход</p><h2 className="mt-3 text-3xl font-extrabold tracking-[-.05em] text-ink sm:text-4xl">Сохранение — только когда оно законно</h2></div><div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{benefits.map((benefit) => <article key={benefit.title} className="rounded-2xl border border-slate-100 bg-white p-5 shadow-card"><span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-brand"><Icon name={benefit.icon} className="h-5 w-5" /></span><h3 className="mt-5 text-base font-bold text-ink">{benefit.title}</h3><p className="mt-2 text-sm leading-6 text-slate-500">{benefit.text}</p></article>)}</div></section>
    <section className="border-y border-slate-100 bg-[#FBFCFF]"><div className="mx-auto grid max-w-7xl gap-10 px-5 py-16 sm:px-8 lg:grid-cols-[.9fr_1.1fr] lg:items-center"><div><p className="text-xs font-bold uppercase tracking-[.14em] text-brand">Как это устроено</p><h2 className="mt-3 text-3xl font-extrabold tracking-[-.05em] text-ink sm:text-4xl">Проверяем ссылку, а не ломаем ограничения</h2><p className="mt-5 max-w-xl text-[15px] leading-7 text-slate-600">VideoSave не получает доступ к аккаунтам, закрытым публикациям или платёжному контенту. Мы подсказываем только официальные варианты или используем провайдерские API, когда они подтверждают права и выдачу файла.</p><Link href="/how-it-works" className="mt-6 inline-flex items-center gap-2 text-sm font-bold text-brand hover:text-[#254FDD]">Подробнее о процессе <Icon name="arrow" className="h-4 w-4" /></Link></div><ol className="grid gap-3">{["Вставьте публичную ссылку", "Получите результат проверки", "Выберите официальный вариант сохранения", "Подтвердите право на использование"].map((item, index) => <li key={item} className="flex items-center gap-4 rounded-2xl border border-slate-100 bg-white px-5 py-4 shadow-sm"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-mint text-sm font-extrabold text-emerald-800">0{index + 1}</span><span className="text-sm font-semibold text-ink">{item}</span></li>)}</ol></div></section>
    <section className="mx-auto max-w-7xl px-5 py-16 sm:px-8"><div className="rounded-3xl bg-ink px-6 py-10 text-center sm:px-12 sm:py-14"><span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-white/10 text-white"><Icon name="shield" className="h-6 w-6" /></span><h2 className="mt-5 text-3xl font-extrabold tracking-[-.05em] text-white">Ваши права — прежде всего</h2><p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-slate-300">Перед скачиванием мы просим подтвердить право на использование видео. Это относится к собственному контенту, материалам с лицензией Creative Commons и случаям с явным разрешением автора или платформы.</p><Link href="/rules" className="mt-6 inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-bold text-ink transition hover:bg-blue-50">Ознакомиться с правилами <Icon name="arrow" className="h-4 w-4" /></Link></div></section>
  </>;
}
