# VideoSave

VideoSave пересобирается как Next.js + TypeScript + Tailwind CSS сервис для работы только с публично доступными видео, которые пользователь имеет право скачивать.

## Текущий этап

Выполнен frontend-этап пересборки:

- удалены demo/placeholder endpoints и demo UI;
- подготовлена новая структура папок для backend, extractors, FFmpeg, storage и jobs;
- добавлены skeleton/stub-модули без реальной бизнес-логики.
- добавлена frontend-форма проверки ссылки, состояния анализа, карточка результата и выбор формата.

Реальные API endpoints, функции скачивания, extractor-ы, FFmpeg-обработка, временные файлы и полноценный download flow будут добавлены на следующих этапах.

## Production-архитектура

Архитектура controlled/private production deployment для Phase A и границы будущей Phase B зафиксированы в [ADR 0001](docs/adr/0001-production-deployment-architecture.md).

Текущий репозиторий ещё не готов к публичному multi-user production. Phase A architecture утверждена, но реализация Stage 5.9 продолжается.

PostgreSQL `JobRepository`, queue/lease adapter, Phase A shared-volume media storage и отдельный compiled Node worker доступны через явные server-only composition roots. Worker содержит elected lifecycle coordinator для startup/periodic recovery, persistent retry scheduling, reconciliation и expiration. Production API cutover ещё не выполнен: общий API runtime по умолчанию продолжает использовать in-memory repository, локальную compatibility queue и process-local file registry. Worker не запускается вместе с Next.js; deployment wiring относится к следующему подэтапу.

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

### PostgreSQL persistence и queue/lease adapter

Инструкции по migrations, integration tests, TLS и минимальным DB privileges находятся в [PostgreSQL development note](docs/postgresql.md).

Кратко:

```bash
npm run db:migrate
npm run db:migrate:status
TEST_DATABASE_URL='postgresql://<test-role>@<host>/<disposable-test-db>' npm run test:postgres
```

`JOB_REPOSITORY_BACKEND` по умолчанию равен `memory`. Значение `postgres` и queue/lease параметры валидируются только explicit PostgreSQL factories; они не переключают существующие API routes автоматически. Fallback и dual-write отсутствуют. Durable execution payload является private internal data и не входит в public DTO.

`MEDIA_STORAGE_BACKEND` по умолчанию равен `local`. Explicit Phase A runtime требует `durable-volume`, абсолютный заранее подготовленный `MEDIA_STORAGE_ROOT` и PostgreSQL registry из migration `003`. Web и отдельный worker должны монтировать один POSIX volume в один логический root. Internal storage keys, source и partial artifacts не являются public API; `/api/file/[id]` в текущем default wiring по-прежнему использует local implementation. Object storage и signed URLs относятся к Phase B.

### Standalone media worker

Worker собирается отдельно от Next.js и в production запускается обычным Node.js без runtime TypeScript transpiler:

```bash
npm run build:worker
APP_PROCESS_ROLE=worker JOB_REPOSITORY_BACKEND=postgres MEDIA_STORAGE_BACKEND=durable-volume npm run check:worker
APP_PROCESS_ROLE=worker JOB_REPOSITORY_BACKEND=postgres MEDIA_STORAGE_BACKEND=durable-volume npm run start:worker
```

Для readiness/start дополнительно обязательны `DATABASE_URL`, заранее созданный `MEDIA_STORAGE_ROOT`, применённые migrations `001`–`004`, доступные ffmpeg/ffprobe и strict worker/lease/lifecycle limits из `.env.example`. Connection string и storage path намеренно не показаны. `check:worker` не claim-ит jobs и не запускает maintenance.

Тесты worker boundary:

```bash
npm run test:worker
TEST_DATABASE_URL='postgresql://<test-role>@<host>/<disposable-test-db>' npm run test:postgres
TEST_DATABASE_URL='postgresql://<test-role>@<host>/<disposable-test-db>' npm run test:worker:smoke
```

Smoke использует локальный временный fixture, настоящие ffprobe/FFmpeg и не обращается во внешний Internet. SIGTERM/SIGINT прекращают новые claims, сохраняют renewal на bounded grace period, затем abort-ят download/probe/FFmpeg и закрывают pool. Один worker process выбирается PostgreSQL advisory lock-ом для bounded recovery/reconciliation; остальные продолжают processing без destructive maintenance. Production API cutover и deployment wiring ещё не выполнены.
