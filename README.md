# InstaCognito Archive Skill

A small public OpenClaw skill plus Node CLI for archiving public Instagram media through https://instacognito.com/en/photo with bounded scans, durable receipts, and honest status reporting.

This is conservative: no login, cookies, paid APIs, reverse-engineered signatures, proxy rotation, paywall bypass, or false unlimited claims. Use it for personal or explicitly authorized archives of public profiles only. InstaCognito publicly advertises free public-profile viewing/download with no login at `https://instacognito.com/en/photo`; its terms at `https://instacognito.com/terms-and-conditions` prohibit commercial-scale scraping/archiving without authorization, copyright infringement, privacy abuse, private-access circumvention, and overburdening the service.

## Install from GitHub

```bash
git clone https://github.com/saju01/instacognito-archive-skill.git
cd instacognito-archive-skill
npm ci
# Browser setup is explicit; this package does not auto-install a service or schedule.
npx playwright install chromium
npm link   # optional
```

Node >=20 is needed. Playwright is locked to 1.63.0.

## CLI

```bash
instacognito-archive doctor
instacognito-archive archive <handle> --mode full --output <path>
instacognito-archive archive <handle> --mode sync --output <path> --max-pages 6
instacognito-archive status <handle> --output <path>
```

Options: `--max-pages`, `--max-time-ms`, `--max-bytes`, `--delay-ms`, `--browser-executable`, `--browser-channel`, `--attach-cdp http://127.0.0.1:<port>`, `--json`. CDP attach is loopback only; attached browsers are not closed wholesale.

## Output

```text
<output>/media/<handle>/<stable-id>.<ext>
<output>/receipts/<handle>/<stable-id>.json
<output>/.instacognito/<handle>/manifest.json
<output>/.instacognito/<handle>/status.json
<output>/.instacognito/<handle>/lock.json
```

Manifest and status are mode 600. Receipts include stable IDs, bytes, SHA-256, content type, source host, run ID, and timestamps. They do not include ephemeral signed media URLs. Stable media IDs are `post-shortcode + carousel-index`, so URL rotation does not create duplicates.

## Website contract

The scraper expects `input#search-input`, `button#download-btn`, `#post-container .post-card`, shortcode from descendant `[data-id]`, type from `[data-type]`, `.content-download-btn[href]` as HTTPS `instacognito.com/media?id=...`, date from the final meaningful `.post-footer` text, and a robust integer profile-header post count. Pagination scrolls the last rendered `.post-card` into view center and waits for unique IDs/card changes/loading state, not the page footer.

## Status model

`COMPLETE` exits 0. `PARTIAL`, `DEFERRED`, and `ACTION_REQUIRED` exit non-zero and preserve checkpoints. Unknown totals never become complete. `DEFERRED` honors the full provider `Retry-After`; wait until `retryAt`.

## Owner-opt-in periodic sync

No schedules are installed. If you want daily sync, add your own scheduler with an exact fixed-path command, for example:

```bash
instacognito-archive archive example_handle --mode sync --output /archives/instagram/example_handle --max-pages 6 --max-time-ms 600000
```

No secrets are needed; do not put secrets on command lines.

## Optional Immich export

v0.1 writes generic media files and receipts that a future adapter can import elsewhere. It has no Immich dependency and no uploader.

## Troubleshooting

Run `doctor`. If Playwright has no browser, run `npx playwright install chromium` or pass an existing `--browser-executable`. Captcha/human approval is `ACTION_REQUIRED`, not bypassed. Rerun partial sync with the same output path to retry failed downloads while retaining prior success.

## Rights and privacy

Archive only public content you have rights or permission to keep, and stay within InstaCognito's terms: https://instacognito.com/terms-and-conditions. This is not a commercial scraping platform and does not promise guaranteed completeness, no account risk, or unlimited use. The provider can change selectors, rate-limit, remove media, or return incomplete results. Carousels can produce more files than displayed post counts.
