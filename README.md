# VideoSave

VideoSave пересобирается как Next.js + TypeScript + Tailwind CSS сервис для работы только с публично доступными видео, которые пользователь имеет право скачивать.

## Текущий этап

Stage 5 repository work, Stage 6.1 documentation checkpoint, Stage 7 personal-use local implementation и Stage 8.2 Vimeo checkpoint завершены. Stage 8.3 Public YouTube and Shorts реализован локально; ручной owner-authorized acceptance остаётся pending, production deployment не выполнялся. Deterministic real-media smoke не обращается во внешний Internet; ручные platform acceptance выполняются владельцем отдельно и только для разрешённого контента.

Локальный pipeline поддерживает публичные прямые ссылки на `.mp4`, `.webm` и `.mov`, публичные одиночные Vimeo URL `vimeo.com/<numeric-id>` и `player.vimeo.com/video/<numeric-id>`, а также публичные одиночные YouTube watch URL, `youtu.be/<video-id>` и `/shorts/<video-id>`. Vimeo использует только progressive HTTPS; YouTube предпочитает сопоставимый progressive source, а при необходимости загружает bounded video/audio streams и выполняет локальный FFmpeg stream-copy merge. Оба extractor-а повторно извлекают свежие internal sources перед загрузкой и не возвращают media/CDN URL клиенту. Reddit, TikTok, Instagram, Facebook и X/Twitter остаются отключёнными. Private, members-only, paid, login-required, live/premiere, playlist, password/cookie-dependent, DRM, geo-bypassed и age-bypassed content не поддерживается.

## Production-архитектура

Архитектура controlled/private production deployment для Phase A и границы будущей Phase B зафиксированы в [ADR 0001](docs/adr/0001-production-deployment-architecture.md). Stage 6 operator decisions, provisional host specification, tooling readiness и fail-closed GO/NO-GO boundary находятся в [ADR 0002](docs/adr/0002-phase-a-production-deployment-decision-record.md); будущий non-secret host inventory заполняется по [YAML template](deployment/inventory/phase-a-host.example.yml).

Stage 5 repository work завершён с итогом Conditional GO. Stage 6 production deployment ещё не начался: текущий статус — awaiting non-secret operator inventory, production traffic запрещён, а следующий исполнимый этап `6.2 Host bootstrap` блокируется до Stage 6.1 GO. Репозиторий не заявляет готовность к публичному multi-user production.

PostgreSQL `JobRepository`, queue/lease adapter, Phase A shared-volume media storage и отдельный compiled Node worker доступны через явные server-only composition roots. Worker содержит elected lifecycle coordinator для startup/periodic recovery, persistent retry scheduling, reconciliation и expiration. Role-aware web composition реализован: `APP_PROCESS_ROLE=web` использует только PostgreSQL job/queue/artifact state и read-only durable-volume delivery без memory/local fallback. Local/test по-прежнему выбирает process-local compatibility runtime. Worker не запускается вместе с Next.js. Standalone release, systemd/Nginx templates, privilege/volume/release tooling, observability contracts и host runbook реализованы и прошли Stage 5 repository acceptance. Реальный production deployment не выполнен.

## Ограничения

Проект не должен обходить DRM, авторизацию, приватные аккаунты, cookies, CAPTCHA, paywall, платный доступ или технические ограничения платформ.

## Локальная разработка

Требуется точный repository toolchain Node.js `24.18.0` + npm `11.6.0`, FFmpeg/ffprobe с encoders `libx264` и `aac`, а также system binary yt-dlp `2026.07.04`. yt-dlp используется server-only Vimeo/YouTube metadata extractors и запускается только через repository-controlled runner; global/user config, playlists, cookies, netrc, browser profiles, JS runtimes, plugins, remote components и пользовательские arguments отключены. Медиа загружается существующим bounded downloader, а не yt-dlp download mode. PostgreSQL, production environment file и отдельный worker для local runtime не нужны.

```bash
corepack npm install
corepack npm run local
```

`npm run local` выполняет fail-fast проверку toolchain, media binaries/codecs и writable `storage/tmp`, затем запускает Next.js только на `http://127.0.0.1:3000`. Проверку без запуска можно выполнить через `corepack npm run local:check`.

