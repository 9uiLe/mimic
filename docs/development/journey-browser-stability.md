# Journey browser test stability (9UI-155)

This note records a test-only repair for the replacement return journey. The
source baseline is `a307bef1c88c37034bbdba019064a52dc7f55e6a` on
`ai/9UI-155-journey-browser-stability`. No journey runtime, gate, fixture,
schema, timeout, retry, or CI setting changed.

## Failure and diagnosis

[PR #54 exact head `3b73716e2e44ae53bc8edb1f6b8089c1e0139a25`](https://github.com/9uiLe/mimic/pull/54)
failed the [extended Ubuntu 24.04 matrix job](https://github.com/9uiLe/mimic/actions/runs/37618890712/job/112783860170).
The runner used two Playwright workers. Firefox desktop and WebKit mobile both
exceeded the original 120-second cap in the single replacement test at line 161.
Firefox reached its last assertion with `journey-actions` states
`[FAIL, UNVERIFIED]` instead of `[FAIL, FAIL]`; the WebKit mobile phase was
not logged. The job did not expose the second Firefox finding's reason or
evidence, so its exact interruption cannot be identified from that run.

The gate's `journey-browser.ts` implementation classifies a finding as
`UNVERIFIED` if its errors include `Browser observation unavailable` or an
`unverified:` prefix. The reported Firefox state is consistent with an
interrupted observation, but that inference does not establish which browser
operation failed. It is not evidence that the sabotaged mobile control worked.
The negative test must still demand two named action `FAIL` findings.

The original test performed two direct two-width journeys, one full normal
two-width gate, and one full sabotaged two-width gate under one 120-second cap.
Each gate independently creates its own page and context and checks both widths;
the direct journey does not supply state to either gate. Splitting these three
checks gives each independent sweep its existing 120-second budget without
breaking same-session continuity within the direct journey or within each gate.

## Bounded change and observability

The direct test still performs both startup widths, both resize directions, the
draft and filter checks, focus restoration, and page-error assertion. It logs
monotonic phase totals and deltas for setup, build, server startup, each width,
and cleanup, plus page and console errors. It closes its test page and context,
then its HTTP server, then its temporary fixture. The server calls
`closeAllConnections` after initiating `close`, so an active test-owned
response cannot leave the cleanup waiting indefinitely. Cleanup proceeds after
individual errors and does not replace an earlier assertion failure.

The normal gate still requires `PASS` for all six named criteria at 1280 and
390 pixels. The sabotage gate still requires `journey-actions` to be exactly
`[FAIL, FAIL]` and both original named control reasons. Each gate logs start
and completion times and all 12 finding states; non-PASS findings include their
full reason and evidence. A missing completion log after `gate start` places a
timeout inside the gate call. The gate itself is read-only for this issue, so
this test cannot identify a finer internal step if it hangs there.

## Local verification

Pinned Node 24.21.0 and pnpm 12.9.1 were used. Focused journey and quality-gate
unit tests passed 39/39, and TypeScript typecheck passed. With two workers and
`--repeat-each=2`, focused Chromium desktop/mobile passed 12/12 in 1.4 minutes.
The normal gate returned all 12 `PASS` findings in every run, taking about
18–20 seconds; the sabotaged gate returned two action `FAIL` findings in every
run, taking about 17–18 seconds.

The same repeated focused check on macOS WebKit mobile passed 6/6 in 1.2 minutes.
The two normal gates took about 31 seconds and two sabotaged gates about 33
seconds. The desktop sabotage reason named `second-show-error`; mobile named
both `second-show-error` and `return-mobile`. The sabotaged mobile continuity
`FAIL` and keyboard `UNVERIFIED` retain their existing distinct meanings.

Local Firefox desktop did not reach test setup: `browserType.launch` timed out
after 180 seconds, and Firefox logged
`sandbox_extension_issue_file_to_process failed ... plugin-container.app: 1
(Operation not permitted)`. The attempt was stopped after this launch failure;
it is not a journey test failure. The hosted Ubuntu Firefox result is required
for that browser.

The repository's canonical `pnpm check` passed after the final test edit:
format, lint, typecheck, schema and YAML validation, builds, CI script tests,
docs checks, DCO tests, and 382 unit tests across 36 files. The first canonical
attempt identified `no-unsafe-finally` in test cleanup; cleanup errors now
surface after `finally`, preserving the original failure, and the complete
check passed on rerun.

The original hosted failure and local macOS results are separate observations.
The replacement test's exact hosted PR head and full CI results are recorded on
[9UI-155](https://linear.app/9uile/issue/9UI-155) after publication.
