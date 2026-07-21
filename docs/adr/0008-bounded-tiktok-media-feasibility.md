# ADR 0008: Bounded TikTok media feasibility

- Status: Accepted — internal Stage 8.10B only
- Date: 2026-07-21
- Related: ADR 0003, ADR 0007
- Production integration: disabled

## Context

ADR 0003 rejected the upstream TikTok extractor because its execution can create or reuse cookies, generate device identifiers, impersonate browser clients, call additional APIs, and solve challenges. ADR 0007 later allowed only a repository-controlled public-page metadata adapter. Neither decision enabled TikTok media download or production support.

Stage 8.10B0 inspected two owner-authorized public single-video pages without requesting media bodies. Both bounded hydration payloads exposed progressive locators with the same transport structure: HTTPS on the standard port, an `expire` query field, and the fixed page Referer required by the pinned extractor contract. No third-party locator host, split topology, cookie, login, token, browser execution, or media request was observed.

## Decision

Stage 8.10B may implement an internal, test-owned progressive media pipeline subject to every boundary below.

- The page adapter may issue only its existing bounded request to the canonical public page host.
- Media requests may target exactly `v16-webapp-prime.tiktok.com` or `v19-webapp-prime.tiktok.com`.
- Wildcards, suffix matching, IP literals, custom ports, credentials, and any other media hostname are prohibited.
- Media redirects are prohibited so that expiry and identity checks occur before every media request. Any later redirect support requires a fresh security decision and must remain within the same two-host set.
- Each locator must be bound to the canonical video identity, contain one valid `expire` field, and retain the configured safety window immediately before use.
- Locators are server-only, freshly resolved before download, and never stored in durable state, public DTOs, errors, or logs.
- Only direct progressive MP4 candidates are eligible. HLS, DASH, manifests, split streams, audio-only locators, images, live posts, photo posts, and multi-item posts remain unsupported.
- Requests use only repository-controlled User-Agent, media Accept, Connection, and the fixed canonical-page Referer. Cookies, authorization, client headers, device identifiers, browser profiles, netrc, proxying, and impersonation are prohibited.
- TikTok must not execute through yt-dlp. The executable platform contract remains unchanged.
- Existing DNS/IP validation, redirect checks, byte/time limits, cancellation, path containment, FFmpeg/ffprobe validation, atomic publication, and cleanup policies remain mandatory.

## Production boundary

The internal adapter and pipeline are not registered with the production registry, public API, job submission, worker selection, or UI. Stage 8.10C and a separate security decision are required before any production enablement.

An owner-authorized live-download acceptance is required after deterministic implementation validation. It is not part of this decision or implementation checkpoint.

## Fail-closed policy

Any new media hostname, missing or malformed expiry, changed topology, required cookie or browser behavior, identity ambiguity, or unexpected response type is rejected. A different media host requires a new security review; the allowlist must not be widened by pattern.

Rollback is the removal or revert of the isolated internal modules. No database or production-data migration is involved.
