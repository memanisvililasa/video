# PostgreSQL development and testing

Phase A least-privilege role template и read-only audit находятся в [`deployment/postgres`](../deployment/postgres). Production использует отдельные migration/web/worker credentials, verified TLS и private connectivity; runtime roles не владеют schema. Deployment sequence находится в [`deployment/README.md`](../deployment/README.md).

Подэтапы 5.9.3–5.9.8A добавляют PostgreSQL implementation `JobRepository`, durable queue/lease adapter, explicit Phase A shared-volume storage runtime, отдельный compiled Node worker, elected lifecycle coordination и role-aware production web composition. `APP_PROCESS_ROLE=web` routes используют persistent enqueue/status/cancellation и PostgreSQL artifact delivery; memory queue и process-local registry остаются только local/test compatibility adapters. B2 добавляет только deployment templates/tooling; реальный traffic cutover отсутствует.

## Конфигурация

Явный PostgreSQL repository runtime создаётся через `createExplicitJobRepositoryRuntime`, queue runtime — через `createExplicitPostgresJobQueueRuntime`. Production web boundary создаётся `createProductionWebRuntime`; один lazy per-process resolver выбирает либо полностью local runtime, либо полностью persistent web runtime и не делает fallback/dual-write.

- `JOB_REPOSITORY_BACKEND=memory|postgres`, default — `memory`;
- `DATABASE_URL` обязателен только для explicit `postgres`;
- `POSTGRES_SSL_MODE=disable|require`;
- `POSTGRES_POOL_MAX` — от 1 до 20;
- connection, statement, query и idle timeouts имеют строгие bounds из `.env.example`.

Queue/lease параметры также читаются только explicit factory. Standalone worker использует `WORKER_CONCURRENCY`; test-only queue factory сохраняет default 2:

- `WORKER_CONCURRENCY` — 1–8, default 2;
- `JOB_LEASE_DURATION_MS` — 15000–300000, default 60000;
- `JOB_LEASE_RENEW_INTERVAL_MS` — 1000–60000, default 15000 и не более трети lease duration;
- `JOB_RECOVERY_INTERVAL_MS` — 5000–60000, default 15000 и не больше lease duration;
- `JOB_RECOVERY_BATCH_SIZE` — 1–1000, default 100;
- `JOB_RETRY_BACKOFF_BASE_MS`/`JOB_RETRY_BACKOFF_MAX_MS` — persistent bounded retry delay;
- `JOB_ACTIVE_TTL_SECONDS` — абсолютный deadline queued/running lifecycle;
- `JOB_MAX_RETRIES` — 0–10, default 3.

В production разрешён только `POSTGRES_SSL_MODE=require` с проверкой сертификата (`rejectUnauthorized: true`). Значение `disable` отклоняется fail-closed. Local PostgreSQL и `TEST_DATABASE_URL` могут использовать TLS mode `disable`. URL и credentials не выводятся migration runner, repository или readiness helper.

Pool создаётся лениво и не подключается при обычном импорте либо `next build`. Production resolver создаёт один pool на web process; explicit test factories могут создавать независимые pools для multi-instance checks. Shutdown выполняется через runtime `close()`.

## Migrations

Migration runner читает canonical catalog с exact SHA-256 для `001`–`004`. Только `apply` берёт session advisory lock, создаёт history при необходимости и применяет каждую новую migration транзакционно. `status` работает в отдельной `BEGIN READ ONLY` transaction, использует transaction-local `search_path`, не создаёт schema/history, не берёт advisory lock и fail-closed отклоняет unknown/checksum-mismatched history. Web/API requests migrations не запускают, `install`, `postinstall` и `build` hooks отсутствуют.

Для development database:

```bash
DATABASE_URL='postgresql://<migration-role>@<host>/<database>' npm run db:migrate
DATABASE_URL='postgresql://<migration-role>@<host>/<database>' npm run db:migrate:status
```

Для disposable test database:

```bash
TEST_DATABASE_URL='postgresql://<test-role>@<host>/<disposable-test-db>' npm run db:migrate:test
TEST_DATABASE_URL='postgresql://<test-role>@<host>/<disposable-test-db>' npm run db:migrate:test:status
```

