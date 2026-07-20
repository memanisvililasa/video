# ADR 0003: TikTok metadata adapter security decision

- Status: Accepted — NO-GO
- Date: 2026-07-20
- Stage: 8.5A
- Scope: public single-video TikTok metadata feasibility only
- Production integration: disabled

## Context

Stage 8.5A established strict TikTok URL classification, canonical video identity, a dependency-injected short-link boundary, synthetic metadata normalization, and fail-closed error classification. It did not prove that public TikTok metadata can be obtained safely without authorization state or prohibited challenge behavior.

The repository-pinned extractor cannot currently provide a verifiable metadata-only contract that disables challenge solving, client impersonation, and session-cookie behavior while preserving controlled egress. A command that merely requests metadata or skips file output does not prove that these network behaviors are absent. It also does not prove that no media-related endpoints, manifests, or signed source locations are requested internally.

## Decision

TikTok production integration is **NO-GO**. Stage 8.5A retains only non-production URL/identity primitives, a synthetic short-link transport contract, synthetic metadata normalization, and safe additive error classification.

There is no executable or live TikTok metadata provider. TikTok remains a disabled production placeholder. Public routes, job submission, the worker, and the download orchestrator must reject TikTok without invoking a TikTok process or network adapter. Stage 8.5B and Stage 8.5C are prohibited until a new security decision supersedes this record.

## Prohibited mechanisms

This decision does not permit:

- cookies or hidden cookie loading;
- login, OAuth, or session reuse;
- browser profiles or netrc;
- browser or client impersonation;
- challenge solving or CAPTCHA bypass;
- user-controlled proxies or proxy bypass;
- DRM bypass;
- remote executable or JavaScript components;
- user-supplied extractor, downloader, or processor arguments.

These mechanisms must not be introduced as a workaround for extractor or platform restrictions.

## Preserved foundation

The following deterministic foundation may remain:

- strict HTTPS TikTok video-page and short-link classification;
- canonical identity based only on a validated video identifier;
- dependency-injected synthetic short-link redirect tests with DNS, private-address, host, redirect-count, timeout, and abort checks;
- bounded synthetic metadata parsing and normalization;
- fail-closed classification for unsupported post types and availability states;
- production-isolation and product-truth tests.

The foundation is not evidence of cookie-free feasibility and is not a product-support claim.

## Reconsideration prerequisites

A future decision may reconsider the boundary only after all of the following exist:

1. an official, repository-approved executable artifact;
2. a verified digest matching the approved release artifact;
3. documented and testable controls that disable challenge solving, impersonation, cookie creation and cookie reuse;
4. controlled egress with DNS and private-address validation for every connection and redirect;
5. proof that metadata mode creates no files and downloads no media bodies, thumbnails, subtitles, manifests, or fragments beyond an explicitly audited bounded metadata contract;
6. a separate source and release-packaging security audit;
7. deterministic adversarial tests for output bounds, cancellation, cleanup, drift, and redaction;
8. a separate owner-authorized metadata-only acceptance using ephemeral runtime input.

Failure of any prerequisite leaves the decision at NO-GO. A metadata acceptance cannot authorize media download or production integration by itself.

## Consequences

- Cookie-free TikTok feasibility remains **NOT CONFIRMED**.
- No live TikTok request is authorized by this checkpoint.
- No TikTok metadata, format, download, processing, job, artifact, API, registry, worker, or UI support is enabled.
- Vimeo, YouTube, Reddit, and direct-media behavior remain unchanged.