`npm run dev` также привязан к `127.0.0.1`, но пропускает media preflight и предназначен для разработки отдельных UI-компонентов.

Local jobs хранятся в памяти процесса: после restart незавершённая задача не восстанавливается. Refresh страницы в пределах живого процесса восстанавливает текущий job по безопасному session record без сохранения source URL. Expired media очищаются при старте local runtime и последующими bounded periodic sweeps; active jobs защищены от cleanup.

Если preflight сообщает об отсутствии FFmpeg/ffprobe или `libx264`/`aac`, установите полную сборку FFmpeg для macOS. yt-dlp должен быть exact approved version; runtime self-update, user config, cookies, browser profiles, plugins и remote components не используются. После исправления повторите `local:check`. Если toolchain не совпадает, запускайте npm через Corepack, чтобы использовалась версия из `packageManager`. Не публикуйте local listener в LAN и не меняйте hostname на `0.0.0.0` без отдельной private-access boundary.

Проверки:

```bash
corepack npm test
corepack npm run test:local:smoke
corepack npm run typecheck
corepack npm run build
```

## Immutable production release (5.9.8B1)

Production release собирается только утверждённым toolchain Node.js `24.18.0` + npm `11.6.0`:

```bash
corepack npm --version # must print 11.6.0
corepack npm run build:release
corepack npm run verify:release
corepack npm run package:release
corepack npm run test:release
```

Builder создаёт allowlist-only root `.release-dist/release`, затем manifest, SHA-256 checksums и после verification — deterministic tar.gz archive. В release входят Next.js standalone server/static assets, compiled worker, web/cutover readiness, migration runner и неизменённые migrations `001`–`004`. `.env*`, source/tests, media, cache, logs, source maps, Git metadata и runtime data исключены. Build не требует PostgreSQL, volume или production ENV и не запускает web, worker либо migration. Подробный contract и запуск из release root описаны в [production release note](docs/production-release.md).

## Phase A deployment boundary (5.9.8B2)

Systemd/Nginx/PostgreSQL templates, durable-volume authority tooling, immutable install/promotion, rollback compatibility, production smoke и validation-only CI описаны в [deployment runbook](deployment/README.md). Это repository templates/tooling: production host, traffic, TLS, firewall и services не изменялись.

Stage 6.1 не выполняет deployment и не создаёт production resources. Его decision record и host inventory должны получить GO до любых действий Stage 6.2.

## ENV

Список базовых переменных находится в `.env.example`.

### Rate limiting и reverse proxy

`TRUST_PROXY_MODE=none` остаётся безопасным local/test default: приложение не доверяет `Forwarded`, `X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`, `X-Client-IP` и другим клиентским IP-заголовкам.

Все неопознанные HTTP-клиенты используют один стабильный identifier внутри каждого rate-limit bucket. Это исключает обход лимитов подделкой заголовков, но означает, что один активный клиент может исчерпать общую квоту bucket для остальных. Перед публичным multi-user deployment нужен отдельный проверенный ingress/provider adapter с недоступным напрямую origin и надёжным peer identity.

`TRUST_PROXY_MODE=nginx-single-host` используется только с B2 single-host ingress boundary. Web читает ровно один внутренний header `X-VideoSave-Client-IP`, принимает одиночный валидный IPv4/IPv6 и игнорирует публичные forwarding headers. B2 Nginx template перезаписывает header непосредственным client address; режим безопасен только при loopback origin, Nginx-only ingress и operator-enforced firewall boundary.

`RATE_LIMIT_MAX_REQUESTS` должен быть целым числом от 1 до 10000. Значение `0` не отключает rate limiting и считается ошибкой конфигурации.

### PostgreSQL persistence и queue/lease adapter

Инструкции по migrations, integration tests, TLS и минимальным DB privileges находятся в [PostgreSQL development note](docs/postgresql.md).

Кратко:

```bash
npm run db:migrate
npm run db:migrate:status
TEST_DATABASE_URL='postgresql://<test-role>@<host>/<disposable-test-db>' npm run test:postgres
```

