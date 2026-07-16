# ADR 0002: Phase A production deployment decision record

- Status: Proposed / Pending operator inventory
- Date: 2026-07-16
- Stage: 6.1
- Scope: controlled single-host Phase A production deployment
- Repository checkpoint: `11f533854a22a522b8b37ae10e618b17b546b91c`
- Repository acceptance: Conditional GO; production deployment has not started

## Context

[ADR 0001](0001-production-deployment-architecture.md) defines the accepted Phase A runtime architecture. The [deployment runbook](../../deployment/README.md), [production release contract](../production-release.md), [PostgreSQL boundary](../postgresql.md), and [observability specification](../observability.md) define repository tooling and operational invariants. Stage 5 repository work is complete, but repository acceptance is conditional: it does not prove host, provider, backup, network, certificate, capacity, monitoring, or operator prerequisites.

Stage 6.1 is a documentation and inventory checkpoint. It does not authorize host creation, package installation, database or volume provisioning, release acquisition, migrations, service control, ingress changes, traffic, or any other production mutation. The non-secret machine-readable record is [the Phase A host inventory template](../../deployment/inventory/phase-a-host.example.yml).

Current status is **awaiting non-secret operator inventory**. Production traffic is prohibited. The next executable stage is **6.2 Host bootstrap**, and it remains blocked until this record reaches Stage 6.1 GO.

## Deployment decisions

The following decisions are fixed for Phase A:

1. Production uses one controlled Linux application host. Multi-host operation is out of scope.
2. Nginx is the only public ingress. Only TCP 80/443 may be public, subject to the approved traffic gate.
3. The standalone Next.js web process and standalone Node worker are separate non-root systemd services.
4. Migration is a separate, explicit, operator-triggered oneshot operation. Web and worker never apply migrations.
5. PostgreSQL is the only durable authority for jobs, queue eligibility, leases, cancellation, retry state, artifact metadata, lifecycle state, and terminal outcomes.
6. One durable POSIX media volume stores source, partial, staged, and published media using the repository authority-marker contract.
7. Application logging is line-oriented stdout/stderr routed to journald. Application-managed production log files are forbidden.
8. Web and worker liveness, readiness, and metrics are loopback-only. Nginx must reject the internal observability namespace.
9. Production starts only from an immutable release produced by the exact successful GitHub Actions artifact for the approved full commit. A Git checkout is deployment tooling or source evidence, never the production release.
10. Release directories are immutable after verified installation; promotion changes the `current` symlink atomically and does not silently restart services.
11. Production traffic remains closed until migration, role, volume, readiness, ingress-isolation, smoke, monitoring, and rollback acceptance are all complete.
12. Phase B is explicitly excluded. This decision adds no Redis, object storage, autoscaling, multiple application hosts, distributed rate limiting, or public multi-user SaaS claims.

## Exact repository and release provenance

The Stage 6 starting checkpoint is:

- repository: `memanisvililasa/video`;
- branch at checkpoint: `main`;
- full commit: `11f533854a22a522b8b37ae10e618b17b546b91c`;
- expected successful Validate workflow run: `29480413056`;
- expected release artifact ID: `8368276906`;
- expected artifact name: `videosave-phase-a-release-11f533854a22a522b8b37ae10e618b17b546b91c`;
- expected release ID: `videosave-1.0.0-11f533854a22`.

The exact repository catalog contains migrations `001`-`004`. Migration `005` is absent and is not part of Stage 6.1.

These identifiers are evidence for Stage 6.1 only. Stage 6.4 must re-verify exact workflow success, artifact identity, companion checksum, release manifest, full commit, target platform, and immutable installed tree. Artifact availability or a clean Git checkout alone is not release acceptance.

## Provisional provider-neutral host specification

These values are planning defaults, not confirmed capacity evidence or a procurement recommendation:

