# Changelog

## Unreleased

### Fixed

- Accept observed video carousel children with equal `vu`/`vhu`, and absent root/child captions. Keep present-field types and bounds, nested/unequal-variant rejection, and exhaustive ordered identity/type/date/cardinality checks.
- Persist optional closed-vocabulary listing diagnostic details without source strings. Isolate positively attributed unsupported formats and profile-not-found as handle-local PARTIAL; observer/transport/cleanup faults and current refusals remain global.
- Replace invented 500 ms public-provider pacing and standalone post-download delay with zero defaults (`public-provider-unpaced-v2`), preserving serialization, explicit caller delay/resource bounds and all cancellation/deadline checks. DOM settling/sampling grace is unchanged.
- Separate immutable refusal history, current-operation latches and active cross-run restrictions. Honor 429/503 Retry-After from original observation time; retain unresolved authentication/legal requirements. Generic historical technical refusals do not permanently ban later distinct attempts. Migration preserves original refusal evidence and prior counters; old denied result parts remain invalid. No live-ledger migration, provider switch, credential fallback or in-operation retry is performed by this code change.

## 0.3.2 - 2026-09-18

### Fixed

- Keep the `sync-window` discovery page open and acquire media through native fetch in the same browser context/session, rather than switching to Node fetch. No browser identity changes, cookie export, challenge bypass, denial clearance or fallback transport.
- Stream media via an isolated CDP world using one outstanding BYOB pull of at most 16 KiB. Apply shared request pacing/accounting once, retain refusal stops and cancel/release the media reader on byte/time/abort/file errors. Cleanup failures cannot report job success.
- Reject browser media redirects (`BROWSER_REDIRECT`) without following any hop: manual browser redirects do not expose the target required for validation. Standalone Node downloads retain validated redirect behavior.
- Add real offline cookie-conditioned Chromium and attached-CLI tests, including byte-verified receipts, bounded pulls, denial/redirect stops and cleanup. Passive discovery response observation and receipt schema are unchanged.
- Drain pending retained-page refusal observations before handle acceptance and ledger release, with bounded fail-closed finalization. Preserve valid files committed before a later refusal.
- Create media temporary files exclusively and track creation ownership, so a forced existing-path collision neither overwrites nor deletes the other owner's file.


## 0.3.1 - 2026-09-18

### Fixed

- Disconnect the Playwright client after an attached-CDP `sync-window` run, so the CLI exits naturally after publishing its receipt. The external browser and its pre-existing contexts remain open.
- Add real subprocess/CDP lifecycle regression tests alongside the owned-browser control.

## 0.3.0 - 2026-09-18

- Observe the provider listing response **passively**, at the page's own consumption boundary,
  and delete the response-stream interposition that preceded it. FrameFerry no longer creates a
  `Response`, `ReadableStream`, reader, clone, tee or forwarding queue of its own, and no longer
  reads a body the page has not read: the page keeps the native `Response` itself, with native
  `clone()` metadata, immutable headers, byte (BYOB) readers, `bodyUsed` and cancellation
  semantics intact, delivered by a native promise. For a listing request and for an observed
  `json()`/`text()` call that promise is one *chained* native promise carrying the same value,
  the same `Response` or the same rejection reason, so a rejection the page drops still reaches
  the page's own `unhandledrejection` handler on the promise the page holds; no event is
  dispatched, suppressed or marked handled on the page's behalf. Evidence admission checks every
  limit before the allocation it guards — a string value or key on its escaped UTF-8 size before
  it is escaped, and a wide parsed object one key at a time rather than through a complete key
  list — and refuses an oversized value whole rather than truncating or summarising it. Those
  bounds are on FrameFerry's own additional work, not on engine-internal enumeration and not on
  the browser heap. Listing evidence now comes from the page's own `json()`/`text()` completion. Consumption through any other path — `arrayBuffer()`, `blob()`, `formData()`, the
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
