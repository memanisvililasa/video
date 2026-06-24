import type { Metadata } from "next";
import { Icon } from "@/components/icons";
import { PageHero } from "@/components/page-hero";

export const metadata: Metadata = { title: "Контакты", description: "Контакты команды VideoSave: вопросы о сервисе, правах и конфиденциальности.", alternates: { canonical: "/contacts" } };

const contacts = [
  ["Общие вопросы", "hello@videosave.example", "Вопросы о работе и доступных источниках."],
  ["Авторские права", "copyright@videosave.example", "Жалобы правообладателей и запросы по DMCA."],
  ["Конфиденциальность", "privacy@videosave.example", "Вопросы об обработке данных и приватности."]
];

export default function ContactsPage() {
  return <><PageHero eyebrow="Связь" title="Контакты" description="Напишите нам по теме, которая соответствует вашему обращению. Мы не принимаем запросы на обход ограничений платформ." /><section className="mx-auto max-w-4xl px-5 py-16 sm:px-8 sm:py-20"><div className="grid gap-4 md:grid-cols-3">{contacts.map(([title, email, text]) => <article key={email} className="rounded-2xl border border-slate-100 p-6 shadow-card"><span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-brand"><Icon name="file" className="h-5 w-5" /></span><h2 className="mt-5 font-bold text-ink">{title}</h2><p className="mt-2 text-sm leading-6 text-slate-500">{text}</p><a href={`mailto:${email}`} className="mt-5 block break-all text-sm font-bold text-brand hover:underline">{email}</a></article>)}</div><p className="mt-8 text-center text-xs leading-5 text-slate-400">Адреса на этой странице демонстрационные. Перед развёртыванием замените их на рабочие каналы поддержки.</p></section></>;
}
