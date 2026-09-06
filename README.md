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

Manifest and status are mode 600. Receipts include ID, category, media type, identity basis, bytes, SHA-256, content type, source host, run ID, timestamps, `dateRaw`, `dateParsed`, the date provenance fields described under [Metadata caveats](#metadata-caveats), `captionTruncated`, and highlight grouping when exposed. They do not include ephemeral signed media URLs. Stable post media IDs stay `post-shortcode + carousel-index`, so URL rotation does not create duplicates for posts. Reels are category-qualified to avoid collisions. Stories and highlights have no stable shortcode in the public DOM, so later syncs re-fetch them and dedupe after hashing.

## Website contract

The scraper expects `input#search-input`, `button#download-btn`, `#post-container .post-card`, shortcode from descendant `[data-id]`, type from `[data-type]`, `.content-download-btn[href]` as HTTPS `instacognito.com/media?id=...`, date from the final meaningful `.post-footer` text, and a robust integer profile-header post count. Pagination scrolls the last rendered `.post-card` into view center and waits for unique IDs/card changes/loading state, not the page footer.

## Supported capability matrix

- **Posts**: implemented and regression-tested. Existing stable IDs stay `shortcode + carouselIndex`, so repeat syncs reuse verified receipts even when provider URLs rotate.
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
- `dateRaw` is always retained. `dateParsed` keeps its long-standing "best available text" meaning, so it is an ISO timestamp when the label parsed and an echo of the label when it did not.
- Because that is ambiguous, every item and receipt also carries explicit provenance: `dateStatus` (`resolved` or `unresolved`), `dateProvenance` (`provider-iso`, `provider-explicit-year`, `provider-unparsed-label`, `provider-relative-label`, `provider-yearless-label`, `caller-proven`, or `none`), `dateResolved` (an ISO timestamp, and authoritative only when `dateStatus` is `resolved`), and `dateEvidence`.
- A year is never inferred. A yearless label such as `23 August`, a relative one such as `2d ago`, a month-precision one such as `August 2024`, and one naming a day that never existed -- date-only (`2024-02-31`) or time-bearing (`2024-02-31T00:00:00Z`) -- all stay `unresolved` with the raw label preserved. A date resolves only when the text spells a complete, valid calendar date.
- Only a caller that can prove a per-item date may resolve one, by passing `dateProven` together with `dateEvidence`. Evidence is a closed vocabulary, not free text: `{ kind, note }` where `kind` is one of `provider-permalink`, `provider-listing`, `operator-attested`, or `external-record` (a bare kind string is also accepted). The optional `note` is stripped of every URL-shaped token, stripped of control characters, and length-capped before it is persisted, because it reaches the exported ZIP. An unproven, incomplete, or malformed claim raises `BAD_DATE_PROOF` rather than being quietly accepted.
- Provenance is never taken on trust. Every `provider-*` provenance is reproducible from `dateRaw`, so a stored record claiming one it cannot reproduce is refused and recomputed; a `caller-proven` record must carry well-formed allowlisted evidence and a complete timestamp. Forging a resolved date therefore means forging `dateRaw` too.
- `requireCaptureTimestamp(record)` fails closed with `DATE_UNRESOLVED` unless the record carries a genuinely resolved timestamp, so an unresolved date cannot leak into anything that needs a real capture instant.
- Resolution is day-precision and host-independent. `Date.parse` reads a zone-less label as local midnight while ISO output renders UTC, which on a host east of UTC turns `1 January 2019` into `2018-12-31T13:00Z` -- the wrong year. FrameFerry therefore pins the calendar fields the label actually spelled to UTC, so `dateResolved` is the date the provider displayed no matter where the archive ran. Text that names its own zone is honoured as written.
- Deleted, expired, private, CAPTCHA-blocked, or otherwise hidden stories cannot be recovered.

## Pending import dedup

`planPendingImport(entries, { known })` is a pure, advisory helper for callers that push an archive into another system. It groups byte-identical media by SHA-256 so identical bytes are registered once, and returns `staged`, `conflicts`, `errors`, and a `counts` block whose `references` always equals `stagedReferences + conflictedReferences + erroredReferences`.

- Every source reference is preserved in full. Dedup is not a lossy transform: each reference carries back every field the caller supplied, minus the signed provider URL (`href`), which never reaches persisted or reported JSON. Remaining strings are redacted for signed URLs.
- Each entry must state a valid `category`. An invalid or missing one is reported in `errors` with the offending value retained, never silently rewritten to `posts`.
- Stable IDs are validated as filenames: the safe charset, no bare `.`/`..`, no leading dash. Ids arriving through `known` clear the same guard before they can become a `canonicalStableId`.
- `entries` must be an array or other iterable; anything else raises `BAD_ARGS` rather than returning an empty plan that would read as "nothing to import". Array holes are reported as errors rather than skipped.
- `uniqueBytes` counts distinct byte sequences, `duplicateReferences` the references that share them, and `alreadyPresent`/`newUniqueBytes` split those against media the caller already holds. Passing `known` as a `stableId -> receipt` map (the manifest `completed` shape) works unchanged.
- The plan is deterministic, so re-running it over a differently ordered batch after a partial import will not re-register bytes the previous run already deduped.
- A stable ID claiming two different byte sequences, whether inside the batch or against already-imported media, is a conflict: it is reported and held, never staged and never overwritten. Malformed entries are returned in `errors` with the offending reference attached rather than dropped.
- It performs no I/O and is not a staging layout. The on-disk archive stays one media file and one receipt per stable ID.

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

## Optional Immich export

FrameFerry still writes generic media files and receipts that a future adapter can import elsewhere. It has no Immich dependency and no uploader.

## Troubleshooting

Run `doctor`. If Playwright has no browser, run `npx playwright install chromium` or pass an existing `--browser-executable`. Captcha/human approval is `ACTION_REQUIRED`, not bypassed. Rerun partial sync with the same output path to retry failed downloads while retaining prior success.

## Rights and privacy

Archive only public content you have rights or permission to keep, and stay within InstaCognito's terms: https://instacognito.com/terms-and-conditions. This is not a commercial scraping platform and does not promise guaranteed completeness, no account risk, or unlimited use. The provider can change selectors, rate-limit, remove media, or return incomplete results. Carousels can produce more files than displayed post counts.
