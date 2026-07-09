import type { Metadata } from "next";
import Link from "next/link";
import { FaqSection } from "@/components/faq-section";
import { Icon } from "@/components/icons";
import { PageHero } from "@/components/page-hero";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Ответы на частые вопросы о VideoSave, frontend downloader UI и допустимом использовании сервиса.",
  alternates: { canonical: "/faq" }
};

export default function FaqPage() {
  return (
    <>
      <PageHero eyebrow="FAQ" title="Частые вопросы" description="Коротко о текущем frontend-этапе, правах пользователя и ограничениях сервиса." />
      <FaqSection />
      <section className="mx-auto max-w-5xl px-5 pb-16 text-center sm:px-8 sm:pb-20">
        <Link href="/#check" className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white hover:bg-[#254FDD]">
          Проверить ссылку <Icon name="arrow" className="h-4 w-4" />
        </Link>
      </section>
    </>
  );
}