Повторный apply сообщает, что migrations уже актуальны. Изменение уже применённого SQL обнаруживается по SHA-256 checksum и не принимается молча.

Migration `001` создаёт authoritative `media_jobs`. Migration `002` не переписывает `001`: она добавляет nullable private execution payload (`source_url`, `format_id`), payload/lease constraints, FIFO claim index и expired-lease recovery index. Старые строки без payload остаются читаемыми через `JobRepository`, но queue их не claim-ит.

Migration `003` не изменяет `001`/`002`: она добавляет fenced `lease_attempt_id` и authoritative `media_artifacts`. Registry хранит private relative storage key, kind (`source|partial|final`), state (`staged|published|missing`), safe filename/MIME, size, SHA-256, TTL и attempt identity. Public lookup допускает только `published final`, связанный с `ready` job; source/partial никогда не выдаются. Primary key уже является index для `fileId`, отдельные indexes обслуживают job lifecycle, TTL cleanup и bounded reconciliation.

Migration `004` не изменяет `001`–`003`: она добавляет private `available_at` для PostgreSQL-time delayed retry, `deadline_at` для абсолютного active-job deadline, FIFO eligibility/deadline indexes и singleton `media_lifecycle_state` checkpoint. Поля не входят в public DTO. Старые queued rows получают `available_at=created_at`; FIFO сохраняется среди уже доступных jobs.

## Queue и private payload

Atomic claim выполняется одним PostgreSQL statement с `FOR UPDATE SKIP LOCKED`, FIFO ordering по `created_at, job_id` среди `available_at <= statement_timestamp()` и временем PostgreSQL для lease. Lease renewal, cancellation observation, progress, source metadata и completion защищены одновременно owner/version/active-lease/deadline predicates. Recovery атомарно возвращает expired jobs в `queued`, сохраняет progress high-water mark, увеличивает `retry_count` и назначает persistent exponential bounded delay либо записывает canonical `failed` после исчерпания retry budget. Terminal update очищает lease, availability/deadline и private payload.

Payload содержит только нормализованные `sourceUrl`, `formatId` и уже существующий `processingPreset`. Он имеет строгий schema/size limit, не входит в `MediaJobRecord`/public serializers, повторно проходит URL/SSRF validation перед test-worker execution и не допускает credentials, tokens, cookies, произвольные FFmpeg args, executable или filesystem paths. Полный source URL не должен логироваться.

Test-only worker harness 5.9.4 остаётся узким fake-processor contract harness. Production worker 5.9.6 использует отдельный runtime и не продвигает test harness в production.

## Phase A durable media storage

Read-write runtime создаётся через `createExplicitDurableMediaRuntime`; production web создаёт отдельный read-only durable adapter. Минимальная конфигурация:

- `MEDIA_STORAGE_BACKEND=local|durable-volume`, default `local`;
- `MEDIA_STORAGE_ROOT` — обязательный абсолютный, заранее созданный root только для `durable-volume`;
- `MEDIA_STORAGE_MAX_JOB_BYTES`, `MEDIA_STORAGE_MAX_OUTPUT_BYTES` — bounded per-job/output limits;
- `MEDIA_FINAL_TTL_SECONDS` — 60–604800;
- `MEDIA_STORAGE_LOW_DISK_BYTES` — fail-closed reserve threshold;
- `MEDIA_CLEANUP_BATCH_SIZE` — 1–1000.

Import и `next build` не создают directories и не требуют volume/DB. Durable root содержит regular non-writable-by-group/other marker `.videosave-volume` с v2 header и non-secret 32-hex authority ID. Ожидаемый ID задаётся через `MEDIA_STORAGE_AUTHORITY_ID`; marker provisioned out of band и не создаётся runtime-ом. Web readiness проверяет root/marker/`published` read-only; worker readiness проверяет read-write/free-space. Оба процесса используют один POSIX volume. Root не world-writable; production не fallback-ится в temp.

Attempt workspace имеет server-generated layout `jobs/<job>/attempts/<attempt>/{source,partial,staged}`. Immutable final публикуется hard-link/no-overwrite в sharded `published/` namespace. Artifact сначала резервируется как `staged`, физический final создаётся, затем одна PostgreSQL transaction переводит artifact в `published` и job в `ready`; lease owner/version/attempt и PostgreSQL time проверяются под row locks. Общей filesystem/DB transaction не предполагается: elected lifecycle coordinator запускает bounded reconciler для stale staged rows, missing files и physical orphans. Отдельный scheduler daemon не добавлен.

