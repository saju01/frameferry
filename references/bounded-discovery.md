# Bounded discovery and fingerprint identities

This candidate changes new media IDs, not existing canonical filenames. It does not deploy
or migrate an archive automatically. A software test pass is not a full-backfill claim.

## Identity and compatibility

New post-backed IDs are category + '__' + SHA256(JSON.stringify([category, rawPostId,
providerMediaFingerprint])). The fingerprint is SHA-256 of the supported provider's
/media?id=<decoded id> identity, not rotating query parameters. Only absolute HTTPS
instacognito.com /media URLs with one nonempty bounded id and no credentials, fragment or
nondefault port qualify. Foreign/malformed URLs never become identities. No timestamp is
decoded from a post ID and no year is inferred from display order.

Identity is independent of partial windows, encounter order, caption and date. CarouselIndex
and displayOrder are metadata. The latest locator stays in memory; locatorObservedAt and
metadataProvenance are separate. Pending and failed records retain the fingerprint.

A legacy alias requires matching handle/category/post/fingerprint; completed evidence also
requires byte verification. Its ledger records the canonical ID and proof. Old filenames and
receipt files are not renamed or rewritten. A persisted outstanding fingerprint can bind its
own old receipt key. An index-only record cannot: ambiguous observations stay held without
acquisition. Prior conflicts never auto-clear. A conflicting transfer reports its hash,
length, fingerprint and provenance, preserving verified canonical bytes. No quarantine bytes.

## Supported session and CLI options

One invocation owns one profile lock and one browser/page from search through acquisition.
Discovery slices retain that same page; they do not search again. Changed media batches are
fsynced to the discovery journal before another trigger or acquisition. The request guard is
installed before navigation and caps forwarded provider content API requests at --max-pages,
including initial search, automatic requests and locator replay. Profile requests are counted
separately. The section controller is also page bounded. No private cursor, signed request
reconstruction or provider response-body scraping is used.

New options (numeric values must be bounded integers):
- --discovery-max-time-ms: discovery subbudget; default half global time, at most global.
- --acquisition-max-time-ms: acquisition subbudget, including 0; cannot extend global time.
- --slice-pages: retained-page discovery slice size, default 12.
- --slice-time-ms: discovery slice ceiling, default min(180000, global budget).
- --checkpoint-every-items: acquisition checkpoint cadence, default 25.
- --max-acquire-items: attempted transfers per invocation, default 100000.
- --max-acquire-bytes: newly written bytes per invocation, default 512 MiB.
- --max-locator-age-ms: maximum accepted locator age, default 300000.
- --max-observed-media: identity ceiling, default/hard maximum 100000.
- --discovery-only: no acquisition/export. Writes only the supplied output's discovery
  journal, owner and status. Always PARTIAL because acquisition is not proved.
- --target-ids: comma-separated stable fingerprint IDs. Legacy IDs require positive alias
  evidence in that output's prior state.
- --target-posts: comma-separated raw observed post IDs. Discovery-only can stop when these
  and any media targets are observed. Post rediscovery is NOT legacy slide-mapping proof.

Global --max-time-ms hard maximum: 2 hours. --max-pages hard maximum: 1000. Time checks combine
wall and monotonic elapsed so clock rollback cannot extend global budgets. Acquisition and
final verification use remaining global time. Owner/runtime records include effective options,
source hashes, git commit when available, Node/Playwright/browser version and resource observations.

## Read-only-to-canonical canary

Parent independently reviews the exact commit and holds the existing production-wide flock
before live UI traffic. The profile-local output lock is not a replacement. Run within the
parent's approved 1 GiB process-group cap and external wall timeout. The following is an actual
CLI contract, NOT permission to launch it during source repair:

    node bin/frameferry.js archive <handle> --output ./reports/canary-candidate --mode full --categories posts --discovery-only --max-pages 30 --max-time-ms 360000 --discovery-max-time-ms 340000 --acquisition-max-time-ms 0 --slice-pages 5 --slice-time-ms 60000 --browser-executable /usr/bin/chromium --json

Use a new isolated output, never the canonical cache. Add --target-posts with the parent's
independently read known-pending post, or --target-ids with its positively bound fingerprint
ID. The journal can also be checked after the bounded pass without an early-exit target.
Normal UI previews are browser traffic: discovery-only is NOT zero-media-network traffic.
It means no archive media fetch, saved media, upload or canonical write. Exit 1/PARTIAL is
expected; inspect typed stop cause and target matches, not exit text alone. No denial retries.

## Full-history session (parent-owned, after review/canary)

Replace the output placeholder with the explicitly approved existing backfill root. Preserve
holds and the production-wide lock, memory cap and external wall timeout:

    node bin/frameferry.js archive <handle> --output /path/to/approved-backfill-root --mode full --categories posts --max-pages 140 --max-time-ms 1800000 --discovery-max-time-ms 1200000 --acquisition-max-time-ms 600000 --slice-pages 30 --slice-time-ms 180000 --max-acquire-items 50 --max-acquire-bytes 536870912 --max-bytes 52428800 --checkpoint-every-items 5 --max-locator-age-ms 300000 --browser-executable /usr/bin/chromium --json

These are ceilings, not a promise the frontier fits. A retained discovery session traverses
past page20 across slices (30-page real DOM regression). Acquisition begins after discovery,
while the owned page remains open. If queued locators become stale, one bounded ordinary-UI
replay refreshes matching in-memory identities. Replay shares remaining session requests and
acquisition/global time; it is not an unlimited retry queue. Unrefreshed targets remain pending.

