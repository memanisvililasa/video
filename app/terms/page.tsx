import type { Metadata } from "next";
import { LegalCallout } from "@/components/legal-callout";
import { PageHero } from "@/components/page-hero";

export const metadata: Metadata = {
  title: "Условия использования",
  description: "Условия использования VideoSave: разрешённый контент, запрет обхода ограничений и ответственность пользователя.",
  alternates: { canonical: "/terms" }
};

export default function TermsPage() {
  return (
    <>
      <PageHero eyebrow="Условия" title="Используйте VideoSave только законно" description="Сервис предназначен для публичного контента, который пользователь имеет право скачать." />
      <article className="prose-copy mx-auto max-w-3xl px-5 py-16 sm:px-8 sm:py-20">
        <p>Эти условия описывают допустимое использование VideoSave. Personal-use local runtime загружает и обрабатывает публичные прямые видеофайлы и поддерживаемые публичные одиночные страницы Vimeo, YouTube и Shorts только после явного подтверждения прав пользователем.</p>
        <h2>Разрешённое использование</h2>
        <ul>
          <li>Скачивание собственных видео.</li>
          <li>Скачивание материалов, на которые автор дал явное разрешение.</li>
          <li>Работа с публичным контентом, который доступен без входа, cookies, CAPTCHA, paywall или DRM.</li>
        </ul>
        <h2>Запрещённое использование</h2>
        <ul>
          <li>Обход авторизации, приватности, DRM, CAPTCHA, paywall, геоблокировки или других технических ограничений.</li>
          <li>Скачивание чужого контента без прав, лицензии или согласия автора.</li>
          <li>Массовое сохранение, перепубликация или коммерческое использование без необходимых прав.</li>
        </ul>
        <LegalCallout><strong>Ответственность пользователя.</strong> Подтверждение прав в интерфейсе означает, что вы самостоятельно проверили законность скачивания конкретного видео.</LegalCallout>
      </article>
    </>
  );
}
