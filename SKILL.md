---
name: instacognito-archive
description: Archive public Instagram media through InstaCognito with bounded full and incremental sync runs, durable manifests, receipt verification, and honest COMPLETE/PARTIAL/DEFERRED/ACTION_REQUIRED outcomes.
license: MIT
homepage: https://github.com/saju01/instacognito-archive-skill
---

# InstaCognito Archive

Use this skill when the user wants a standalone free archive or periodic sync of public Instagram media through InstaCognito without logins, cookies, paid APIs, proxy rotation, signature reversal, or anti-bot bypass.

## Full archive branch

1. Confirm the target is public content the owner is allowed to archive and choose a dedicated output directory. Completion: handle passes the normal Instagram handle check and the output path is not a symlink or traversal target.
2. Run a bounded full pass:

   ```bash
   instacognito-archive archive example_handle --mode full --output /path/to/archive/example_handle
   ```

   Optional bounds: `--max-pages`, `--max-time-ms`, `--max-bytes`, `--delay-ms`, `--browser-channel`, `--browser-executable`, or `--attach-cdp http://127.0.0.1:9222`. Completion: the command exits 0 only for `COMPLETE`; `PARTIAL`, `DEFERRED`, and `ACTION_REQUIRED` exit non-zero and preserve state.
3. Verify receipts before using files:

   ```bash
   instacognito-archive status example_handle --output /path/to/archive/example_handle
   ```

   Completion: status shows immutable completed receipts with stable media identities, byte lengths, SHA-256 hashes, and no signed media URLs.

## Incremental sync branch

1. Reuse the same output directory so the manifest overlaps previously-seen stable identities and retries failed downloads.
2. Run sync with overlap, not a date-only watermark:

   ```bash
   instacognito-archive archive example_handle --mode sync --output /path/to/archive/example_handle --max-pages 6
   ```

   Completion: prior successful receipts are retained, failed receipts are retried, and new carousel items are keyed by `postShortcode + carouselIndex` so signed URL rotation does not create duplicates.
3. For owner-opt-in periodic use, schedule the exact command yourself and write output to a fixed profile path. This skill does not install cron, services, launch agents, or secrets.

## Outcome rules

- `COMPLETE`: InstaCognito reported a parseable total and the scan reached at least that many unique post shortcodes, with all selected downloads verified.
- `PARTIAL`: bounded progress but page/time/byte/no-growth limits or advertised shortfall prevented completion.
- `DEFERRED`: the provider returned `429` and the full `Retry-After` exceeds the remaining run budget; retry after `retryAt`.
- `ACTION_REQUIRED`: captcha, human approval, blocked browser, malformed provider page, unsafe redirect, or unknown reported total prevents an honest completion claim.

## Verification

Run `instacognito-archive doctor`, then `instacognito-archive status <handle> --output <path>`. Repository verification before publishing: `npm ci && npm test && npm run test:sandbox`.
