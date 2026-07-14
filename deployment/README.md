# Phase A single-host deployment boundary (5.9.8B2)

Этот runbook описывает воспроизводимый, но ещё не выполненный deployment. Все команды ниже являются operator-reviewed примерами. Приложение, npm scripts и tests не создают users, не монтируют filesystem, не меняют firewall/TLS, не устанавливают units и не переключают production traffic.

## Topology

```text
Internet -> Nginx/TLS (80/443) -> 127.0.0.1:3000 standalone web
                                      |              |
                               PostgreSQL       published (read-only)
                                      |              |
                        standalone worker -> durable POSIX volume
                                FFmpeg/ffprobe       jobs + published
```

Phase A поддерживает один controlled Linux host. Nginx — единственный public ingress; web слушает только loopback; worker не имеет HTTP listener. PostgreSQL находится локально либо за private/managed boundary. Web, worker и elected lifecycle coordinator используют один PostgreSQL и один POSIX volume. Journald — минимальный log transport. Multi-host, autoscaling, Redis и object storage не поддерживаются.

## Users, groups и layout

- `videosave-web:videosave-web` — standalone web;
- `videosave-worker:videosave-worker` — worker/FFmpeg;
- `videosave-migrate:videosave-migrate` — operator-triggered migration process;
- `videosave-media` — supplementary group только для ограниченного media access;
- deploy user устанавливает releases, но не запускает services.

`videosave-web` и `videosave-worker` входят в `videosave-media`. Раздельные primary groups не позволяют worker читать `web.env`, а web — `worker.env`. Migration user не входит в media group.

```text
/opt/videosave/
  releases/<release-id>/  deploy/root owned; directories 0555, files 0444
  current -> releases/<release-id>

/etc/videosave/
  web.env                  root:videosave-web 0640 (или 0600)
  worker.env               root:videosave-worker 0640 (или 0600)
  migration.env            root:videosave-migrate 0640 (или 0600)

/var/lib/videosave/media/  videosave-worker:videosave-media 2750
  .videosave-volume        videosave-worker:videosave-media 0640
  jobs/                    videosave-worker:videosave-media 2700
  published/               videosave-worker:videosave-media 2750
```

Release, secrets и persistent media не пересекаются. Nginx не состоит в media group и не получает `alias`/`root` на volume. Web unit дополнительно закрывает `jobs` через `InaccessiblePaths`, поэтому source/partial/staged недоступны ему. Runtime отдаёт только PostgreSQL-registered published final.

## Durable volume и authority marker

Mount должен находиться в `/var/lib/videosave/media` до создания marker. Marker имеет фиксированное имя `.videosave-volume` и deterministic non-secret format:

```text
videosave-media-volume:v2
authority:<32-lowercase-hex-authority-id>
```

Тот же ID задаётся в `MEDIA_STORAGE_AUTHORITY_ID` web/worker env. Другой root с v2 marker, но иной authority, не принимается. Старый B1 marker v1 несовместим с authority-bound v2 и блокирует rollback. Runtime marker не создаёт.

Provisioning boundary:

1. Смонтировать отдельный durable POSIX filesystem ровно в media root. Marker не создавать на underlying root filesystem.
2. Проверить `findmnt --mountpoint /var/lib/videosave/media`; target не должен быть `/`.
3. Создать root/jobs/published с указанными owner/group/modes. Не выполнять recursive chmod/chown существующих artifacts.
4. Сгенерировать non-secret 128-bit authority ID approved host entropy source и записать его в оба runtime env.
5. Выполнить dry-run и explicit initialization:

```bash
npm run volume:admin -- initialize-marker --root /var/lib/videosave/media --authority-id <authority-id> --dry-run
npm run volume:admin -- initialize-marker --root /var/lib/videosave/media --authority-id <authority-id>
```

6. Под worker user выполнить `check --role worker`, затем `probe --dry-run` и `probe`.
7. Под web user выполнить `check --role web`; writable root считается blocker.

CLI не создаёт root, отклоняет symlink/non-canonical roots, не перезаписывает incompatible marker и удаляет только свои unique probe files. `check` не пишет; `probe` проверяет hard links и atomic rename. Повторить после remount/reboot.

`nodev`, `nosuid`, `noexec` совместимы: media являются data. Hard links и atomic rename внутри root обязательны; root/jobs/published должны находиться на одном filesystem. Проверяются free bytes/inodes, но runtime low-disk threshold не заменяет monitoring. Volume и host остаются одним failure domain.

## Environment и PostgreSQL

Скопировать `deployment/env/*.env.example` вне release и заменить placeholders. Не использовать repository `.env`, `TEST_DATABASE_URL`, shell substitutions или world-readable permissions. Web обязан иметь `HOSTNAME=127.0.0.1`, persistent backends и `TRUST_PROXY_MODE=nginx-single-host`. Worker использует отдельные DB credentials и absolute FFmpeg/ffprobe paths. Migration env содержит DDL-capable role.

