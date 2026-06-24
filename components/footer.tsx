import Link from "next/link";
import { Logo } from "@/components/logo";

const navigation = [
  { href: "/how-it-works", label: "Как это работает" },
  { href: "/rules", label: "Правила использования" },
  { href: "/dmca", label: "DMCA / Жалобы" },
  { href: "/privacy", label: "Конфиденциальность" },
  { href: "/contacts", label: "Контакты" }
];

export function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto grid max-w-7xl gap-10 px-5 py-12 sm:px-8 md:grid-cols-[1.1fr_.9fr] md:py-16">
        <div><Logo /><p className="mt-4 max-w-md text-sm leading-6 text-slate-500">Сервис для проверки доступных легальных способов сохранить видео. Мы не обходим технические меры защиты и не храним ваши файлы.</p></div>
        <nav className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3" aria-label="Навигация в подвале">
          {navigation.map((item) => <Link key={item.href} href={item.href} className="text-sm font-medium text-slate-600 transition hover:text-brand">{item.label}</Link>)}
        </nav>
      </div>
      <div className="border-t border-slate-100"><div className="mx-auto flex max-w-7xl flex-col gap-2 px-5 py-5 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between sm:px-8"><span>© {new Date().getFullYear()} VideoSave</span><span>Только для контента, на который у вас есть права.</span></div></div>
    </footer>
  );
}