| Area | Provisional default | Confirmation required |
| --- | --- | --- |
| Operating system | Ubuntu Server 24.04 LTS | Image provenance, patch policy, kernel and support window |
| Architecture | x86_64 | Must match the exact release manifest target |
| Compute baseline | 8 vCPU, 32 GiB RAM | Real workload, FFmpeg profile and concurrency test |
| Root disk | Provider-appropriate system disk | Package, journal and operational headroom |
| Media storage | Separate persistent block volume, at least 500 GiB | Provider, device, capacity, IOPS, recovery and growth model |
| Media filesystem | ext4 or XFS | Hard-link and atomic-rename behavior on the real mount |
| PostgreSQL | Managed PostgreSQL 17 or a separate private PostgreSQL host | Provider, private connectivity, current patch level and operational owner |
| PostgreSQL transport | Verified TLS required | CA trust path and rotation procedure |
| Ingress | Nginx only; public TCP 80/443 | DNS, certificate and traffic-gate ownership |
| Administrative access | SSH only from approved administrator CIDR or VPN | Exact allowlist/VPN and break-glass process |
| Internal ports | Web, worker observability and all internal probes on loopback only | Host listener and firewall evidence |
| PostgreSQL network | Private network only | No Internet-routable listener or security-group path |
| TLS | Operator-managed ACME or managed certificate | Issuance, renewal, key ownership and failure procedure |
| Secrets | Protected root/operator-managed environment files outside releases | Secret store, owner/group, mode and rotation process |
| Backups | Encrypted PostgreSQL backups with mandatory restore verification | Destination, retention, RPO, RTO and drill evidence |
| Monitoring | Operator-managed external collection and alert delivery | Platform, access boundary, routing and retention |
| Deployment | Immutable release directories and atomic promotion | Host-specific ownership and deployment operator |

NFS and object storage are not Phase A media storage. The 500 GiB media baseline must not be interpreted as sufficient until expected workload, TTL, concurrent attempts, output expansion, bytes/inodes headroom, and failure recovery are reviewed.

## Unresolved operator inventory

Every item below is unresolved and blocks Stage 6.1 GO:

- provider;
- region;
- host ID;
- public hostname;
- approved administrator CIDR or VPN;
- exact workload and job concurrency;
- PostgreSQL provider and private-network model;
- backup destination and retention;
- volume provider, device, confirmed capacity and performance class;
- monitoring platform;
- alert delivery channel/class;
- maintenance window and timezone;
- recovery point objective (RPO);
- recovery time objective (RTO);
- compatible immutable rollback candidate;
- traffic enable/disable mechanism;
- responsible production operator.

The inventory may contain non-secret provider identifiers, host metadata, paths, role names, public hostnames and CIDRs approved for documentation. It must not contain credentials, private key material, production payloads, signed source locations, populated environment files, or raw environment/log dumps.

## Stage 6 execution structure

No row below authorizes execution by itself. Each mutation stage requires a fresh preflight and the approval stated in the final column.

| Stage | Goal | Prerequisites | Mutation boundary | Stop condition | Rollback point | Acceptance criteria | Separate user approval |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 6.1 Decision record and host specification | Resolve non-secret architecture, inventory, ownership and GO/NO-GO | Stage 5 repository Conditional GO and exact checkpoint | Documentation files only | Required inventory missing; Critical/High blocker unresolved; secret detected | Revert documentation change; production remains untouched | Inventory complete, fail-closed checklist GO, no production mutation | Approval required to accept inventory and declare GO |
| 6.2 Host bootstrap | Prepare the approved Linux host, identities and base runtime | Stage 6.1 GO; verified host identity and access policy | Host users/groups, directories and approved packages only | Host/architecture mismatch; unrestricted SSH; version/provenance failure | Approved host snapshot/rebuild or scoped bootstrap cleanup | Exact host/toolchain/users/layout verified; services stopped; no traffic | Yes, before any host mutation |
| 6.3 PostgreSQL and durable POSIX volume provisioning | Establish private PostgreSQL roles/database boundary and one authority-bound POSIX mount | 6.2 accepted; backup and storage decisions approved | DB/roles/grants, mount/layout and marker only | Public or non-TLS DB; wrong/missing mount; incompatible marker; permission/probe failure | Pre-provision backup/snapshot; never temp/local fallback | Private TLS DB, least privileges, durable mount, authority and role probes accepted | Yes, separate DB/storage approval |
| 6.4 Exact release acquisition and immutable installation | Acquire the exact successful artifact and install it without promotion | 6.3 accepted; exact artifact available; deployment root ready | Artifact transfer and new immutable release directory; `current` unchanged | Workflow/artifact/checksum/manifest/commit/target/lock mismatch | Current release remains unchanged; preserve evidence | Exact installed release passes inspection and remains not-current | Yes, acquisition/install approval |
| 6.5 Migration and pre-cutover verification | Apply exact migrations explicitly and prove schema, roles, storage and not-current readiness | 6.4 accepted; traffic closed; tested DB restore point | Migration `apply` and exact post-migration grants only | Unknown/checksum/partial migration; lock; backup failure; cutover/readiness blocker | Before apply: restore point; after apply: traffic closed and forward-fix/approved restore, never automatic down migration | Migrations 001-004 exact; status/audit/cutover/web/worker checks pass | Yes, explicit migration approval |
| 6.6 Promotion and controlled service start | Promote atomically and start worker then web privately | 6.5 accepted; reviewed units; traffic gate closed | `current`, systemd unit installation/reload and controlled starts | Promotion, readiness, listener, leadership, metrics or restart-loop failure | Stop services; compatible atomic promotion only after rollback check | Exact worker/web ready on loopback, one lifecycle leader, traffic still closed | Yes, promotion and service-start approvals |
| 6.7 First traffic cutover | Validate Nginx/TLS/smoke boundary and enable approved controlled traffic | 6.6 accepted; rendered ingress; monitoring active; rollback ready | Nginx reload and traffic-gate change only | Smoke/TLS/DNS/header/isolation failure; direct origin/internal exposure | Close traffic first; stop services; compatible rollback or forward fix | No-egress smoke, isolation matrix and first controlled persistent flow pass | Yes, independent traffic-enable approval |
| 6.8 Post-deploy audit and rollback readiness | Verify stable operation, evidence, backup and emergency path | 6.7 accepted; audit owners available | Read-only audit; rollback only under a separate incident decision | Page alert, mixed release, capacity/DB/queue/leader/exposure fault | Immediate traffic close; documented compatible rollback sequence | Observation window accepted; exact identity and rollback readiness retained | Audit approval; separate approval for any rollback mutation |

