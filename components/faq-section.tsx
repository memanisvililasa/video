const faqs = [
  ["Как происходит подготовка файла?", "После выбора формата и подтверждения прав задача ставится в очередь. Готовый файл скачивается только после явного нажатия кнопки."],
  ["Можно ли скачивать приватные видео?", "Нет. VideoSave не должен обходить приватность, авторизацию, cookies, CAPTCHA, paywall, DRM или другие технические ограничения."],
  ["Зачем нужно подтверждение прав?", "Пользователь обязан убедиться, что скачивает собственное видео или контент с разрешением автора."],
  ["Какие источники поддерживаются?", "Прямые публичные ссылки на файлы .mp4, .webm и .mov, а также публичные одиночные страницы Vimeo с progressive HTTPS-форматом. Другие страницы платформ пока отклоняются; сервис не обходит авторизацию, пароль, приватность, DRM или технические ограничения."]
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
