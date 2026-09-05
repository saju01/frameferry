# Changelog

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