См. `deployment/postgres/README.md`. Provision database/roles по private verified-TLS boundary, применить migrations как `videosave_migration`, затем exact grants и read-only audit. Runtime roles не владеют schema. PostgreSQL port не публикуется в Internet. Back up DB до migration apply. `status`/`apply` используют advisory lock; web/worker startup migrations не применяют.

## Immutable release install и promotion

B1 release должен быть собран Node.js `24.18.0`/npm `11.6.0` на целевом Linux runner из clean commit. Admin tooling требует canonical absolute paths. Оно проверяет companion SHA-256, распаковывает только regular deterministic B1 USTAR entries, запускает B1 verifier, переводит tree в read-only и атомарно переименовывает sibling staging. Existing target отклоняется; старые releases не удаляются.

```bash
npm run release:deploy -- install --archive <absolute-archive> --checksum <absolute-checksum> --root /opt/videosave --dry-run
npm run release:deploy -- install --archive <absolute-archive> --checksum <absolute-checksum> --root /opt/videosave
npm run release:deploy -- inspect --root /opt/videosave --release-id <release-id>
npm run release:deploy -- promote --root /opt/videosave --release-id <release-id> --dry-run
npm run release:deploy -- promote --root /opt/videosave --release-id <release-id> --confirm
```

Promotion принимает только installed/read-only/verified release. `current` должен отсутствовать либо быть symlink внутрь `releases`; обычный file/directory блокирует operation. Relative temporary symlink atomically replaces `current`. Services автоматически не рестартуют. Output содержит IDs, не absolute paths.

## systemd templates

Три templates находятся в `deployment/systemd`. Оператор выполняет review limits и `systemd-analyze verify` на deployment host до установки. Entrypoints:

- web: `node server.js`; preflight release verifier + `checks/web-readiness.mjs`;
- worker: `node worker/main.mjs`; preflight `worker/main.mjs --check`;
- migration: `node scripts/postgres-migrations.mjs apply`, затем `status`.

`KillMode=mixed` посылает SIGTERM worker и не убивает FFmpeg group раньше grace window; `TimeoutStopSec=330s` должен быть больше `WORKER_SHUTDOWN_GRACE_MS`. Limits — conservative examples, проверяемые real-media smoke. `MemoryDenyWriteExecute` намеренно отсутствует из-за Node JIT. Unix/TCP address families сохраняют DNS, PostgreSQL, HTTPS и loopback. Templates не устанавливаются npm scripts; daemon-reload/start/restart выполняет оператор.

## Nginx, TLS, firewall и identity

Render `deployment/nginx/videosave.conf`, заменить все placeholders и выполнить `nginx -t` до reload. Repository не содержит domain/certificate paths.

Nginx перезаписывает `X-VideoSave-Client-IP` непосредственным `$remote_addr` во всех proxy locations, а upstream Host — отрендеренным canonical hostname; клиентские `X-VideoSave-Client-IP`, `X-Forwarded-For`, `X-Real-IP`, `Forwarded` и Host не являются authority. Web читает fixed identity header только при `TRUST_PROXY_MODE=nginx-single-host`. Boundary безопасна лишь при loopback origin и Nginx-only ingress.

Downloads идут через `/api/file/[id]` с disabled response buffering и bounded timeout. Media root не маппится. Access log использует `$uri`, без query/body; request ID проксируется. HSTS закомментирован до проверки HTTPS/subdomain impact.

Public firewall boundary: только TCP 80/443. Web 3000 — loopback. PostgreSQL — local/private. SSH policy отдельна. Operator-reviewed `ufw`/`nftables`/provider rules не запускаются приложением, npm или tests. TLS provision/rotation выполняет оператор/approved ACME agent.

## Первый deployment/cutover

