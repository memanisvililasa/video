# ADR 0005: Facebook production integration security decision

- Status: Accepted — NO-GO
- Date: 2026-07-20
- Stage: 8.7A
- Scope: public single-video Facebook metadata feasibility only
- Production integration: disabled
- Cookie-free, challenge-free, and impersonation-free feasibility: NOT CONFIRMED

## Context

Stage 8.7A establishes strict video and Reel candidate URL classification, canonical numeric content identity, a dependency-injected synthetic short-link redirect contract, bounded synthetic metadata normalization, fail-closed content and availability classification, and production-isolation tests. It does not prove that public Facebook metadata can be obtained safely without authorization state or prohibited challenge behavior.

The investigated extraction paths can encounter login walls, depend on session or cookie state, trigger checkpoint or CAPTCHA behavior, and conditionally require browser, client, or crawler impersonation. Page, GraphQL, and API contracts are unstable, signed CDN locations are short-lived, and no controlled-egress executable adapter has been demonstrated that excludes these behaviors.

## Decision

Facebook production integration is **NO-GO**. Stage 8.7A retains only non-production URL and canonical identity primitives, a synthetic short-link redirect foundation, synthetic metadata normalization, fail-closed error classification, and production-isolation tests.

There is no executable or live Facebook metadata provider. Facebook remains a disabled production placeholder. Public extraction, job submission, the worker, and the download orchestrator must reject Facebook without invoking a Facebook process, network adapter, format resolver, downloader, or processor. Stage 8.7B and Stage 8.7C are prohibited until a new security decision supersedes this record.

## Prohibited mechanisms

This decision does not permit:

- cookies or hidden cookie loading;
- login, OAuth, access tokens, session creation, or session reuse;
- browser profiles or netrc;
- browser, client, or crawler impersonation;
- checkpoint or challenge solving and CAPTCHA bypass;
- user-controlled proxies or proxy bypass;
- DRM bypass;
- remote executable or JavaScript components;
- arbitrary or user-supplied headers, extractor arguments, downloader arguments, or processor arguments.

These mechanisms must not be introduced as a workaround for platform restrictions.

## Preserved foundation

The following deterministic foundation may remain:

- strict HTTPS video and Reel candidate URL classification;
- canonical identity based only on a validated numeric content identifier;
- a bounded dependency-injected synthetic short-link redirect contract;
- bounded synthetic metadata parsing and normalization;
- fail-closed classification for unsupported content types and availability states;
- production-isolation and product-truth tests.

The foundation is not evidence of cookie-free feasibility, media availability, download support, original quality, or watermark behavior.

## Reconsideration prerequisites

A future decision may reconsider the boundary only after all of the following exist:

1. an audited, repository-approved executable contract;
2. a verified artifact and digest matching an approved immutable release;
3. documented and testable controls proving cookies, session reuse, access tokens, impersonation, checkpoint or challenge solving, and remote components are disabled;
4. controlled egress with DNS, private-address, exact-host, and redirect validation for every connection;
5. proof that metadata mode creates no files and downloads no media bodies, thumbnails, subtitles, manifests, or fragments beyond an explicitly audited bounded metadata contract;
6. a separate source and release-packaging security audit;
7. deterministic adversarial tests for output bounds, cancellation, cleanup, drift, and redaction;
8. a separate owner-authorized metadata-only acceptance using ephemeral runtime input.

Failure of any prerequisite leaves the decision at NO-GO. Metadata-only acceptance cannot authorize media download or production integration by itself.

## Consequences

- Cookie-free, challenge-free, and impersonation-free Facebook feasibility remains **NOT CONFIRMED**.
- No live Facebook request is authorized by this checkpoint.
- No Facebook metadata, format, download, processing, job, artifact, API, registry, worker, egress, or UI support is enabled.
- Stage 8.7B and Stage 8.7C remain prohibited.
- Vimeo, YouTube, Reddit, direct-media, TikTok, and Instagram behavior remain unchanged.
