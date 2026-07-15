# ADR 0001: Production deployment architecture

- Status: Accepted
- Date: 2026-07-13
- Stage: 5.9.1, amended through 5.9.8C1

## Context

VideoSave уже имеет asynchronous download API, polling, cancellation, direct-media download, ffprobe и несколько FFmpeg processing presets. Текущая runtime-архитектура при этом остаётся process-local:

- очередь jobs, progress, cancellation state и active handlers хранятся в памяти Next.js процесса;
- file registry хранится в памяти процесса;
- source, partial и final media хранятся на локальной filesystem;
- cleanup и TTL зависят от живого application process;
- FFmpeg запускается тем же runtime, который обслуживает HTTP;
- несколько application instances не разделяют job или file state.

Такая реализация пригодна для local development и controlled single-process usage, но не для публичного multi-user production. Stage 5.9 должен ввести persistent state и отдельный worker boundary без одновременного появления двух authoritative источников истины.

Этот ADR определяет обязательную архитектурную границу для следующих подэтапов Stage 5.9. Он не реализует persistence, queue, worker или deployment manifests и не задаёт детальную SQL schema.

## Decision

Stage 5.9 реализуется двумя отдельными фазами.

### Phase A: controlled production MVP

Phase A разворачивается на одном controlled host и не является публичным multi-user SaaS. Она включает отдельные web и worker процессы, PostgreSQL, shared durable volume и независимую от web elected-worker lifecycle coordination.

```text
Controlled/private clients
           |
  Reverse proxy / ingress
  (origin is not public)
           |
        Web process ------------- PostgreSQL
           |                           |
           | HTTP status/cancel        | jobs, progress,
           | and final download        | leases, cancellation,
           |                           | result metadata
           |                           |
           +---- shared durable volume-+---- Worker process
                                              |
                                        ffprobe / FFmpeg

Elected worker lifecycle coordinator - PostgreSQL + durable volume
```

Phase A состоит из следующих процессов и infrastructure components.

#### Web

- Обслуживает Next.js UI и HTTP API.
- Создаёт jobs через persistent job/queue boundary.
- Читает persistent job status и progress.
- Записывает persistent cancellation request.
- Отдаёт только зарегистрированные final files через текущий `/api/file/[id]` contract.
- После выделения worker boundary не скачивает source media, не запускает ffprobe и не запускает FFmpeg.
- Не использует локальный `AbortController` или process memory как authoritative job state.

#### Worker

- Atomically получает job через PostgreSQL-backed queue/lease model.
- Загружает source media и повторно применяет действующие URL/SSRF проверки.
- Регистрирует source metadata и artifacts.
- Запускает ffprobe и FFmpeg только с server-owned processing plan.
- Обновляет persistent progress, heartbeat и lease.
- Публикует ровно один final result.
- Реагирует на persistent cancellation state, завершает active subprocess и удаляет owned partial artifacts.
- Выполняет job-scoped cleanup и оставляет reconciliation elected lifecycle coordinator-у при transient failure.

#### Lifecycle coordination

- Выполняется только elected leader-ом внутри standalone worker runtime; election использует session advisory lock PostgreSQL.
- Удаляет expired job records и expired source/partial/final media в определённом lifecycle order.
- Повторяет неуспешный cleanup и выполняет reconciliation PostgreSQL metadata с durable volume.
- Не зависит от traffic или restart web-процесса; потеря worker/DB connection освобождает leadership и допускает election другим worker.
- Не удаляет artifacts действующего worker lease/attempt.

#### Infrastructure

- PostgreSQL, доступный отдельно от app process.
- Shared durable volume на том же host для source, partial и final media.
- Один controlled application host и одна storage failure domain.
- Reverse proxy/ingress, через который проходит весь разрешённый traffic; direct public origin запрещён.
- Runtime limits для CPU, RAM, disk, PID/process count, FFmpeg threads, job duration и worker concurrency.

### PostgreSQL authority

PostgreSQL является единственным authoritative источником для:

- job status и progress;
- queue eligibility, worker ownership и lease;
- cancellation state;
- retry state;
- canonical failure;
- source и final metadata;
- final result publication metadata;
- lifecycle timestamps и expiry.

In-memory queue и file registry могут временно существовать только как unit-test/local-development compatibility adapters до production cutover. Они не могут использоваться production-процессами параллельно с PostgreSQL как второй источник истины.

