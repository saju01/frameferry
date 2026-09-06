# Changelog

## 0.2.2 - 2026-09-06

- Add explicit, machine-readable date provenance to every normalized item and receipt: `dateStatus`, `dateProvenance`, `dateResolved`, and `dateEvidence`. A timestamp is authoritative only for an explicit four-digit year or already-ISO input; yearless and relative labels stay unresolved with the raw label preserved, and no year is ever inferred from neighbouring items, scrape order, or the wall clock.
- Add `requireCaptureTimestamp`, which fails closed rather than letting an unresolved date reach anything that needs a real capture instant.
- Add `planPendingImport`, a pure advisory helper that groups byte-identical media by SHA-256 before a pending import so identical bytes are registered once, while preserving every source reference, category, and stable ID, reporting truthful unique-byte versus reference counts, and holding disputed identities and malformed entries instead of discarding them.
- `parseDateText` and `dateParsed` are unchanged, so existing callers and receipts written by earlier versions keep working; legacy receipts recompute provenance from `dateRaw` and degrade to unresolved rather than to a fabricated timestamp.
- Pin resolved dates to UTC from the calendar fields the label spelled. `Date.parse` reads a zone-less label as local midnight while ISO output renders UTC, so on a host east of UTC `1 January 2019` would have been stored as `2018-12-31T13:00:00.000Z` -- the wrong year in the field that claims to be authoritative. `dateResolved` is now identical on every host timezone.
- Refuse incomplete and impossible dates in every form: `2024-08`, `2024`, `August 2024`, `31 February 2024`, and ISO dates that name a day which never existed, whether date-only (`2024-02-31`) or time-bearing (`2024-02-31T00:00:00Z`, `2023-02-29T12:00:00Z`). `Date.parse` is strict for a bare ISO date but lenient for a date-time, so the calendar is now validated arithmetically before parsing, leap years included. The same validator backs caller proofs and persisted records, so a normalized impossible date cannot reach `requireCaptureTimestamp` or an exported ZIP.
- Do not trust stored date provenance. Every `provider-*` claim is re-derived from `dateRaw` and must match, and `caller-proven` must carry well-formed allowlisted evidence, so a hand-edited or third-party-written record cannot launder a forged timestamp through `requireCaptureTimestamp` or into an exported ZIP.
- Make date evidence a closed vocabulary (`{ kind, note }`) instead of free text, with every URL-shaped token stripped, control characters removed, and the note length-capped before it is persisted or exported.
- Harden signed-provider-URL redaction to cover case variants, explicit ports, userinfo, subdomains, protocol-relative forms, and any query parameter order.
- `planPendingImport` now preserves every field a caller supplied on each reference, reports invalid or missing categories instead of coercing them to `posts`, validates stable IDs arriving through `known`, rejects bare dot segments and leading dashes, surfaces array holes as errors, and raises `BAD_ARGS` for a non-iterable batch.

## 0.2.1 - 2026-09-06

- Identify the pagination sentinel by observing which element the provider's own `IntersectionObserver` watches, instead of assuming the last rendered `.post-card`.
- Fix stalled pagination: a carousel renders its slides as sibling `.post-card`s after the post's top-level card, so centering the final DOM card parked the real sentinel outside the observer's 200px `rootMargin` and growth stopped.
- Retain the markup heuristics as fail-closed fallbacks for pages where the probe was not installed: first card of the trailing same-`data-id` run, then the last card.
- Report `sentinelIndex`, `sentinelId`, and `sentinelSource` in the returned pagination state.
- Correct the documented pagination contract to the observed-sentinel mechanism and its fallback order.
- Correct the `dateParsed` documentation: a provider string with no explicit year, or one that does not parse, is preserved verbatim rather than converted to a timestamp.

## 0.2.0 - 2026-09-05

- Add category-aware archive selection for posts, reels, stories, and highlights.
- Preserve the full baseline regression inventory and add export/privacy/bootstrap coverage for the new content-selection and ZIP paths.
- Keep post completeness honest: unknown post denominators are `ACTION_REQUIRED`, advertised shortfalls stay `PARTIAL`, and stale failed-overlap entries are retried/cleared correctly.
- Add safe local ZIP export with JSON inventories, receipt sidecars, byte re-verification, stale-`.part` handling, checksums, atomic finalize, and ZIP32-safe limits.
- Document installed-skill bootstrap and local CLI-path usage without assuming a global `frameferry` binary.
- Optional OpenClaw orchestration guide remains documentation-only; the download runtime still has no LLM dependency.

## 0.1.0 - 2026-09-05

- Initial public skill and CLI.
- Bounded full archive and sync modes.
- Durable lock, manifest, status, and SHA-256 receipt model.
- Conservative InstaCognito selector contract and provider URL validation.
- Offline node:test coverage and bwrap sandbox launcher.
