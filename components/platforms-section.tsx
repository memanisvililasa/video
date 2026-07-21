import { Icon } from "@/components/icons";

const platforms = [
  ["MP4", "Прямые публичные HTTPS-ссылки на файлы `.mp4`."],
  ["WebM", "Прямые публичные HTTPS-ссылки на файлы `.webm`."],
  ["QuickTime MOV", "Прямые публичные HTTPS-ссылки на файлы `.mov`."],
  ["Vimeo", "Разрешённые публичные одиночные страницы Vimeo в подтверждённом scope с progressive HTTPS-видео."],
  ["YouTube", "Публичные одиночные watch-видео и Shorts; раздельные публичные потоки безопасно объединяются на сервере."],
  ["Reddit", "Публичные одиночные посты только с Reddit-hosted видео; split-потоки объединяются на сервере, silent video явно помечается."]
];

export function PlatformsSection() {
  return (
    <section className="mx-auto max-w-7xl px-5 py-16 sm:px-8 sm:py-20">
      <div className="max-w-2xl">
        <p className="text-xs font-bold uppercase tracking-[.14em] text-brand">Платформы</p>
        <h2 className="mt-3 text-3xl font-extrabold tracking-[-.05em] text-ink sm:text-4xl">Поддерживаемые источники</h2>
        <p className="mt-4 text-sm leading-6 text-slate-600">VideoSave принимает прямые публичные HTTPS-видеофайлы и разрешённые публичные одиночные страницы Vimeo, YouTube, Shorts и Reddit-hosted video posts. Источник должен быть доступен без входа, cookies, пароля, paywall, DRM и обхода ограничений.</p>
        <p className="mt-3 text-sm leading-6 text-slate-600"><strong>Не поддерживаются:</strong> TikTok, Instagram, Facebook и X/Twitter; redirect-ссылки t.co, внешние Reddit embeds, private/login-required и live content, playlists и unsupported multi-item media также отклоняются.</p>
      </div>
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {platforms.map(([title, text]) => (
          <article key={title} className="rounded-2xl border border-slate-100 bg-white p-5 shadow-card">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-brand">
              <Icon name="link" className="h-5 w-5" />
            </span>
            <h3 className="mt-5 text-base font-bold text-ink">{title}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-500">{text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
