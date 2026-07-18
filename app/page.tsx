import type { Metadata } from "next";
import Link from "next/link";
import { BenefitsSection } from "@/components/benefits-section";
import { FaqSection } from "@/components/faq-section";
import { Icon } from "@/components/icons";
import { LegalCallout } from "@/components/legal-callout";
import { PlatformsSection } from "@/components/platforms-section";
import { VideoDownloader } from "@/components/video-downloader";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  description: "VideoSave локально обрабатывает публичные прямые видеофайлы, одиночные страницы Vimeo, YouTube и Shorts без обхода ограничений."
};

export default function HomePage() {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "VideoSave",
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Web",
    description: "Personal-use инструмент для разрешённых публичных видеофайлов и одиночных страниц Vimeo, YouTube и Shorts.",
    offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" }
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
      <section className="relative overflow-hidden bg-[#F7F9FF] pb-12 pt-16 sm:pb-16 sm:pt-24">
        <div className="absolute left-1/2 top-[-16rem] h-[38rem] w-[60rem] -translate-x-1/2 rounded-full bg-[#E1E9FF] blur-3xl" />
        <div className="absolute left-[-14rem] top-56 h-80 w-80 rounded-full bg-[#E8FFF6] blur-3xl" />
        <div className="relative mx-auto max-w-4xl px-5 text-center sm:px-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-white/90 px-3 py-1.5 text-xs font-bold text-brand shadow-sm">
            <Icon name="shield" className="h-3.5 w-3.5" />
            Personal-use local runtime
          </div>
          <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-extrabold leading-[1.04] tracking-[-.065em] text-ink sm:text-6xl">
            VideoSave для публичных видео с <span className="text-brand">проверкой прав</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
            Вставьте ссылку, проверьте формат, выберите качество и подтвердите, что у вас есть право скачать контент.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/#check" className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-brand px-5 text-sm font-bold text-white transition hover:bg-[#254FDD]">
              Проверить ссылку <Icon name="arrow" className="h-4 w-4" />
            </Link>
            <Link href="/terms" className="inline-flex h-12 items-center justify-center rounded-xl border border-slate-200 bg-white px-5 text-sm font-bold text-ink transition hover:border-blue-100 hover:bg-blue-50">
              Правила использования
            </Link>
          </div>
          <p className="mt-5 text-xs leading-5 text-slate-500">
            Скачивайте только свои видео или контент, на который у вас есть разрешение
          </p>
        </div>
      </section>

      <VideoDownloader />
      <PlatformsSection />
      <BenefitsSection />
      <FaqSection />

      <section className="mx-auto max-w-5xl px-5 pb-16 sm:px-8 sm:pb-20">
        <LegalCallout>
          <strong>Legal notice.</strong> VideoSave не обходит DRM, авторизацию, cookies, CAPTCHA, пароль, paywall, географические или возрастные ограничения и настройки приватности. Поддерживаются публичные прямые HTTP(S)-ссылки на `.mp4`, `.webm`, `.mov`, публичные одиночные страницы Vimeo с progressive HTTPS-форматом, а также публичные одиночные YouTube-видео и Shorts; другие страницы платформ отклоняются.
        </LegalCallout>
      </section>
    </>
  );
}
