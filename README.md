# VideoSave

VideoSave пересобирается как Next.js + TypeScript + Tailwind CSS сервис для работы только с публично доступными видео, которые пользователь имеет право скачивать.

## Текущий этап

Выполнен frontend-этап пересборки:

- удалены demo/placeholder endpoints и demo UI;
- подготовлена новая структура папок для backend, extractors, FFmpeg, storage и jobs;
- добавлены skeleton/stub-модули без реальной бизнес-логики.
- добавлена frontend-форма проверки ссылки, состояния анализа, карточка результата и выбор формата.

Реальные API endpoints, функции скачивания, extractor-ы, FFmpeg-обработка, временные файлы и полноценный download flow будут добавлены на следующих этапах.

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

### Rate limiting и reverse proxy

`TRUST_PROXY_MODE=none` — единственная поддерживаемая политика. Приложение не доверяет `Forwarded`, `X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`, `X-Client-IP` и другим клиентским IP-заголовкам, потому что текущий Next.js Route Handler не предоставляет адрес непосредственного сетевого peer.

Все неопознанные HTTP-клиенты используют один стабильный identifier внутри каждого rate-limit bucket. Это исключает обход лимитов подделкой заголовков, но означает, что один активный клиент может исчерпать общую квоту bucket для остальных. Перед публичным multi-user deployment нужен отдельный проверенный ingress/provider adapter с недоступным напрямую origin и надёжным peer identity.

`RATE_LIMIT_MAX_REQUESTS` должен быть целым числом от 1 до 10000. Значение `0` не отключает rate limiting и считается ошибкой конфигурации.
