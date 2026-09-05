# Contributing to FrameFerry

Thanks for helping! Saju (@saju01) maintains this MIT-licensed project.

## Before you start

- Open an issue before substantial features, new providers or new dependencies.
- Small bug fixes, tests and documentation improvements can go straight to a PR.
- Keep PRs focused. Explain the problem, change and evidence; do not rewrite Git
  history on shared branches or submit unrelated formatting changes.
- Respect provider terms, copyrights and privacy. We do not accept login/private
  account circumvention, CAPTCHA bypass, proxy rotation, signature reversal,
  credential collection or claims of unlimited/guaranteed-complete downloads.

## Development

Fork the repository, create a feature branch, then:

~~~sh
npm ci --ignore-scripts
npx playwright install chromium
npm test
npm pack --dry-run
~~~

The package supports Node >=20. The prepared CI matrix targets Node 20, 22 and
24 with Chromium; hosted CI is not installed yet. Include local test evidence
until the maintainer publishes and requires the workflow.
Tests must use synthetic, offline fixtures: no real Instagram profiles or live
provider requests. Add a regression test for behavior changes, especially
pagination, carousel identities, partial outcomes, retries and file safety.
On supported Linux hosts, use the isolated runner too:

~~~sh
npm run test:sandbox
~~~

Browser selection can be explicit through PLAYWRIGHT_CHROMIUM_EXECUTABLE for
fixtures. Never reuse a personal authenticated browser for automated tests.

## Safe evidence

Do not commit downloaded media, real profile metadata, credentials, cookies,
signed URLs, browser profiles, .env files or raw private logs. Provide synthetic
reproductions and sanitized command shapes/output. Report vulnerabilities through
[private reporting](https://github.com/saju01/frameferry/security/advisories/new),
not public issues. See [SECURITY.md](SECURITY.md).

## Review and merging

- Open a PR into main. Describe tests run and any tests not run.
- Maintainer/code-owner approval and resolved review conversations are required
  for ordinary contributions. New commits dismiss stale approvals. Once the CI
  workflow is installed and its check required, it must pass too; do not claim
  a missing check is green.
- External-contributor workflow runs require maintainer approval before execution.
- We squash-merge accepted PRs. No automatic merging or branch deletion is enabled.
- Saju retains GitHub's admin override for owner-authored PRs (GitHub does not
  allow self-approval) or recovery. Passing tests and review evidence should still
  accompany such merges; bypass is not the normal contribution path.
- AI-assisted contributions are welcome: disclose relevant assistance, check the
  result yourself, and take responsibility for correctness, security and provenance.

## Licensing and conduct

By contributing, you offer your contribution under the project's MIT license.
Do not submit code or media you lack the right to share. No separate CLA or DCO
is required. The MIT license covers code, not third-party downloaded content.
Be respectful; see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Review and release
cadence is best-effort; opening an issue does not guarantee implementation.