## Tooling readiness matrix

`Ready` means the repository capability exists. `Partial` means repository support exists but host/provider/operator integration is still required. `Missing` means no repository implementation exists and Stage 6.1 does not add one.

| Capability | Repository command/tool | Readiness | Linux-only | Required operator input | Blocker severity | Stage |
| --- | --- | --- | --- | --- | --- | --- |
| Release discovery | GitHub CLI `gh run list` / `gh run view` | Partial | No | Repository access, exact commit | High | 6.4 |
| Exact workflow verification | Validate workflow plus GitHub CLI run/check inspection | Partial | No | Expected run and full commit | Critical | 6.4 |
| Artifact download | GitHub CLI `gh run download` | Partial | No | Artifact ID/name and trusted destination | High | 6.4 |
| Checksum verification | Companion SHA-256 plus `scripts/release-deployment.mjs install` | Ready | Production installer: yes | Absolute archive/checksum paths | Critical | 6.4 |
| Immutable install | `npm run release:deploy -- install` | Ready | Yes | Deployment root, full commit, explicit confirmation boundary | Critical | 6.4 |
| Release inspection | `npm run release:deploy -- inspect` | Ready | Yes | Release ID and full commit | High | 6.4/6.6 |
| Promotion | `npm run release:deploy -- promote` | Ready | Yes | Release ID, full commit, approval | Critical | 6.6 |
| Rollback compatibility | `npm run release:deploy -- rollback-check` | Ready | Yes | Current/target release IDs and commits | Critical | 6.7/6.8 |
| Migration status | `npm run db:migrate:status`; packaged migration runner | Ready | No | Migration role environment and private DB | High | 6.5 |
| Migration apply | `npm run db:migrate`; packaged migration runner | Ready | No | Explicit approval, tested restore point | Critical | 6.5 |
| PostgreSQL privilege verification | `deployment/postgres/privilege-audit.sql` | Ready | No | Role names and administrator connection | High | 6.3/6.5 |
| Cutover readiness | `npm run check:cutover`; packaged cutover check | Ready | No | Migration-role environment | Critical | 6.5 |
| Volume initialization | `npm run volume:admin -- initialize-marker` | Ready | POSIX host required | Canonical root and non-secret authority ID | Critical | 6.3 |
| Volume check | `npm run volume:admin -- check` | Ready | POSIX host required | Role, root, authority, free-space policy | Critical | 6.3/6.8 |
| Hard-link/rename probe | `npm run volume:admin -- probe` | Ready | POSIX host required | Worker UID and mounted root | Critical | 6.3 |
| Web readiness | `npm run check:web`; packaged `checks/web-readiness.mjs` | Ready | Host acceptance: yes | Web role environment | Critical | 6.5/6.6 |
| Worker readiness | `npm run check:worker`; packaged worker `--check` | Ready | Host acceptance: yes | Worker environment, FFmpeg/ffprobe | Critical | 6.5/6.6 |
| systemd verification | Templates plus `npm run verify:deployment:linux` and host `systemd-analyze verify` | Partial | Yes | Approved rendered units and host limits | High | 6.2/6.6 |
| Nginx verification | Template plus `npm run verify:deployment:linux` and host `nginx -t` | Partial | Yes | Hostname, certificate paths, rendered config | Critical | 6.7 |
| No-egress smoke | `npm run smoke:production:no-egress`; packaged smoke | Ready | Production host: yes | Private base URL and exclusive worker window | Critical | 6.7 |
| Controlled-egress dry-run | `npm run smoke:production:controlled-egress -- --dry-run` | Ready | Production host: yes | Explicit small HTTPS source and exact host allowlist | Medium | 6.7, optional |
| Observability health/readiness/metrics | Loopback web/worker endpoints and installed-release checks | Ready | Host verification: yes | Scraper address/interval and listener evidence | High | 6.6/6.8 |
| Alert definitions | `lib/observability/alert-rules.ts`; `npm run verify:observability` | Ready | No | External evaluator and thresholds review | High | 6.1/6.8 |
| Dashboard specification | `docs/operations/dashboard.md` | Ready | No | External dashboard platform and queries | Medium | 6.1/6.8 |
| Backup verification | Deployment checklist/runbook only | Missing | Provider-specific | Destination, encryption, retention and evidence | Critical | 6.3/6.5 |
| Restore drill | Deployment checklist/runbook only | Missing | Provider-specific | Isolated restore target, owner, RPO/RTO evidence | Critical | 6.3/6.5 |
| Post-deploy audit | Deployment checklist, dashboard, journald guide and runbooks | Partial | Host-specific | Observation window, query/scrape/log owners | High | 6.8 |

