# Production release and deployment contract (5.9.8B1/B2)

Этот документ описывает standalone release boundary B1. Phase A templates, installation/promotion, smoke и operator runbook добавлены в [deployment runbook](../deployment/README.md) в B2. Реальный deploy не выполнялся; полный failure tabletop остаётся 5.9.8C.

## Toolchain и команды

Release contract зафиксирован на Node.js `24.18.0` и npm `11.6.0`. `.nvmrc`, `packageManager`, `engines` и builder должны совпадать. Обычные local/test команды не блокируются другой patch-версией, но `build:release` завершается до build при несовпадении approved toolchain.

```bash
corepack npm --version # must print 11.6.0
corepack npm run build:release
corepack npm run verify:release
corepack npm run package:release
corepack npm run test:release
```

`build:release` вызывает Next.js standalone build, существующие compiled worker/web-readiness builds, собирает чистый allowlist-only root `.release-dist/release`, создаёт manifest/checksums, запускает verifier и только затем packaging. Отдельный `package:release` повторяет verification существующего root и пересобирает `.release-dist/videosave-<version>-<commit>.tar.gz` с отдельным SHA-256. Release outputs игнорируются Git.

Build не читает production role/DB/storage configuration, не соединяется с PostgreSQL, не проверяет mount, не запускает HTTP server/worker и не применяет migrations. `npm install` внутри builder отсутствует.

## Состав release

Release содержит только:

- Next.js `output: "standalone"`, `.next/static` и `public`, если directory существует;
- compiled worker `worker/main.mjs`;
- read-only web readiness `checks/web-readiness.mjs`;
- migration runner `scripts/postgres-migrations.mjs` и migrations `001`–`004`;
- explicit operator-triggered production smoke bundle;
- self-contained release verifier;
- minimal runtime-only package metadata и Next.js-traced Node dependencies (`next`, React и `pg`);
- deterministic manifest и SHA-256 checksums.

В release не входят source tree, `.git`, `.env*`, tests/fixtures, `.next/cache`, coverage, screenshots/browser attachments, logs, temporary media, PostgreSQL data, source maps или локальные absolute paths. Next.js standalone trace может консервативно перечислить исходные `app/lib/tests`; builder их не копирует и standalone boot test проверяет минимальный artifact. Build-only absolute roots в generated standalone config нормализуются до release-relative `.`. Symlinks и неожиданные executable files запрещены. `pg` должен присутствовать только в server runtime trace и не попадать в client static assets.

## Entrypoints

Команды выполняются из release root:

```bash
APP_PROCESS_ROLE=web NODE_ENV=production HOSTNAME=127.0.0.1 PORT=3000 node server.js
APP_PROCESS_ROLE=web NODE_ENV=production node checks/web-readiness.mjs
APP_PROCESS_ROLE=worker NODE_ENV=production node worker/main.mjs --check
APP_PROCESS_ROLE=worker NODE_ENV=production node worker/main.mjs
APP_PROCESS_ROLE=migration NODE_ENV=production node scripts/postgres-migrations.mjs status
APP_PROCESS_ROLE=migration NODE_ENV=production node scripts/postgres-migrations.mjs apply
APP_PROCESS_ROLE=worker NODE_ENV=production node smoke/production-smoke.mjs --no-egress --base-url <explicit-origin>
node tools/verify-release.mjs .
```

Значения PostgreSQL/storage/worker configuration подаются отдельными host-owned environment files. Web/worker startup не применяет migrations автоматически. `ffmpeg` и `ffprobe` являются проверяемыми внешними system dependencies и в archive не входят.

## Manifest и reproducibility

`release-manifest.json` имеет versioned schema и stable sorted JSON. Он содержит package name/version, Git commit/tree, `SOURCE_DATE_EPOCH`-compatible timestamp, approved Node/npm versions, target platform, entrypoints, runtime authority, marker version, migration names/checksums и web/worker tree hashes. Environment values, URLs, credentials и storage paths запрещены. Единственный time-dependent prerendered output — sitemap `lastmod` — нормализуется тем же `SOURCE_DATE_EPOCH`, не меняя public route contract.

`checksums.sha256` покрывает каждый release file кроме самого checksums file, включая manifest. Verifier пересчитывает hashes, сверяет полный manifest↔filesystem contract и обнаруживает изменение/добавление/удаление. Archive имеет отсортированные USTAR entries, fixed uid/gid/modes/mtime и gzip timestamp, затем перечитывается и сверяется с release root.

Artifact platform-specific: manifest фиксирует `<platform>-<arch>`, а verifier отклоняет запуск на другой OS/architecture. Локальный macOS archive годится только для B1 contract/boot tests; Phase A production archive должен собираться approved toolchain на соответствующем Linux target. Publishable release также должен строиться из clean committed source; `sourceTreeDirty` позволяет B2 gate отклонить diagnostic dirty-worktree artifact.

## Environment templates

`deployment/env/*.env.example` — documentation templates, а не загружаемые repository `.env`. Перед будущим deployment их нужно скопировать вне release, заменить placeholders и ограничить mode `0600` либо `0640`. Production никогда не использует `TEST_DATABASE_URL`.

Web и worker используют разные runtime credentials, migration — отдельную DDL-capable role. Все роли указываются явно через `APP_PROCESS_ROLE`. Web требует read-only access к тому же durable root, worker — read-write; marker `.videosave-volume` содержит v2 header и non-secret authority ID, совпадающий с `MEDIA_STORAGE_AUTHORITY_ID` обеих ролей. B1 marker v1 не совместим с authority-bound v2 и блокируется rollback compatibility checker.

`TRUST_PROXY_MODE=nginx-single-host` принимает fixed internal `X-VideoSave-Client-IP` и не доверяет стандартным forwarding headers. B2 Nginx template перезаписывает header непосредственным client address; режим безопасен только с loopback-only origin и Nginx-only ingress.