## Recovery and reporting

The append-only journal is fsynced, capped at 64 MiB and contains no locators. A torn final
line after process kill is truncated to the last committed record. Corrupt committed records,
foreign handles and broken sequences fail closed. Browser state is not durable. A new process
searches from the top only if declared page/time ceilings can extend the saved high-water
frontier (saved pages + 1 and measured time + 2 seconds). Otherwise REPLAY_BUDGET reports
required bounds before navigation. Short replays never lower the high-water mark. This is a
measured feasibility lower bound, not a promise of future provider speed. No automatic identical
rescheduling is supplied.

Killed acquisition retains queued work and committed receipts. A new exclusive owner adopts
only positively bound, byte-verified receipt files. Dead owners read INTERRUPTED, not RUNNING.
Stale .part files are not media proof and are not adopted; their retirement is separate cleanup.

New scan fields are raw/run-local. observedCumulativePostCount includes prior outcomes;
acquiredPostCount is receipt-recorded; acquisition.run* differs from cumulative pending,
failed and conflicts. Existing uniquePostCount/pendingCount fields are compatibility fields,
not scan-local claims. New runs have schemaVersion 3/countScope=run; historical records retain
historical semantics.

## Honest limitations and holds

- Only explicit existing provider no-content UI is terminal evidence. No trigger, unchanged
  HTTP200, missing render, page/request cap, pending response and deadline are PARTIAL.
  A provider without a positive terminal state may never qualify for UI COMPLETE. Do not waive it.
- Generation capture is bounded at 64 batches/4096 cards. Overflow or in-place media identity
  mutation that cannot be reconstructed is OBSERVATION_GAP, never silent complete retention.
- Highlights retain the existing visible-group extractor, not a proven deep-history traversal.
  The supported full-history invocation above is posts. Other categories have isolated target
  and readiness gates; no cross-category completeness inference is made.
- Legacy index-only ambiguity, date-review holds, existing conflicts, inaccessible/missing
  history and deleted/expired stories require separate evidence. None are cleared here.
- No uploads, server reconciliation, incremental release, schedules, daily vendor pin upgrade,
  quarantine-byte retention or canonical migration are performed by this repair.

## Offline verification

Run TMPDIR=<workspace report scratch> ./scripts/test-sandbox.sh. The script refuses a missing
cgroup scope, checks MemoryMax=1073741824 and MemorySwapMax=0, and prints cgroup/peak/network
namespace proof. Tests use a copied public synthetic tree under bwrap --unshare-all, no network,
cleared HOME/environment and dropped capabilities. Required browser tests have no skips in
candidate evidence. No real HOME/cache/library/provider session/canonical data is mounted.

## Opt-in quarantine byte evidence (Sep7 follow-up; separate review required)

Live evidence disproved cross-run stability of the provider's opaque media id: 28 of
50 reacquired, scoped byte-identical canonical references had a different saved fingerprint.
The fingerprint remains an observation/locator key. Different keys do not prove different
media; this patch does not retroactively redefine existing journal counts or discard them.

Archive accepts --byte-evidence-root <separate-finished-quarantine-output>. Before opening
any provider page, it verifies that output's terminal owner, bounded manifest and immutable
receipts, exact handle/category/post/fingerprint IDs, and SHA256/length of both quarantine
and canonical media. Limits are 5000 references, 512 MiB total evidence, 50 MiB per item,
16 MiB manifest, 1 MiB receipt/owner, remaining global wall budget; symlinks/overlapping
roots are refused. A unique exact scoped byte match creates an explicit alias in the
archive manifest with the evidence-manifest hash and source run. Canonical media and
receipt filenames/bytes/metadata remain unchanged. The flag must be supplied again for
reuse; stored alias assertions alone are not trusted. Unsupported/changed fingerprints
without byte proof, multiple byte-identical canonical candidates, index-only owed IDs,
existing conflicts and unknown dates remain held. No acquisition or canonical migration
is performed by loading evidence. Both the source and uploader still require the existing
parent-owned production flock.

This does NOT solve the measured no-trigger traversal stop, derive legacy pending slide
order, establish full-history completeness, or prove Immich presence. The baseline
review does not approve this follow-up. Do not use it live until separate exact-diff review.

## Category readiness follow-up (17:47 canary)

The reviewed byte-evidence helper live-verified 50 aliases, but the subsequent target
canary ended at initial category readiness after roughly eight seconds with no cards.
That path previously omitted transport evidence, so the live request state is unknown:
we do NOT claim proven latency or source exhaustion for that specific run. A real-DOM
regression independently reproduced the defect: an 8.5-second pending response was
abandoned by the fixed 8-second readiness ceiling despite remaining global budget.

Readiness now observes the same pending response without reissuing search/tab/scroll,
clamped by the original global discovery deadline, with at most 8 seconds of post-settle
render grace. It does not accept stale no-content or cards while transport is pending.
Denial/challenge stops immediately. A pending deadline exits PARTIAL/awaiting-response;
all category-readiness outcomes carry sanitized transport counts. This does not change
request caps, dates, byte mappings, canonical data or completion gates, and does not by
itself resolve the separate later no-trigger traversal stop. Separate exact-diff review
is required before this follow-up is used live.