`/api/file/[id]` contract не изменён. Dependency-injected durable delivery проверяет строгий unpredictable fileId, PostgreSQL `published final`, TTL, regular non-symlink file и exact size; internal key и absolute path не выходят в response/error. `web` route wiring использует эту delivery, `local` — прежний registry. Range requests и signed URLs в Phase A не добавлены.

## Production web role и readiness

`APP_PROCESS_ROLE=web` требует PostgreSQL + durable-volume configuration. POST повторно валидирует private work item и одним queue `INSERT` сохраняет job/payload/availability/deadline; GET читает `JobRepository`; DELETE вызывает persistent cancellation; ни один из путей не создаёт process-local handler closure или worker loop. Unknown/missing production role, DB/schema/marker failure и mixed backend configuration отклоняются без memory/local fallback.

```bash
npm run build:web-readiness
APP_PROCESS_ROLE=web JOB_REPOSITORY_BACKEND=postgres MEDIA_STORAGE_BACKEND=durable-volume npm run check:web
TEST_DATABASE_URL='postgresql://<test-role>@<host>/<disposable-test-db>' npm run check:web:test
```

Production command никогда не использует `TEST_DATABASE_URL`; test command создаёт отдельную schema и temporary marked root. Readiness сверяет exact checksums `001`–`004`, required tables/columns и выполняет только read-only zero-row capability queries. Migrations по-прежнему применяются отдельной command; production migration command требует `APP_PROCESS_ROLE=migration`.

Standalone release contract и role-specific environment templates описаны в [production release note](production-release.md). Systemd/Nginx/PostgreSQL templates, volume/release/smoke tooling и host runbook реализованы в [deployment boundary](../deployment/README.md). C1 добавляет read-only cutover blocker check, real-role acceptance и Linux gates; финальное evidence review остаётся C2. Production deployment не выполнялся.

Перед первым traffic cutover оператор запускает packaged `checks/cutover-readiness.mjs` с migration environment. Check использует `DATABASE_URL`, открывает только `READ ONLY` transaction, сверяет exact schema/tables/columns/indexes/constraints, migration history, runtime role flags/membership/ownership/grants, отсутствие migration advisory lock, invalid indexes/unvalidated constraints и unclaimable queued rows. Он не применяет migrations, не создаёт jobs/roles/schema и не использует `TEST_DATABASE_URL` в production.

Object storage и multi-host durability относятся к Phase B. Потеря controlled host/shared volume остаётся известным Phase A failure domain.

## Standalone worker process

Worker entrypoint не импортируется API routes и собирается отдельной командой:

```bash
npm run build:worker
npm run check:worker
npm run start:worker
```

`build:worker` создаёт standalone ESM для Node 22+ через pinned build-time `esbuild`; production runtime не требует `tsx`/`ts-node`. Ни `npm install`, ни `npm run build`, ни Next.js import не запускают worker, migrations или filesystem initialization.

Worker environment требует `APP_PROCESS_ROLE=worker`, `JOB_REPOSITORY_BACKEND=postgres`, `MEDIA_STORAGE_BACKEND=durable-volume`, `DATABASE_URL`, `MEDIA_STORAGE_ROOT` и существующие queue/storage/media limits. Дополнительные strict параметры: `WORKER_ID_PREFIX`, `WORKER_CONCURRENCY`, poll/progress interval, attempt timeout и shutdown grace. Prefix проходит hashing, а persisted lease owner сохраняет constraint-compatible вид `worker_<32 hex>`.

Readiness проверяет PostgreSQL, migrations `001`–`004`, required tables/columns, durable root/free-space/read-write health и bounded `ffmpeg -version`/`ffprobe -version`. Она не применяет migrations, не claim-ит job и не запускает maintenance. Production paths ffmpeg/ffprobe должны быть абсолютными; worker предполагается non-root.

Каждый attempt повторно валидирует private payload и URL/SSRF policy, скачивает source в server-generated workspace, запускает attempt-root probe/preset processor и сериализует renewal/progress/artifact reservations через один lease/version gate. Final filesystem hard-link не является PostgreSQL transaction: fenced coordinator одной DB transaction переводит artifact в `published` и job в `ready`; crash window остаётся existing reconciler-у.

