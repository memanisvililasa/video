# ADR 0006: X/Twitter production integration security decision

- Status: Accepted — NO-GO
- Date: 2026-07-21
- Stage: 8.8A
- Scope: public single-status X/Twitter metadata feasibility only
- Production integration: disabled
- Cookie-free, token-free, challenge-free, and impersonation-free feasibility: NOT CONFIRMED

## Context

Stage 8.8A establishes strict status-candidate URL classification, canonical numeric post identity, bounded synthetic metadata normalization, fail-closed content and availability classification, executable isolation, and production-isolation tests. It does not prove that public X/Twitter metadata can be obtained safely without authorization or transient session state.

The audited extractor paths depend on guest or bearer tokens, can observe login or session cookies, and use unstable GraphQL, legacy API, or syndication contracts. Rate-limit fallback can select crawler-style browser impersonation. Metadata extraction can also inspect signed CDN locators, manifests, cards, quoted media, or external media whose availability and lifetime are not a stable public contract. No path-aware controlled-egress executable adapter has been demonstrated that excludes those behaviors.

## Decision

X/Twitter production integration is **NO-GO**. Stage 8.8A retains only non-production URL and canonical identity primitives, synthetic metadata normalization, fail-closed error classification, executable isolation, and production-isolation tests.

There is no executable or live X/Twitter metadata provider. X/Twitter remains a disabled production placeholder. Public extraction, job submission, the worker, and the download orchestrator must reject X/Twitter without invoking an X/Twitter process, network adapter, redirect resolver, format resolver, downloader, or processor. Stage 8.8B and Stage 8.8C are prohibited until a new security decision supersedes this record.

## Prohibited mechanisms

This decision does not permit:

- cookies or hidden cookie loading;
- login, OAuth, session creation, or session reuse;
- guest tokens, bearer tokens, access tokens, or authorization headers;
- browser profiles or netrc;
- browser, client, or crawler impersonation;
- challenge solving or CAPTCHA bypass;
- user-controlled proxies or proxy bypass;
- DRM bypass;
- remote executable or JavaScript components;
- arbitrary or user-supplied headers, extractor arguments, downloader arguments, or processor arguments.

These mechanisms must not be introduced as a workaround for platform restrictions.

## Preserved foundation

The following deterministic foundation may remain:

- strict HTTPS status-candidate URL classification for exact X/Twitter hosts;
- canonical identity based only on a validated numeric post identifier;
- bounded synthetic metadata normalization for a single video or animated-GIF candidate;
- fail-closed classification for unsupported content, origin, hosting, and availability states;
- explicit executable isolation from the repository-controlled process runner;
- production-isolation and product-truth tests.

The foundation is not evidence of cookie-free or token-free feasibility, media availability, download support, original quality, or watermark behavior.

## Reconsideration prerequisites

A future decision may reconsider the boundary only after all of the following exist:

1. an audited, repository-approved executable contract;
2. an independently verified artifact, signature, and digest matching an approved immutable release;
3. documented and testable controls proving bearer, guest, session, cookie, login, and impersonation paths are absent;
4. path-aware controlled egress with DNS, private-address, exact-host, request-path, and redirect validation for every connection;
5. proof that metadata-only mode creates no files and fetches no media bodies, manifests, cards, thumbnails, subtitles, fragments, or external media;
6. a separate source and release-packaging security audit;
7. deterministic adversarial tests for output bounds, cancellation, cleanup, drift, rate limits, and redaction;
8. a separate owner-authorized ephemeral metadata-only acceptance.

Failure of any prerequisite leaves the decision at NO-GO. Metadata-only acceptance cannot authorize media download or production integration by itself.

## Consequences

- Cookie-free, token-free, challenge-free, and impersonation-free feasibility remains **NOT CONFIRMED**.
- No live X/Twitter request is authorized by this checkpoint.
- No X/Twitter metadata, redirect, format, download, processing, job, artifact, API, registry, worker, egress, observability execution signal, or UI support is enabled.
- Stage 8.8B and Stage 8.8C remain prohibited.
- Vimeo, YouTube, Reddit, direct-media, TikTok, Instagram, and Facebook behavior remains unchanged.
