import type { Metadata } from "next";
import { Icon } from "@/components/icons";
import { PageHero } from "@/components/page-hero";

export const metadata: Metadata = {
  title: "Contact",
  description: "Связаться с командой VideoSave по вопросам сервиса, прав и конфиденциальности.",
  alternates: { canonical: "/contact" }
};

const contacts = [
  ["Поддержка", "hello@videosave.example", "Вопросы о frontend-интерфейсе и работе сайта."],
  ["Права", "copyright@videosave.example", "Запросы правообладателей и жалобы на нарушение прав."],
  ["Privacy", "privacy@videosave.example", "Вопросы о конфиденциальности и обработке данных."]
];

export default function ContactPage() {
  return (
    <>
      <PageHero eyebrow="Contact" title="Связаться с VideoSave" description="Выберите подходящий канал. Мы не принимаем запросы на обход ограничений платформ." />
      <section className="mx-auto max-w-4xl px-5 py-16 sm:px-8 sm:py-20">
        <div className="grid gap-4 md:grid-cols-3">
          {contacts.map(([title, email, text]) => (
            <article key={email} className="rounded-2xl border border-slate-100 p-6 shadow-card">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-brand">
                <Icon name="file" className="h-5 w-5" />
              </span>
              <h2 className="mt-5 font-bold text-ink">{title}</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">{text}</p>
              <a href={`mailto:${email}`} className="mt-5 block break-all text-sm font-bold text-brand hover:underline">{email}</a>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
