# FrameFerry

Created and maintained by [Saju](https://github.com/saju01). MIT-licensed code;
downloaded content remains subject to its owners' rights. Built with AI assistance.

A small public OpenClaw skill plus Node CLI for archiving public Instagram media through https://instacognito.com/en/photo with bounded scans, durable receipts, and honest status reporting.

This is conservative: no login, cookies, paid APIs, reverse-engineered signatures, proxy rotation, paywall bypass, or false unlimited claims. Use it for personal or explicitly authorized archives of public profiles only. InstaCognito publicly advertises free public-profile viewing/download with no login at `https://instacognito.com/en/photo`; its terms at `https://instacognito.com/terms-and-conditions` prohibit commercial-scale scraping/archiving without authorization, copyright infringement, privacy abuse, private-access circumvention, and overburdening the service.

## Install / bootstrap

Use the local CLI path first; do not assume a global `frameferry` binary.

```bash
git clone https://github.com/saju01/frameferry.git
cd frameferry
npm ci
# Browser setup is explicit; this package does not auto-install a service or schedule.
npx playwright install chromium
node ./bin/frameferry.js doctor
# Optional after that:
# npm link
# frameferry --version
```

Node >=20, npm, and Playwright 1.63.0 are required. For archive/scrape runs you also need either `npx playwright install chromium` or an explicit `--browser-executable` path. `status` and `export` can run without launching a browser once a local archive already exists.

## CLI

Preferred local-path usage:

```bash
node ./bin/frameferry.js doctor
node ./bin/frameferry.js archive <handle> --output <path>
node ./bin/frameferry.js archive <handle> --mode sync --output <path> --max-pages 6
node ./bin/frameferry.js archive <handle> --output <path> --categories posts,reels,stories,highlights --media-types image,video --zip /exports/example.zip
node ./bin/frameferry.js export <handle> --output <path> --zip /exports/example.zip
node ./bin/frameferry.js status <handle> --output <path>
```

Optional after `npm link`:

```bash
frameferry doctor
frameferry archive <handle> --output <path>
```

Options for `archive`: `--mode`, `--categories`, `--media-types`, `--zip`, `--overwrite-zip`, `--max-pages`, `--max-time-ms`, `--max-bytes`, `--max-zip-bytes`, `--max-zip-entries`, `--max-zip-files`, `--delay-ms`, `--network-timeout-ms`, `--browser-executable`, `--browser-channel`, `--attach-cdp http://127.0.0.1:<port>`, and `--json`. `--categories` defaults to `posts`, so existing calls stay backward compatible.

CDP attach is loopback only and requires owner permission. When using `--attach-cdp`, FrameFerry closes only its own page/context and disconnects the Playwright transport, but does not kill the existing browser process or remote-debugging server. Clean fresh browser contexts can still legitimately return `PARTIAL`; rerun with the same output path to resume/reuse receipts.

## Output

```text
<output>/media/<handle>/<stable-id>.<ext>
<output>/receipts/<handle>/<stable-id>.json
<output>/.frameferry/<handle>/manifest.json
<output>/.frameferry/<handle>/status.json
<output>/.frameferry/<handle>/lock.json
```

Manifest and status are mode 600. Receipts include ID, category, media type, identity basis, bytes, SHA-256, content type, source host, run ID, timestamps, `dateRaw`, `dateParsed`, `captionTruncated`, and highlight grouping when exposed. They do not include ephemeral signed media URLs. Stable post media IDs stay `post-shortcode + carousel-index`, so URL rotation does not create duplicates for posts. Reels are category-qualified to avoid collisions. Stories and highlights have no stable shortcode in the public DOM, so later syncs re-fetch them and dedupe after hashing.

## Website contract

The scraper expects `input#search-input`, `button#download-btn`, `#post-container .post-card`, shortcode from descendant `[data-id]`, type from `[data-type]`, `.content-download-btn[href]` as HTTPS `instacognito.com/media?id=...`, date from the final meaningful `.post-footer` text, and a robust integer profile-header post count. Pagination scrolls the provider's own pagination sentinel into view center and waits for unique IDs/card changes/loading state, not the page footer. The sentinel is the element the provider's `IntersectionObserver` actually watches: FrameFerry wraps the `IntersectionObserver` constructor after navigation and before the search click, so whichever element the provider registers is marked as it is observed. Resolution is fail-closed and documented in order: the observed element, else the first card of the trailing same-`data-id` run (a carousel renders its slides as sibling `.post-card`s inheriting the parent's `data-id`), else the last rendered `.post-card`.

Each pagination step reports which sentinel it used. `sentinelSource` is `observed`, `id-run`, or `last-card`, matching that resolution order. `sentinelIndex` is the sentinel's zero-based position among the rendered `#post-container .post-card` elements. `sentinelId` is the sentinel's `data-id`, and is legitimately `null` for a post that carries no `data-id` at all (a post with no engagement renders neither `.likes-trigger` nor `.comments-trigger`); a `null` here is not a failure signal.

## Supported capability matrix

- **Posts**: implemented and regression-tested, with full-history completion still requiring observed terminal evidence. Legacy filenames/receipts retain their IDs; new discovery IDs use category/post/locator fingerprints. Provider fingerprints can rotate across runs: unchanged bytes require explicit scoped byte proof for compatibility, not encounter-order matching. See the bounded-discovery reference for the opt-in evidence root and remaining limits.
- **Reels**: implemented and regression-tested against the public DOM shape. IDs are category-qualified as `reels__<shortcode>-<carouselIndex>`. Live public-profile behaviour remains unproven in this repo.
- **Stories**: implemented and regression-tested against the public DOM shape. The provider UI exposes no stable shortcode, so later syncs re-fetch story/highlight media and dedupe after hashing. Live public-profile behaviour remains unproven in this repo.
- **Highlights**: implemented against the public tab plus highlight-group DOM shape and reported honestly when the provider exposes no groups. Live public-profile behaviour remains unproven in this repo.
- **Unavailable / blocked categories**: returned explicitly per section as `UNAVAILABLE` or `BLOCKED`; requested filters are never silently ignored.

## ZIP export

Portable ZIP exports are local-only and allowlist-based: verified media files plus generated metadata only. They exclude locks, browser profiles, logs, credentials, private reports, and signed provider URLs. Archives are streamed via `.part` and atomically renamed on success. Existing stale `.part` files fail closed unless `--overwrite-zip` is supplied, and export re-verifies every receipt's on-disk bytes before packaging or writing `checksums.txt`.

Current ZIP limits in this release are ZIP32-safe only: max 2 GiB output, max 5000 entries, and max 3000 source files. If a requested export would exceed that, FrameFerry fails closed instead of creating a corrupt archive.

ZIP layout:

```text
frameferry-<handle>-<utcTimestamp>/
  manifest.json
  index.json
  sections.json
  checksums.txt
  README.txt
  receipts/*.json
  media/*
```

A ZIP can be packaged successfully even when the archive itself is only partial. That completeness split is recorded inside `manifest.json` and `sections.json`.

## Metadata caveats

- This is **not** an Instagram account export.
- It can preserve only what the provider's public UI exposes.
- Provider captions in the visible DOM are truncated to 125 characters, so FrameFerry records them as `captionTruncated` rather than pretending they are full captions.
- FrameFerry never infers a missing year and never resolves an ambiguous date. When the provider string carries no explicit four-digit year, or does not parse, the cleaned provider text is preserved verbatim in `dateParsed` instead of being converted to a timestamp; `dateRaw` is always retained.
- `dateParsed` is therefore not guaranteed to be a timestamp. A consumer must check that the value is an ISO-8601 timestamp before treating it as a date.
- Deleted, expired, private, CAPTCHA-blocked, or otherwise hidden stories cannot be recovered.

## Status model

Global `COMPLETE` exits 0 and means every requested section completed with verified media. Posts only report `COMPLETE` when the provider-reported total is actually met; an unknown post denominator becomes `ACTION_REQUIRED`, and advertised shortfalls stay `PARTIAL`. Section records can also report `PARTIAL`, `UNAVAILABLE`, and `BLOCKED`. `DEFERRED` and `ACTION_REQUIRED` exit non-zero and preserve checkpoints; `DEFERRED` honors the full provider `Retry-After` window.

## Owner-opt-in periodic sync

No schedules are installed. If you want daily sync, add your own scheduler with an exact fixed-path command, for example:

```bash
frameferry archive example_handle --mode sync --output /archives/instagram/example_handle --max-pages 6 --max-time-ms 600000
```

No secrets are needed; do not put secrets on command lines.

## Optional cheaper-worker / stronger-reviewer workflow

In OpenClaw, ask: "Use FrameFerry with my cheaper worker model and my chosen
review model; keep the primary assistant coordinating and review every run."
Choose from models already available in your installation. You can instead
choose exception-only independent review for routine unchanged syncs.

The skill can guide native sub-agent delegation with isolated, compact briefs.
The Node CLI itself does the download/hash/dedup work without LLM API calls;
it has no model flags or hidden model dependencies. Worker and reviewer run
sequentially, not per photo, and the reviewer checks evidence rather than
redownloading. See [the orchestration guide](references/orchestration.md).
Delegation requires OpenClaw's exposed session tools and existing permissions;
it is instruction-driven, not a CLI-enforced scheduler or automatic model router.
No model-selection configuration or schedules are installed by this package.


## Receipt-only incremental jobs (explicit visible-window scope)

Use `frameferry sync-window --config /private/job.json` to let FrameFerry own discovery,
cutoff selection, download and receipt verification in scheduled integrations. This
command is **posts/current-visible-window only**, not full historical coverage.
The existing `archive` command and its stricter full-archive semantics are unchanged.

Example private configuration (keep real handles, paths and scheduling outside the package):

```json
{
  "runId": "2026-01-15T120000-example",
  "handles": [{"handle": "example", "dateAfter": "2026-01-01"}],
  "output": "/archives/window-cache",
  "resultFile": "/archives/runs/example.json",
  "requestLedger": "/archives/provider-requests.json",
  "timeZone": "UTC",
  "allowEstimatedDates": true,
  "browserExecutable": "/usr/bin/chromium"
}
```

- Explicit `dateAfter` is inclusive and selection retains uncertainty overlap.
  `allowEstimatedDates` opts in to estimates for this command only; raw archive
  `dateParsed` behavior does not change. Each selected receipt includes the raw
  label, observed instant, estimated instant, day bounds, timezone and precision.
- `COMPLETE` means all requested visible windows were read and their selected
  media verified. Output always has `fullHistoryComplete:false`. A stopped/empty/
  unreadable window or partial acquisition is nonzero, never a quiet success.
- There is **no default signed-account-style hourly or per-run request quota**
  for this public provider. `public-provider-unpaced-v2` adds no artificial wait
  between serialized request admissions. Standalone archives also default to zero
  post-download delay; explicit caller `delayMs` remains supported. Counts remain auditable; an optional `maxRequests`
  bounds one job only and is not advertised as a provider quota. Default resource
  bounds remain 1 GiB total download, 50 MiB/file, 10 minutes and 1,000 visible
  cards/handle. All provider-origin browser requests and download/redirect hops
  are counted; cosmetic previews, styles and fonts are blocked before sending.
  A real refusal stops the entire current operation and its run ID, including queued
  acquisitions. A distinct later attempt enforces actual provider restrictions:
  401/407 authentication, 451 legal restrictions, and evidenced login redirects
  remain blocked. This version has no audited auth/legal-resolution API; manual
  `cleared_denials` fields are ignored, and history must not be deleted to unblock it.
  429 and 503 Retry-After deadlines are calculated from the original observation
  (delta-seconds or HTTP-date), never restarted on reopen. Missing or
  invalid retry time ends this attempt without an internal retry; only a separately
  authorized/scheduled attempt may re-observe. Generic historical 403/content-wall/
  DOM refusals alone do not establish an eternal provider ban. No challenge bypass,
  credential fallback, provider switching or automatic retry loop is introduced.
  Original refusal objects are retained in `denial_history`, with idempotent versioned
  `denial_dispositions` and per-run refusal latches. Prior session counters are retained.
  Malformed evidence is an accounting blocker, not permission to start fresh.
  `requests.denial` describes the effective stop, while `requests.denialHistory`
  exposes typed historical dispositions separately from `requests.activeRestriction`.
  Stale ledger locks require explicit operator inspection, never automatic reset.
- Each completed file is a normal verified FrameFerry receipt. Restarts reuse
  positively bound, rehashed receipts. Old carousel positions and changing locators
  are not treated as identity aliases. A separate window cache keeps an unfinished
  full-history archive's outstanding work intact; the command never marks it complete.
- Optional `resultParts` lists recent FrameFerry result files for local-only composition.
  Every requested handle must have a matching completed window no older than 15 minutes;
  policy, cutoff, identity and file bytes are revalidated. Missing/stale/denied
  parts fail closed. The new result records source hashes and makes zero provider
  requests; original partial results and their failure status remain untouched.
- The result contains receipt paths/hashes and date provenance, not signed media
  locators. A destination adapter must validate the run, complete selected scope,
  handle coverage, path confinement and hashes before importing. Destination
  success (and cutoffs) must only advance after destination readback succeeds.
- Browser attachment is optional and explicit loopback-only `attachCdp`. Only the
  command's context/pages are closed. No schedule, credentials, Immich uploader,
  metadata rewrite or trash restoration is installed by FrameFerry. An absent or
  `null` `attachCdp` still means "launch locally"; an empty string no longer
  silently does — a non-loopback or unparseable `attachCdp` is `BAD_CDP`.
- Per-handle entries accept exactly five fields: `handle`, `dateAfter`,
  `expectedPosts`, `accessRequired`, `eligibility`. Job policy (`timeZone`,
  `allowEstimatedDates`), resource bounds and transport are job-wide by design and
  are rejected if placed on a handle, since a per-handle copy would silently
  weaken the job's stated policy for one handle. Any other per-handle key is
  `BAD_ARGS` naming the offending keys.
- Configuration errors are typed, never raw platform errors: unusable dates, time
  zones, non-string `output`/`resultFile`/`requestLedger` and malformed handle
  entries are `BAD_ARGS`. An unusable card date is a typed `DATE_POLICY` that
  isolates that handle instead of stopping the job.
- Window readiness requires positive settled evidence, not just a stable DOM: a
  window is accepted only when the profile matches, a reported total is present,
  the active category is POSTS, no challenge or access refusal is visible, the
  browser is open, and provider API requests have settled with none in flight or
  failed. Empty data with zero API requests is NOT readiness and NOT "nothing
  new". A `WINDOW_NOT_READY` handle carries a `readiness` diagnostics block (no
  DOM text, caption, API payload or signed URL) and is isolated to that handle
  only when that evidence is positively local; otherwise it is a global stop.
  A current-generation, settled HTTP-success listing with the requested profile but
  unsupported grammar is `UNSUPPORTED_LISTING_FORMAT`, a handle-local PARTIAL, never
  COMPLETE. Positively attributed profile-not-found is `HANDLE_UNAVAILABLE` and local
  too. Later handles proceed only after owned-page closure and refusal-observation
  drain. Missing/oversized body evidence, observer faults, ambiguous transport and
  cleanup failures remain global. Private/access walls still cancel the current operation.
- The job deadline bounds request admission: no provider request is reserved or
  forwarded after the deadline, browser connect/launch timeouts and poll sleeps
  are clamped to the remaining budget, and a recorded provider denial keeps
  precedence over a lapsed deadline.
- Composition (`resultParts`) binds to the immutable on-disk receipt, not to the
  result document being composed: each projected file must match the receipt at
  `receipts/<handle>/<stableId>.json` field-for-field, the part's `runId` must be
  a safe ID before being republished as `sourceRunId`, an unreadable or
  unparseable part is a typed `BAD_RESULT`, and a witness whose `sourceObservedAt`
  is later than the window's `observedAt` is rejected as evidence about that
  window.
- Cache reuse is as strict as the core downloader's own identity gate: proved
  bytes are not proof of identity, so corrupt receipt metadata is rejected even
  when the hash and filename are unchanged.
- Handles never attempted after a global stop are `NOT_COMPLETED` with the
  requested `scope` and `dateAfter`, so the result shape is consistent.
- Releasing the request-ledger lock is idempotent and best-effort; it can never
  replace the real run outcome. A genuine cleanup failure is published as
  `requests.ledgerCleanupError` instead of being thrown or silently dropped.

### Window acceptance and listing-response observation

A visible window is accepted as `COMPLETE` only when the rendered cards are bound, tuple for
tuple and in order, to the provider listing response the page itself received — shortcode, media
identity, media type and raw date, with carousel children and multiplicity preserved. FrameFerry
gets those bytes by **passively observing the page's own consumption** of that response.

- **What is observed.** The page-side probe records which listing responses arrived, and hooks
  `Response.prototype.json` and `Response.prototype.text`. When the page consumes a listing
  response through either method, FrameFerry looks at the value the page itself asked for, under
  an admission ceiling, and decodes it outside the page with a closed, strict grammar.
- **What is *not* observed, and what that means.** Every other path — `arrayBuffer()`, `blob()`,
  `formData()`, consuming the raw `response.body` stream, consuming a `clone()`, or not consuming
  the response at all — is **not observed**. Such a window is reported truthfully as
  **inconclusive** (`WINDOW_NOT_READY`, with a `binding.reason` of `unknown-response-evidence`),
  never as a completion. Inconclusive is not a failure of the page; it is the absence of the
  evidence this contract requires.
- **Supported variations and diagnostics.** Video children use the same equal
  `vu`/`vhu` mapping as root videos; missing captions are allowed on roots and children.
  Present captions remain bounded strings. Nested children, unequal variants, missing
  identity/date/media fields and unknown fields remain unsupported. Every ordered tuple
  and its cardinality must still match. Optional `binding.detail` uses a fixed vocabulary
  to distinguish decoder reasons, receipt/body overflow, missing evidence and body-read
  state; it never contains tokens, field names from a response, or source payloads.
- **What FrameFerry never does to get evidence.** It never reads, clones, tees, cancels, locks or
  disturbs a response body, never creates a `Response`, `ReadableStream`, reader or queue of its
  own, and never forces the page to consume a body so that observation can succeed. The page
  receives the native `Response` itself — identity, immutable headers, `clone()` metadata, byte
  (BYOB) readers, `bodyUsed` and cancellation semantics are the platform's own — carried by a
  native promise. For a listing request, and for an observed `json()`/`text()` call on a listing
  response, that promise is one *chained* native promise rather than the platform's own promise
  object: it settles with the same value, the same `Response` or the same rejection reason, and a
  rejection the page drops still raises the page's own `unhandledrejection` event, carrying the
  promise the page itself holds. Nothing is dispatched, suppressed or silently marked handled on
  the page's behalf.
- **What it may allocate.** The `text()` path allocates nothing to measure a body; the `json()`
  path performs one bounded, faithful re-serialization that admits every limit *before* the
  allocation it guards — a string value or key on its escaped UTF-8 size before it is escaped,
  and a wide object one key at a time, so no complete key list of an arbitrarily wide parsed
  object is ever built. An oversized or unrepresentable value is refused whole, never copied,
  truncated or summarised. What those ceilings bound is FrameFerry's own additional work: its
  explicit storage, the bytes it emits and the properties it reads. Enumeration the JavaScript
  engine performs internally for a walk is the platform's own and is **not** claimed to be
  bounded by them. Retention has its own separate ceiling. No heap high-water mark is claimed or
  reported.

### Honest limitations

- `COMPLETE` remains **only** the existing current-visible-posts contract, not
  full-feed or history coverage. Offline session-conditioned tests do not prove
  availability of any live provider; current-operation refusals and actual active
  restrictions remain in force. Historical evidence is never relabelled successful.
- `sync-window` keeps its discovery page open through acquisition and uses native
  browser `fetch` in a CDP isolated world in that same context/session. It does not
  export cookies or headers, change browser identity, attach to a page-controlled
  bridge, or fall back to Node. Standalone `downloadOne` retains its Node default.
- Media is a separate response owned by the transport, **not** the passive listing
  observer's response. One outstanding BYOB pull transfers at most 16 KiB of media
  bytes (a bounded numeric array over CDP), only when the file writer requests it.
  There is no whole-media buffer, string or base64 conversion. Explicit per-pull
  typed arrays, numeric serialization and Node buffers have constant-size bounds;
  Chromium's native fetch/network buffers, protocol implementation, parser, GC and
  page heap are **not** an enforceable whole-browser memory bound.
- Initial media URL and public-DNS validation still precede browser acquisition.
  Browser media redirects are rejected as `BROWSER_REDIRECT`: manual mode cannot
  expose a redirect target safely for hop validation. No redirect is followed and
  no alternate transport is tried. Chromium with native byte/BYOB readers is
  required; unsupported browser behavior fails closed.
- Browser media requests pass the same serialized accounting guard, counted once as downloads.
  Refusals, byte/time limits and aborts cancel the source and remove partial files;
  cleanup errors are non-success. A successful browser session does not authorize
  deleting refusal history or retrying a refused request within the same operation.
- Cancellation covers CDP attachment/setup as well as reads and EOF cleanup.
  After asynchronous file preparation and a fresh visible-refusal check, the
  writer checks its stop/deadline gate and publishes media plus receipt in a
  synchronous, non-yielding commit section. Pre-commit stops remove only this
  acquisition's temporary artifacts; earlier verified receipts remain intact.
  The retained page is sampled for visible challenges/access walls with at most
  one DOM read in flight, including while a media read is stalled. Actual page
  closure stops new samples; an admitted sample is drained and classified before
  accepting the handle or releasing the ledger. This drain is bounded by the job
  deadline and a one-second cleanup grace. Failed/unresolved sampling is non-success;
  a late result after that stop cannot mutate the released ledger. Files committed
  before a later refusal remain valid prior work. Media temporary files are created
  exclusively, and a failed creation never authorizes removing the foreign path.
- `COMPLETE` on a handle proves its acquisition and owned-page cleanup, not the
  later context/client cleanup for the whole job. A context cleanup failure makes
  the job `PARTIAL / BROWSER_CLEANUP`; its already-complete handles remain eligible
  for receipt-verified local composition. Composition does not certify that the
  original job released every browser resource.
- Window stability is keyed on the provider media locator fingerprint, falling
  back to the raw href when that locator is absent. If the provider ever stops
  emitting the media id, every render differs and no handle can stabilise; each
  would fail closed as `WINDOW_NOT_READY` for the full readiness wait. Fail-closed
  is intended, but the effect is fleet-wide rather than per-handle.
- A non-denial provider HTTP failure during discovery (for example 503 without Retry-After) latches
  `DISCOVERY_TRANSPORT`, which is a **global** stop reported as `PARTIAL`, not
  `BLOCKED`. Only real denials (401/403/407/451/429, challenge redirects, content
  walls), plus a 503 Retry-After service restriction, produce `BLOCKED`.

## Optional Immich export

FrameFerry still writes generic media files and receipts that a future adapter can import elsewhere. It has no Immich dependency and no uploader.

## Troubleshooting

Run `doctor`. If Playwright has no browser, run `npx playwright install chromium` or pass an existing `--browser-executable`. Captcha/human approval is `ACTION_REQUIRED`, not bypassed. Rerun partial sync with the same output path to retry failed downloads while retaining prior success.

## Rights and privacy

Archive only public content you have rights or permission to keep, and stay within InstaCognito's terms: https://instacognito.com/terms-and-conditions. This is not a commercial scraping platform and does not promise guaranteed completeness, no account risk, or unlimited use. The provider can change selectors, rate-limit, remove media, or return incomplete results. Carousels can produce more files than displayed post counts.

## Bounded discovery repair

See [bounded discovery and fingerprint identities](references/bounded-discovery.md) for retained UI slices, discovery-only canaries, validated CLI budgets, legacy aliases, crash recovery and explicit operational limits.

### Known-post coverage guard

A successful `sync-window` result means the returned visible window was processed,
not that the provider feed is current. A profile listing can omit a recent post
that its direct-link lookup returns. Private callers can supply up to 50
`expectedPosts` per handle, each with `shortcode`, `category: "posts"`,
`minDayHi` (calendar date), `source` (`owner-direct-observation` or
`verified-receipt`), and timezone-bearing `sourceObservedAt`. No source URLs,
credentials or account lists belong in the public repository.

For witnesses at or after the job cutoff, the current Posts window must contain
that shortcode with compatible selected date evidence. Missing or conflicting
witnesses yield `PARTIAL / FEED_COVERAGE_GAP` before that handle's downloads;
result composition revalidates the exact witness policy and observations too.
This guard does not add pagination, refresh upstream caches, or discover unknown
missing post IDs. It intentionally fails closed on a missing first-window witness.
A witness match is necessary evidence only, never full-feed or full-history proof.
