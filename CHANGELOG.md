# Changelog

## Unreleased

- Observe the provider listing response **passively**, at the page's own consumption boundary,
  and delete the response-stream interposition that preceded it. FrameFerry no longer creates a
  `Response`, `ReadableStream`, reader, clone, tee or forwarding queue of its own, and no longer
  reads a body the page has not read: the page keeps the native promise and the native `Response`,
  with native `clone()` metadata, immutable headers, byte (BYOB) readers, `bodyUsed` and
  cancellation semantics intact. Listing evidence now comes from the page's own `json()`/`text()`
  completion. Consumption through any other path — `arrayBuffer()`, `blob()`, `formData()`, the
  raw body stream, a `clone()`, or no consumption at all — is reported truthfully as inconclusive
  (`WINDOW_NOT_READY` with `unknown-response-evidence`) rather than certified. The withdrawn
  design's `peakObserverAllocationBytes` "measured high-water mark" is removed rather than
  restated: the reported counters are admitted UTF-8 bytes, their UTF-16 upper bound, armed
  observations and refusals, against the configured ceilings.

- Complete the bounded incremental-job contract for `sync-window`: per-handle
  entries are restricted to exactly five fields (`handle`, `dateAfter`,
  `expectedPosts`, `accessRequired`, `eligibility`) with job-wide policy and
  bounds rejected on a handle; configuration errors are typed (`BAD_ARGS`,
  `BAD_CDP`, `DATE_POLICY`) instead of raw platform errors; window readiness now
  requires positive settled evidence (profile match, reported total, POSTS
  category, no challenge/refusal, browser open, provider requests settled)
  rather than a merely stable DOM; the job deadline bounds request admission
  end-to-end; `resultParts` composition binds each projected file to its
  immutable on-disk receipt field-for-field; and cached receipt reuse is as
  strict as the core downloader's own identity gate. This does not change
  live media transport, full-feed coverage, or history coverage.
- Share paced request accounting across discovery and download, with sticky provider-denial stops. Do not import signed-account 120/140 quotas into the public provider; retain optional per-job bounds and resource limits.
- Carry explicit source-observation date estimates for incremental destination adapters while leaving raw archive date semantics unchanged.
- Reuse FrameFerry DOM extraction, fingerprint identities, downloader and byte-verified receipts; never infer legacy carousel aliases.

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
