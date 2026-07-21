# ADR 0007: Restricted TikTok public metadata feasibility

- Status: Accepted — CONDITIONAL GO for isolated metadata only
- Date: 2026-07-21
- Stage: 8.10A
- Scope: public single-video TikTok page metadata feasibility
- Production integration: disabled
- Supersedes: ADR 0003 only for the repository-controlled bounded page adapter described here

## Context

ADR 0003 correctly rejected the previous executable boundary because the pinned upstream TikTok extractor could use challenge solving, browser impersonation, cookies, application or device identities, and additional network paths that metadata-only command flags did not constrain. ADR 0003 remains the historical decision for that architecture and is not modified by this record.

Stage 8.10A introduces a different architecture: a repository-controlled Node adapter performs one bounded HTTPS page request and parses only an embedded application/json hydration script. It does not execute an upstream TikTok extractor or remote code. This checkpoint establishes deterministic feasibility; it does not authorize media download or product enablement.

## Decision

The restricted metadata adapter is **CONDITIONAL GO** under the following fixed boundary:

- input is a strict canonical public single-video identity or a bounded vm, vt, or www short link;
- the canonical page request is sent only to `www.tiktok.com` over HTTPS;
- the page request has a ten-second maximum, a four-MiB body limit, at most one redirect, a fixed non-browser request profile, and fresh DNS/private-address validation on every connection;
- short-link resolution uses HEAD, at most three redirects, exact reviewed TikTok hosts, a total ten-second deadline, and pinned-address HTTPS requests;
- the adapter parses only `__UNIVERSAL_DATA_FOR_REHYDRATION__` or `SIGI_STATE` when embedded as a bounded `application/json` script;
- metadata output contains canonical identity, sanitized text, duration, dimensions, orientation, audio truth when explicit, and single-video classification only;
- identity drift, malformed or deep JSON, duplicate hydration state, unknown content semantics, unexpected redirects, and response drift fail closed;
- login, private, challenge, rate-limit, region, age, removed, live, photo, slideshow, carousel, and multi-item states map to safe additive errors without returning provider bodies or locations.

The adapter remains outside the production registry, public API job graph, download orchestrator, worker, UI, and observability provider list. `TIKTOK_METADATA_PROVIDER_PRODUCTION_ENABLED` remains false.

## Prohibited mechanisms

This decision does not permit:

- yt-dlp or another upstream TikTok extractor;
- cookies, cookie generation, cookie persistence, OAuth sessions, netrc, or browser profiles;
- browser or client impersonation;
- application IDs, device IDs, mobile-application emulation, or generated provider identities;
- JavaScript challenge solving, CAPTCHA bypass, remote executable components, or page-script execution;
- API, GraphQL, embed, oEmbed, mobile, or internal endpoint fallback;
- user-controlled headers, proxies, extractor keys, request arguments, or process arguments;
- thumbnail, subtitle, manifest, media locator, or media-body requests;
- format exposure, download, FFmpeg, ffprobe, artifact publication, registry enablement, or product-support claims.

The pinned yt-dlp artifact remains required only by the already approved Vimeo and YouTube paths. TikTok is excluded from its executable platform contract.

## Network and output boundary

Page egress permits only the exact canonical host. Redirect targets are subject to the same host rule, HTTPS enforcement, DNS validation, private and reserved address rejection, pinned-address transport, and bounded response headers. Short-link egress permits only `vm.tiktok.com`, `vt.tiktok.com`, `www.tiktok.com`, and canonical video-page aliases needed to complete identity resolution.

The public-safe result never contains page URLs, source or CDN URLs, hydration JSON, provider response text, usernames, short codes, request headers, cookies, tokens, filenames, stderr, or process details. Descriptions are sanitized and bounded before they cross the adapter boundary.

## Acceptance and rollback

Deterministic tests are required for URL identity, redirects, private DNS, request policy, response bounds, malformed and deep hydration JSON, identity mismatch, content and availability mapping, redaction, cancellation, yt-dlp exclusion, and production isolation.

Owner-authorized metadata-only acceptance is a separate checkpoint after deterministic validation. Until that acceptance succeeds, the registry remains disabled. Challenge-only, login-only, region-blocked, rate-limited, or hydration-drift results are safe expected rejections and do not justify expanding the boundary.

Rollback is fail-closed: leave or restore the production gate to disabled and remove the isolated adapter from future enablement work. ADR 0003 and this record remain in history. Stage 8.10B media work and Stage 8.10C production enablement require separate decisions and acceptance.

## Consequences

- Cookie-free public metadata feasibility is conditionally established for ordinary public single-video pages within this narrow contract.
- TikTok media feasibility is not established.
- No TikTok product support is enabled.
- Vimeo, YouTube, Reddit, direct media, Instagram, Facebook, and X behavior is unchanged.