`APP_PROCESS_ROLE` поддерживает `local|web|worker|migration`. В development/test отсутствующее значение означает `local`; в production роль обязательна, а `local` отклоняется. `web` требует `JOB_REPOSITORY_BACKEND=postgres`, `DATABASE_URL`, `MEDIA_STORAGE_BACKEND=durable-volume` и заранее подготовленный shared root. PostgreSQL/volume failure завершается fail-closed: fallback и dual-write отсутствуют. Durable execution payload является private internal data и не входит в public DTO.

Production web дополнительно требует explicit loopback `HOSTNAME`, `PORT` и `TRUST_PROXY_MODE=nginx-single-host`; wildcard/non-loopback bind отклоняется. Fixed proxy identity принимает только один valid IPv4/IPv6, а стандартные forwarding headers authority не являются. Local/test поведение остаётся trust-none.

`MEDIA_STORAGE_BACKEND` по умолчанию равен `local` только для local/test runtime. Web и worker требуют `durable-volume`, абсолютный заранее подготовленный `MEDIA_STORAGE_ROOT`, одинаковый non-secret `MEDIA_STORAGE_AUTHORITY_ID` и PostgreSQL registry из migration `003`. Marker `.videosave-volume` содержит v2 header и authority ID; runtime его не создаёт. Web использует read-only adapter и открывает только PostgreSQL-registered `published final`, worker сохраняет read-write boundary. Internal keys, source и partial artifacts не являются public API. Object storage и signed URLs относятся к Phase B.

Production web readiness собирается и запускается отдельно; она только читает DB/schema/volume и всегда закрывает pool:

```bash
APP_PROCESS_ROLE=web JOB_REPOSITORY_BACKEND=postgres MEDIA_STORAGE_BACKEND=durable-volume npm run check:web
TEST_DATABASE_URL='postgresql://<test-role>@<host>/<disposable-test-db>' npm run check:web:test
```

`check:web` использует только `DATABASE_URL` и проверяет exact migrations `001`–`004`, schema capabilities, artifact/queue surfaces и marker. Она не применяет migrations, не создаёт volume, не enqueue/claim-ит jobs. Test variant сам создаёт isolated schema и temporary marked root. Обычный `npm run build` не читает role/DB/volume: runtime разрешается лениво при server request.

Перед первым cutover packaged read-only check запускается отдельно под migration environment:

```bash
APP_PROCESS_ROLE=migration npm run check:cutover
TEST_DATABASE_URL='postgresql://<test-role>@<host>/<disposable-test-db>' npm run check:cutover:test
```

Production command никогда не использует `TEST_DATABASE_URL`. Он не применяет migrations и проверяет exact schema/history, runtime roles/grants, migration lock и cutover blockers.

### Standalone media worker

Worker собирается отдельно от Next.js и в production запускается обычным Node.js без runtime TypeScript transpiler:

```bash
npm run build:worker
APP_PROCESS_ROLE=worker JOB_REPOSITORY_BACKEND=postgres MEDIA_STORAGE_BACKEND=durable-volume npm run check:worker
APP_PROCESS_ROLE=worker JOB_REPOSITORY_BACKEND=postgres MEDIA_STORAGE_BACKEND=durable-volume npm run start:worker
```

Для readiness/start дополнительно обязательны `DATABASE_URL`, заранее созданный `MEDIA_STORAGE_ROOT` с тем же marker contract, применённые migrations `001`–`004`, доступные ffmpeg/ffprobe и strict worker/lease/lifecycle limits из `.env.example`. Connection string и storage path намеренно не показаны. `check:worker` не claim-ит jobs и не запускает maintenance.

Тесты worker boundary:

```bash
npm run test:worker
TEST_DATABASE_URL='postgresql://<test-role>@<host>/<disposable-test-db>' npm run test:postgres
TEST_DATABASE_URL='postgresql://<test-role>@<host>/<disposable-test-db>' npm run test:worker:smoke
```

Smoke использует локальный временный fixture, настоящие ffprobe/FFmpeg и не обращается во внешний Internet. SIGTERM/SIGINT прекращают новые claims, сохраняют renewal на bounded grace period, затем abort-ят download/probe/FFmpeg и закрывают pool. Один worker process выбирается PostgreSQL advisory lock-ом для bounded recovery/reconciliation; остальные продолжают processing без destructive maintenance. Persistent production API composition выполнена; host deployment wiring и реальный traffic cutover ещё не выполнены.
