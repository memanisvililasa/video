import { Icon } from "@/components/icons";

const platforms = [
  ["Публичные страницы", "Видео, доступные без входа и приватных разрешений."],
  ["Прямые HTTP(S)-источники", "Ссылки, которые можно проверить без cookies и paywall."],
  ["Официальные downloads", "Файлы, которые платформа или автор разрешают сохранить."],
  ["Лицензированный контент", "Материалы с явным разрешением автора или подходящей лицензией."]
];

export function PlatformsSection() {
  return (
    <section className="mx-auto max-w-7xl px-5 py-16 sm:px-8 sm:py-20">
      <div className="max-w-2xl">
        <p className="text-xs font-bold uppercase tracking-[.14em] text-brand">Платформы</p>
        <h2 className="mt-3 text-3xl font-extrabold tracking-[-.05em] text-ink sm:text-4xl">Что будет поддерживаться</h2>
        <p className="mt-4 text-sm leading-6 text-slate-600">Поддержка конкретных источников появится после подключения extractor API. Этап 2 фиксирует только frontend-представление.</p>
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