Missing or partial provider tooling must not be invented or silently skipped in Stage 6.1.

## Stage 6.1 GO/NO-GO checklist

The authoritative machine-readable values live in the host inventory. A checkbox may become complete only when its value, owner, and evidence are recorded without secrets.

### Required for GO to Stage 6.2

- [ ] Provider and region are selected.
- [ ] A supported controlled Linux host and architecture are selected.
- [ ] CPU, RAM, root disk and persistent media capacity are accepted.
- [ ] Deploy username and responsibility boundary are assigned.
- [ ] Administrator CIDRs or VPN are approved.
- [ ] Public hostname and DNS ownership are assigned.
- [ ] TLS issuance/renewal approach is approved.
- [ ] Firewall/security-group model keeps only approved ingress public.
- [ ] PostgreSQL model and private network boundary are approved.
- [ ] PostgreSQL verified-TLS model and CA trust location are defined.
- [ ] Encrypted backup destination and retention are defined.
- [ ] Restore-test approach, owner and evidence requirements are defined.
- [ ] Volume provider, device, filesystem and confirmed capacity are defined.
- [ ] Expected workload, job concurrency and media limits are accepted.
- [ ] Monitoring platform and loopback collection path are defined.
- [ ] Alert delivery class/channel is assigned without embedding a delivery secret.
- [ ] Maintenance window and timezone are approved.
- [ ] RPO and RTO are approved.
- [ ] Traffic gate can be closed and opened independently of application startup.
- [ ] A compatible rollback release is identified or Stage 6 remains NO-GO.
- [ ] Responsible operator and approvers are named.
- [ ] Exact commit, successful workflow and artifact provenance are independently verified.
- [ ] Inventory secret scan and YAML validation pass.
- [ ] No Critical or High blocker remains unresolved.

### Mandatory NO-GO conditions

Stage 6.1 is NO-GO if any of these conditions exists:

- operator ownership is unknown;
- PostgreSQL is public or lacks verified TLS;
- release installation is mutable or production would run from a Git checkout;
- durable POSIX media storage is absent;
- tested backup/restore plan is absent;
- internal health/readiness/metrics are reachable beyond loopback;
- SSH is not restricted to approved CIDRs or VPN;
- compatible rollback candidate is absent;
- the inventory contains a secret or populated production environment;
- exact full-commit, workflow and artifact provenance is absent or inconsistent.

