# VideoSave

VideoSave пересобирается как Next.js + TypeScript + Tailwind CSS сервис для работы только с публично доступными видео, которые пользователь имеет право скачивать.

## Текущий этап

Выполнен только базовый этап пересборки:

- удалены demo/placeholder endpoints и demo UI;
- подготовлена новая структура папок для backend, extractors, FFmpeg, storage и jobs;
- добавлены skeleton/stub-модули без реальной бизнес-логики.

Реальные функции скачивания, extractor-ы, FFmpeg-обработка, временные файлы и полноценный download flow будут добавлены на следующих этапах.

## Ограничения

Проект не должен обходить DRM, авторизацию, приватные аккаунты, cookies, CAPTCHA, paywall, платный доступ или технические ограничения платформ.

## Локальная разработка

```bash
npm install
npm run dev
```

Проверки:

```bash
npm run lint
npm run typecheck
npm run build
```

## ENV

Список базовых переменных находится в `.env.example`.
