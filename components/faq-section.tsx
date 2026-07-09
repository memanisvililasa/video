const faqs = [
  ["Это уже скачивает видео?", "Нет. На Этапе 2 реализован только frontend UI и безопасный mock состояний. Серверная подготовка файлов появится на Этапе 3."],
  ["Можно ли скачивать приватные видео?", "Нет. VideoSave не должен обходить приватность, авторизацию, cookies, CAPTCHA, paywall, DRM или другие технические ограничения."],
  ["Зачем нужно подтверждение прав?", "Пользователь обязан убедиться, что скачивает собственное видео или контент с разрешением автора."],
  ["Какие платформы будут поддержаны?", "Поддержка будет определяться extractor layer на backend-этапе. Сейчас список на странице описывает допустимые категории источников."]
];

export function FaqSection() {
  return (
    <section className="mx-auto max-w-5xl px-5 py-16 sm:px-8 sm:py-20">
      <div className="text-center">
        <p className="text-xs font-bold uppercase tracking-[.14em] text-brand">FAQ</p>
        <h2 className="mt-3 text-3xl font-extrabold tracking-[-.05em] text-ink sm:text-4xl">Частые вопросы</h2>
      </div>
      <div className="mt-10 grid gap-4">
        {faqs.map(([question, answer]) => (
          <article key={question} className="rounded-2xl border border-slate-100 bg-white p-5 shadow-card">
            <h3 className="text-base font-bold text-ink">{question}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">{answer}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