Current Stage 6.1 decision: **NO-GO / awaiting non-secret operator inventory**.

## Security boundary and unresolved risk classification

| Threat/boundary | Required control | Current classification | Resolution evidence |
| --- | --- | --- | --- |
| SSH/root separation | Named operator, CIDR/VPN restriction, non-root deploy identity, separate service users | Critical — unresolved | Access design and owner |
| Deploy and service identities | Deploy user cannot run runtime services; web/worker/migration use distinct non-login users | High — unresolved on host | Host user/group inventory |
| Environment files | Root/operator managed outside release; role-specific owner/group; mode 0600 or 0640 | High — unresolved on host | File ownership/mode plan, not file contents |
| PostgreSQL least privilege | Separate migration/web/worker roles; runtime roles do not own schema | High — unresolved externally | Privilege-audit plan and owner |
| PostgreSQL transport | Private network and verified TLS | Critical — unresolved | Network model and CA trust location |
| Public ingress | Nginx only; direct origin unavailable | Critical — unresolved | Firewall/listener design |
| Internal endpoints | Web/worker health, readiness and metrics on loopback only | High — unresolved on host | Listener and ingress-isolation plan |
| Trusted proxy identity | Nginx overwrites forwarding identity; web uses `nginx-single-host` trust mode | High — repository control ready, host unresolved | Rendered-config test plan |
| Firewall/security group | Public TCP 80/443 only when gate permits; SSH restricted; DB/internal ports private | Critical — unresolved | Ruleset model and owner |
| Media volume ownership | Worker write boundary; web read-only published access; migration no media access | Critical — unresolved on host | UID/mode/mount plan and probes |
| Source/partial isolation | Job/attempt paths inaccessible to web and Nginx | High — repository control ready, host unresolved | Real-UID access test plan |
| FFmpeg subprocess | Non-root worker, fixed server-owned arguments, resource/time bounds, graceful process-group termination | High — repository control ready, sizing unresolved | Version/resource/concurrency acceptance |
| Release provenance | Exact successful artifact, companion checksum, full commit, manifest verification, immutable install | Critical — provenance known, Stage 6.4 recheck required | Workflow/artifact/install evidence |
| DNS/TLS | Controlled DNS ownership, certificate-key protection, renewal and failure procedure | High — unresolved | DNS/TLS owner and approach |
| Backups | Encrypted PostgreSQL backups and isolated restore verification | Critical — unresolved | Retention and successful drill plan |
| Logging/redaction | stdout/stderr to journald; no credentials, payloads, paths, SQL, URLs or raw stderr in evidence | Medium — external retention unresolved | Journald/retention/access policy |
| Monitoring exposure | Loopback scrape; external collector access must not create public endpoint | High — unresolved | Monitoring topology |
| Rollback safety | Traffic closes first; exact compatibility check; no automatic DB down migration or volume mutation | Critical — rollback candidate unresolved | Candidate release and operator procedure |
| Destructive operations | Separate explicit confirmation and fresh preflight for every destructive or traffic-affecting action | High — unresolved operator process | Approval matrix |

There are no known Critical or High repository defects introduced or discovered by Stage 6.1. The unresolved Critical/High items above are external operator prerequisites: they block Stage 6.1 GO and Stage 6.2, but do not prevent committing this fail-closed documentation checkpoint.

## Inventory security rules

The YAML template is deliberately non-secret. It records decisions and pointers, never credential values. Do not place passwords, database connection URLs, test database URLs, access tokens, OAuth credentials, private keys, SSH private keys, TLS private keys, backup encryption keys, delivery webhooks, cookies, authorization headers, signed URLs, production payloads, populated environment files, or raw environment dumps in the inventory or supporting evidence.

Secret values must remain in an approved external secret manager or protected host files created only in a later explicitly approved stage. Paths recorded in inventory are metadata and must not be accompanied by file contents.

## Consequences

- Stage 5 repository work is complete, but production readiness remains conditional on operator and host evidence.
- Stage 6 deployment has not started; this record performs no production mutation.
- Production traffic remains prohibited.
- Stage 6.2 cannot begin while this record is NO-GO.
- Updating unresolved inventory values requires review but must not weaken ADR 0001, release provenance, role separation, fail-closed readiness, or rollback constraints.
- Phase B requires a separate decision and is not implied by any Phase A inventory value.