Выбор production adapters выполняется атомарно при startup. Конфигурация, которая смешивает persistent и in-memory job state, отсутствует, противоречива или не обеспечивает обязательные production dependencies, должна завершать startup fail-closed. Runtime fallback с PostgreSQL на in-memory state запрещён.

### Job and lease model

Persistent job model обязан представлять как минимум:

- `jobId`;
- `status`;
- `progress`;
- `processingPreset`;
- source metadata;
- final result metadata;
- canonical error;
- `createdAt`;
- `startedAt`;
- `completedAt`;
- `expiresAt`;
- `cancellationRequestedAt`;
- `retryCount`;
- `workerId` или `leaseOwner`;
- `leaseExpiresAt`;
- optimistic concurrency `version`.

Допустимые public job statuses сохраняются: `queued`, `running`, `ready`, `failed`, `cancelled`, `expired`. На уровне ADR не вводятся отдельные public states `claimed`, `retrying` или `cancellation-requested`.

Обязательные invariants:

- Claim выполняется атомарно; один действующий lease принадлежит не более чем одному worker attempt.
- Progress monotonic и не уменьшается.
- Все конкурентные изменения защищены optimistic concurrency/version и lease ownership.
- Expired lease делает non-terminal job доступной recovery policy.
- Retry разрешён только до terminal state и в пределах настроенной policy.
- Completion idempotent: повторная доставка одного attempt не создаёт второй result.
- Duplicate/stale worker не может опубликовать competing final result.
- `ready`, `failed` и `cancelled` являются immutable terminal outcomes; lifecycle может позднее перевести их только в `expired`.
- `cancelled` никогда не переходит в `ready`.
- Final metadata становится authoritative только вместе с успешным terminal transition.

Детальные table definitions, indexes, SQL locking statements и retry intervals относятся к следующим подэтапам.

### Durable volume boundary

В Phase A source, partial и final media находятся на durable volume, который переживает restart app/worker process и container restart.

- Web и worker подключены к одному volume; permissions разделяются по роли, и web должен иметь только необходимый read access к final media.
- Все paths генерируются сервером и остаются internal implementation detail. Absolute или relative storage paths не входят в public API, job DTO или logs.
- Artifacts изолируются в job/attempt-specific directories или эквивалентной server-owned layout.
- Partial write не считается final publication.
- Final bytes полностью записываются и проверяются до atomic filesystem publication и authoritative `ready` transition.
- Failed, cancelled и abandoned attempts очищаются idempotently.
- Scheduled reconciliation удаляет storage orphans и обнаруживает metadata, ссылающуюся на отсутствующий media artifact.
- Volume является single-host failure domain и не обеспечивает multi-host sharing, cross-region recovery или high availability.
- Backup media bytes не обязателен, если продукт допускает повторное создание job. Это решение не распространяется на PostgreSQL metadata: для неё требуется отдельная backup policy.

### Worker and FFmpeg boundary

Минимальные требования Phase A:

- ffprobe и FFmpeg запускаются только worker-процессом.
- Arguments формируются из fixed allowlisted server-side presets; user-provided executable arguments, paths, codecs, filters и credentials запрещены.
- Process запускается с `shell: false`.
- Worker работает non-root и не имеет Docker socket или лишних host mounts.
- Worker имеет CPU, RAM, PID/process, thread, disk и concurrency limits.
- Применяются input size, output size, media duration и resolution limits.
- Каждый job/attempt получает isolated writable directory; root filesystem должен быть read-only, если runtime это поддерживает.
- ffprobe, FFmpeg и overall job имеют bounded timeouts.
- Timeout, cancellation, lease loss и shutdown завершают всю process group через graceful signal с последующим force kill.
- Graceful worker shutdown сначала прекращает новые claims, затем завершает или безопасно relinquish-ит running attempt в рамках lease/retry policy.
- Worker concurrency задаётся конфигурацией и для Phase A остаётся ограниченной.

Отдельный container/job на каждую media task не является требованием Phase A. Он относится к Phase B либо отдельному security-hardening ADR.

### Cancellation and progress