1. Подготовить controlled Linux host и deploy identity.
2. Установить exact Node/npm toolchain.
3. Установить FFmpeg/ffprobe и проверить версии.
4. Provision private PostgreSQL и verified TLS.
5. Создать web/worker/migrate users и media group.
6. Создать immutable release root.
7. Mount durable volume.
8. Проверить filesystem hard-link/rename behavior.
9. Explicitly initialize authority marker.
10. Создать role-specific env files вне release.
11. Передать archive/checksum approved channel.
12. Проверить checksum/manifest install dry-run.
13. Install immutable release.
14. Подтвердить PostgreSQL backup/restore point.
15. Выполнить migration `status` новым runner.
16. Закрыть submissions/drain legacy traffic.
17. Дождаться legacy memory jobs либо явно отменить; не мигрировать их.
18. Выполнить migration `apply` отдельным one-shot process.
19. Повторить migration `status` и privilege audit.
20. Под web UID выполнить readiness нового release.
21. Под worker UID выполнить `--check` нового release.
22. Atomically promote release в `current`.
23. После review unit changes выполнить daemon-reload.
24. Запустить worker и проверить readiness/lifecycle leadership.
25. Повторить worker readiness.
26. Запустить web на loopback и выполнить readiness.
27. Проверить loopback `/api/health`, не публикуя origin.
28. Render Nginx и выполнить `nginx -t`.
29. Reload Nginx, сохраняя maintenance/disabled traffic.
30. Для no-egress E2E gracefully остановить regular worker, запустить one-shot smoke под worker UID, затем вернуть worker и проверить readiness/leadership. Regular worker не должен конкурировать за smoke jobs.
31. Controlled-egress smoke запускать только вручную после allowlist review.
32. Включить traffic.
33. Проверить DB sessions/locks, jobs/artifacts, capacity, journald и отсутствие legacy runtime.

Шаги 15/18/20/21 для not-current release выполняются operator-controlled transient one-shot с соответствующим `EnvironmentFile`, service UID и `WorkingDirectory=/opt/videosave/releases/<release-id>`. Env file не source-ится в interactive shell. После promotion штатный migrate unit использует `current`.

Worker готов до открытия traffic. Web может быть private для smoke, но Nginx не пропускает clients до E2E. Legacy memory и persistent web никогда одновременно не принимают production submissions. После первого persistent job memory production запрещён.

## Smoke tooling

Migration status/readiness — operator-side commands, не public admin endpoint.

```bash
npm run smoke:production:no-egress -- --base-url <explicit-origin> --timeout-ms 120000
```

No-egress smoke проверяет health, создаёт job существующим API, подтверждает PostgreSQL record, обрабатывает локально сгенерированный tiny FFmpeg fixture one-shot worker composition, ждёт ready, проверяет `/api/file/[id]` Content-Type/Length/body, повторно читает status новым HTTP request и проверяет persistent cancellation. SSRF/extractor registry/public API не меняются. Operator fixture всегда удаляется; job/artifact уходят штатным TTL/lifecycle, не direct filesystem deletion. Regular worker должен быть inactive.

```bash
npm run smoke:production:controlled-egress -- --base-url <explicit-origin> --source-url <explicit-small-https-media> --allowed-host <exact-hostname> --max-bytes 10485760 --dry-run
```

После dry-run оператор явно убирает флаг. Source требует HTTPS, exact hostname, standard port, supported extension и запрещает credentials/query/fragment. Cookies, Authorization/custom headers не принимаются; DNS/IP/redirect SSRF policy worker не ослабляется. URL/path не логируются. Command автоматически не запускается.

## Rollback

```bash
npm run release:deploy -- rollback-check --root /opt/videosave --from <current-release-id> --to <previous-release-id>
```

Checker сравнивает manifest schema, exact migration catalog/checksums, `postgres-durable` authority, marker version и role entrypoints. Он ничего не переключает/удаляет и не делает down migration. Если compatible: закрыть traffic, stop web/worker, promote previous с `--confirm`, запустить worker/readiness, затем web/readiness и traffic. DB автоматически не откатывается.

Rollback blocked при invalid release, schema/catalog/marker/authority mismatch или legacy memory target. После первого durable job memory rollback запрещён. Destructive/incompatible migration требует traffic stop и forward fix/approved restore. Failed promotion сохраняет previous release.

Failure actions:

- web startup: traffic closed; проверить journald/readiness, DB/marker; compatible app rollback;
- worker startup: не открывать submissions; проверить FFmpeg, grants, volume; rollback/forward fix;
- migration mismatch: services stopped, сохранить backup, checksum audit и forward fix;
- PostgreSQL unavailable: traffic stop; application rollback DB не восстанавливает;
- volume unavailable/read-only: stop worker/file traffic, remount/check marker; no temp fallback;
- Nginx invalid: не reload, сохранить действующий config/maintenance;
- file delivery broken: проверить registry, published state, marker и physical final через adapters;
- processing regression: stop submissions/worker, сохранить DB/volume, compatible release rollback.

Полный failure tabletop остаётся 5.9.8C.

## Minimal logs и limitations

Journald принимает release/role startup, readiness outcome, migration mismatch, DB/storage availability, worker graceful shutdown и sanitised `worker.lifecycle.leadership-acquired`/`worker.lifecycle.leadership-lost` events. Nginx хранит request ID/status/upstream outcome. Запрещены DB URLs, full source URLs, payload, absolute storage paths, SQL, credentials и full FFmpeg commands. Metrics/alerts/dashboards относятся к 5.9.9.

Phase A остаётся single-host/single-volume failure domain с manual first approval. Этот документ не утверждает, что production deployment выполнен.
