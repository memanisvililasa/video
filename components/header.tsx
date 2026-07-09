"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/icons";
import { Logo } from "@/components/logo";

const links = [
  { href: "/how-it-works", label: "Как это работает" },
  { href: "/faq", label: "FAQ" },
  { href: "/terms", label: "Условия" },
  { href: "/contact", label: "Контакты" }
];

export function Header() {
  const [open, setOpen] = useState(false);

  return (
    <header className="relative z-30 border-b border-slate-100 bg-white/80 backdrop-blur-xl">
      <div className="mx-auto flex h-[76px] max-w-7xl items-center justify-between px-5 sm:px-8">
        <Logo />
        <nav className="hidden items-center gap-7 md:flex" aria-label="Основная навигация">
          {links.map((link) => <Link key={link.href} href={link.href} className="text-sm font-medium text-slate-600 transition hover:text-brand">{link.label}</Link>)}
        </nav>
        <Link href="/#check" className="hidden rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand md:block">Проверить ссылку</Link>
        <button type="button" onClick={() => setOpen(!open)} className="grid h-10 w-10 place-items-center rounded-xl text-ink hover:bg-slate-100 md:hidden" aria-label={open ? "Закрыть меню" : "Открыть меню"} aria-expanded={open}>
          <Icon name={open ? "x" : "menu"} className="h-5 w-5" />
        </button>
      </div>
      {open && <div className="absolute inset-x-0 top-[76px] border-b border-slate-100 bg-white p-5 shadow-card md:hidden"><nav className="mx-auto grid max-w-7xl gap-1" aria-label="Мобильная навигация">{links.map((link) => <Link onClick={() => setOpen(false)} key={link.href} href={link.href} className="rounded-xl px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">{link.label}</Link>)}<Link onClick={() => setOpen(false)} href="/#check" className="mt-2 rounded-xl bg-ink px-4 py-3 text-center text-sm font-semibold text-white">Проверить ссылку</Link></nav></div>}
    </header>
  );
}