SIGTERM/SIGINT прекращают claims, продолжают renewal в bounded grace period, после чего abort-ят streams/process groups. Lease не освобождается преждевременно: retryable interruption обрабатывается lease expiry/recovery policy. Persistent cancellation проверяется отдельным bounded observer независимо от progress writes. Временная потеря PostgreSQL допускается только в пределах `WORKER_DB_LOSS_GRACE_MS`; без восстановленного DB fence publication/completion запрещены.

## Lifecycle coordination (5.9.7)

Каждый worker может участвовать в election, но session-scoped PostgreSQL advisory lock удерживает dedicated pool connection только одного leader-а. Только leader выполняет destructive startup/periodic maintenance: deadline expiration, expired-lease recovery, retry exhaustion, artifact reconciliation, orphan attempt cleanup, final TTL expiration и retained-record cleanup. При потере connection lock исчезает на стороне PostgreSQL; follower повторяет election с bounded positive jitter. Отсутствие leadership не мешает обычному worker обрабатывать jobs, но destructive sweep без подтверждённого lock не выполняется.

Storage outage, read-only/low-disk health failure блокируют новые claims и abort-ят local attempts; недоступный mount никогда не трактуется как доказательство отсутствующего файла. Полная потеря single-host volume автоматически не восстанавливается. `ready` без physical final переводится в safe `expired`; abandoned `published` metadata без достаточного ready result не угадывается и приводит job к canonical failure, а immutable object сохраняется до TTL. Повторный reconciliation идемпотентен и защищает active attempt.

Progress остаётся public `0..100` без нового stage field, coalesces/throttles и монотонно сохраняет high-water mark между retry. Значение 100 записывается только atomic published+ready transition. Cancellation до DB publication выигрывает; успешно завершённый atomic ready result является terminal и поздний DELETE его не меняет.

Проверки:

```bash
npm run test:worker
TEST_DATABASE_URL='postgresql://<test-role>@<host>/<disposable-test-db>' npm run test:postgres
TEST_DATABASE_URL='postgresql://<test-role>@<host>/<disposable-test-db>' npm run test:worker:smoke
```

Smoke генерирует маленький fixture во временной директории, использует реальные ffprobe/FFmpeg и не требует внешней сети. Все test schemas, volume roots, pools и subprocesses удаляются после suite.

## Integration tests

```bash
TEST_DATABASE_URL='postgresql://<test-role>@<host>/<disposable-test-db>' npm run test:postgres
```

`TEST_DATABASE_URL` обязателен: без него dedicated suite завершается ошибкой и не считается успешно пропущенным. Database должна быть disposable и не должна содержать пользовательские production data. Suite создаёт уникальную schema, применяет migrations, запускает общий repository contract, atomic FIFO claim, ownership fencing, persistent backoff/deadline, advisory election, automatic recovery, retry/cancellation и реальные PostgreSQL/filesystem concurrency/reconciliation tests, закрывает pool/lock connections и удаляет только созданную schema. Саму database suite не удаляет.

## DB roles and network boundary

Production templates разделены на `roles.sql.example` (cluster role bootstrap), `database.sql.example` (database preparation), `runtime-grants.sql.example` (после migrations) и read-only `privilege-audit.sql`. Migration owner владеет schema/objects; `videosave_web` и `videosave_worker` не имеют owner membership, `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` либо schema `CREATE`.

- web: `SELECT` migration history/jobs/artifacts, `INSERT`/`UPDATE` jobs для atomic enqueue/cancellation; без artifact mutation, lifecycle access и job delete;
- worker: queue/lifecycle/artifact `SELECT`/`UPDATE`/`DELETE` и artifact `INSERT`, но без job `INSERT` или migration history mutation;
- migration: owner/DDL и migration advisory lock только для operator-triggered apply;
- disposable test admin: создаёт и полностью удаляет isolated owner/web/worker roles и database в real-role acceptance suite.

PostgreSQL не следует публиковать в Internet. Application origin также остаётся за закрытым ingress согласно ADR 0001; реальные hostnames, credentials и connection strings в документации не хранятся.