- Cancellation request и её timestamp хранятся в PostgreSQL.
- Web-process `AbortController` не является источником истины и не требуется для recovery.
- Worker регулярно проверяет persistent job/cancellation state и также проверяет его перед irreversible publication.
- Active downloader/ffprobe/FFmpeg subprocess завершается worker-ом.
- Worker удаляет только owned partial/source artifacts отменённого attempt.
- Final artifact, успевший стать authoritative `ready` result до cancellation transaction, не удаляется.
- Cancellation/ready race разрешается atomic persistent transition и lease/version fencing.
- `DELETE /api/jobs/[id]` сохраняет текущие route, safe response serialization и idempotent terminal behavior.
- Progress хранится persistently, обновляется с throttling и остаётся monotonic.
- HTTP polling через `GET /api/jobs/[id]` сохраняется.
- WebSocket и SSE в Stage 5.9 не добавляются.

### Rate limiting and ingress

Phase A использует enforceable single-host Nginx boundary:

- Nginx является единственной публичной точкой входа, а standalone web обязан слушать только `127.0.0.1`, `::1` либо `localhost`.
- Nginx удаляет клиентские `Forwarded`, `X-Forwarded-For`, `X-Real-IP` и всегда перезаписывает fixed internal `X-VideoSave-Client-IP` непосредственным `$remote_addr`.
- Production web требует `TRUST_PROXY_MODE=nginx-single-host`; отсутствующий, duplicate/comma-separated либо malformed trusted identity не становится отдельным rate-limit identity.
- Direct public origin запрещён. Процесс, способный обращаться к loopback на controlled host, входит в trusted host boundary; отдельный origin secret для Phase A не вводится.
- Local/test сохраняет `TRUST_PROXY_MODE=none` и не требует Nginx.

Phase B требует отдельного ingress/provider решения и distributed limiter state для multi-host/multi-instance deployment. Phase A single-process limiter не заявляется как distributed SaaS control.

### Security constraints

- SSRF, DNS rebinding и redirect validation остаются обязательными для каждого outbound source request.
- Media processing принимает только local server-owned files; FFmpeg network protocols не включаются.
- Path traversal, symlink escape, object/path injection и overwrite existing files должны блокироваться storage boundary.
- Source, partial и final media имеют разные exposure rules; source и partial никогда не выдаются через public file API.
- Storage и PostgreSQL credentials разделяются по process role и не передаются FFmpeg child environment.
- File/job identifiers остаются unpredictable capability identifiers; это не заменяет user authentication для будущего SaaS.
- Source URL, query strings, cookies, credentials, local paths, raw stderr, signed URLs и tokens не логируются.
- Runtime image и FFmpeg должны быть pinned и поддерживаться security patch policy.

### Operational constraints and assumptions

Phase A основана на следующих предположениях:

- Использование private/controlled, а не anonymous public SaaS.
- Один application host.
- Ограниченное число одновременных jobs и явно ограниченная worker concurrency.
- PostgreSQL доступен отдельно от app process; managed PostgreSQL предпочтителен.
- Durable volume сохраняется при process/container restart.
- Worker restart не уничтожает authoritative job state.
- Redeploy может временно прервать running attempt; lease expiry/retry policy восстанавливает non-terminal job.
- Cleanup запускается независимо от web.
- Точные RPO/RTO, PostgreSQL backup retention и host/volume recovery procedure уточняются до production rollout.
- Phase A не обещает zero-downtime host migration или сохранность media при полной потере volume.

Readiness должна fail-closed проверять соответствующие process role dependencies. Liveness не должна превращаться в destructive recovery mechanism.

## Phase A restrictions and non-goals

Phase A не поддерживает и не должна неявно расширяться до:

- нескольких application hosts;
- нескольких независимых media volumes;
- serverless functions для FFmpeg;
- autoscaling web или worker;
- публичного multi-user SaaS;
- zero-downtime migration между hosts;
- cross-region recovery;
- object-storage delivery;
- signed download URLs;
- Redis/BullMQ или managed queue как дополнительного authoritative job source;
- container-per-job orchestration;
- WebSocket/SSE progress delivery;
- изменения текущего public API contract без отдельной migration decision.

На подэтапе 5.9.1 также не реализуются persistence interfaces, database schema, queue, storage adapter, worker, runtime configuration или deployment manifests.

## Phase B boundary

Phase B требует отдельного ADR до реализации. Она может добавить:

- shared private object storage;
- short-lived signed download URLs либо совместимую migration текущего proxy contract;
- distributed rate limiting;
- verified provider/ingress identity adapter;
- несколько stateless web instances;
- несколько workers;
- managed queue либо расширенную PostgreSQL-backed queue;
- autoscaling;
- более сильную worker/container isolation, включая container per job;
- multi-instance cleanup, reconciliation и scheduler coordination;
- multi-host, multi-zone или cross-region recovery согласно отдельным RPO/RTO.

Phase B не может использовать local/in-memory job state как authoritative fallback. Если managed queue будет добавлена, PostgreSQL authority и consistency mechanism должны быть отдельно описаны, чтобы не создать второй источник истины.

## Migration sequence

Будущая реализация Stage 5.9 выполняется в следующем порядке:

1. Persistence interfaces.
2. In-memory compatibility adapters для unit tests/local development.
3. PostgreSQL job repository.
4. PostgreSQL-backed queue и lease model.
5. Durable media storage adapter.
6. Отдельный worker process boundary.
7. Persistent cancellation, progress и recovery.
8. Production configuration и startup validation.
9. Финальный production-readiness/cutover audit; metrics/alerts остаются отдельным 5.9.9.
10. Multi-process, security и regression audit.

Production cutover должен остановить создание новых in-memory jobs, дождаться либо явно завершить существующие non-terminal jobs и затем атомарно включить persistent adapters. Dual-write или runtime fallback между in-memory и PostgreSQL запрещены.

Этот ADR не начинает реализацию перечисленных шагов.

## Alternatives considered

### Сохранить один Next.js process с mounted volume

Отклонено. Volume сохраняет bytes, но не executable queue handlers, progress, cancellation и registry. FFmpeg продолжает конкурировать с HTTP runtime.

### Использовать Redis/BullMQ как Phase A queue

Отклонено. PostgreSQL всё равно необходим для job/result metadata, а отдельная queue создаёт дополнительную consistency boundary и operational dependency. Redis может появиться в Phase B для distributed rate limiting или после отдельного queue ADR.

### Сразу использовать object storage

Отложено до Phase B. Object storage улучшает multi-host behavior, но не требуется controlled single-host MVP и увеличивает объём первой production migration.

### Сразу использовать serverless/provider-native jobs или container per task

Отложено. Такое решение требует provider-specific limits, orchestration, identity, callbacks и deployment manifests, которые не нужны Phase A.

### Сразу реализовать полный public multi-instance deployment

Отклонено для Stage 5.9 Phase A. Это одновременно потребовало бы object storage, distributed limiter, verified ingress identity, autoscaling и более сложного recovery.

## Consequences

### Positive

- Jobs, cancellation и progress переживают restart.
- Web и heavy media processing разделены.
- PostgreSQL предоставляет одну authoritative state machine и fencing boundary.
- Текущий HTTP polling и public job/file routes могут быть сохранены.
- Durable volume минимизирует Phase A infrastructure complexity.
- Interfaces следующего подэтапа могут подготовить замену volume на object storage без изменения public API.

### Negative

- Phase A остаётся single-host и single-volume failure domain.
- PostgreSQL и volume требуют backup/recovery runbooks.
- Interrupted FFmpeg attempt может повторно потребить CPU после lease recovery.
- Proxy file delivery продолжает использовать web connections и host egress.
- Trust-none общий rate-limit bucket не подходит публичному multi-user traffic.
- Переход с текущей queue требует controlled cutover, потому что in-memory handler closures невозможно мигрировать.

## Acceptance criteria

ADR считается соблюдённым дальнейшей реализацией Stage 5.9, когда:

- web, worker и cleanup responsibilities разделены указанными boundaries;
- PostgreSQL является единственным production authority для job, lease, progress, cancellation и result metadata;
- production startup запрещает in-memory authority и mixed configuration;
- job state machine соблюдает terminal immutability, monotonic progress, lease/version fencing и idempotent completion;
- source, partial и final media переживают process/container restart на shared durable volume;
- FFmpeg запускается только ограниченным non-root worker process;
- cancellation и progress не зависят от web-process memory;
- cleanup/reconciliation выполняются независимо от web traffic;
- Phase A origin loopback-only и закрыт Nginx-only ingress boundary;
- public multi-instance и Phase B capabilities не заявлены и не реализованы без отдельного ADR;
- production cutover не создаёт dual-write или два authoritative источника истины;
- существующие public API contracts меняются только через отдельное migration decision.

Подэтап 5.9.1 считается завершённым после принятия этого ADR, добавления ссылки из README и подтверждения, что runtime code, dependencies, API contracts и deployment manifests не изменены.
