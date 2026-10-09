# 9UI-183 bounded cohort: common upstream stopped before the three arms

Observed 2026-10-09 22:14 UTC. This is one new Run from merged main `a9abf7427cfb9044ccf01da3a756a181be82e091`, using the same captured monitor page, source corpus, model, and dispatch settings for all planned arms. It does **not** compare their design output: S07 stopped before S08, so B0, C1, and C2 were never invoked. The saved Run remains active with the original S07 work and submission marker intact.

The [frozen input summary](bounded-cohort-inputs.json), [machine report](bounded-cohort-report.json), and [attempt and reconciliation record](bounded-cohort-attempts.json) preserve the cohort ID, source and evidence hashes, exact accepted refs, timing, session config and schema hashes, stops, and marker digest. The complete local originals remain under `/private/tmp/mimic-9ui183-final-OHyWQe`. The JSON files contain no model prompt, credential, or copied source slide.

## Common upstream cost and stop

| Task | Model attempts used / limit | Result                                                                     | Recorded attempt time |
| ---- | --------------------------: | -------------------------------------------------------------------------- | --------------------: |
| S04  |                       1 / 2 | accepted, 3 exact refs                                                     |             32,599 ms |
| S01  |                       1 / 2 | accepted, 1 exact ref                                                      |             39,851 ms |
| S02  |                       1 / 2 | accepted, 1 exact ref                                                      |             42,147 ms |
| S05  |                       1 / 2 | accepted, 1 exact ref                                                      |             60,178 ms |
| S07  |                       2 / 2 | first timed out while executing; second stopped `prepared/unknown-outcome` |  120,295 + 118,712 ms |
| S08  |                       0 / 2 | blocked by S07; not invoked                                                |                     — |

The six model attempts total **413,782 ms** of recorded wall time. This excludes preparation, inspection, and the static reconciliation call; it is not a time-to-reviewable-design measurement. The report verifies one-to-one session logs and frozen dispatch settings (`gpt-6.1-sol`, medium effort, one generation, 120-second timeout) for these attempts. Four common tasks were accepted; there is no S07 Core acceptance event. S07-a has no saved work or marker. S07-b has saved work and an immutable submission marker. After read-only inspection, one normal `resume` of **that same saved work** returned `reservation-invalid` with no acceptance. No output, marker, or prior Run was edited, and no third S07 candidate was generated.

## Same-stage arm comparison

| Arm | Frozen S09/S11 input                                                                                         | S09 / S10 / S11 attempts used | Actual result                       |
| --- | ------------------------------------------------------------------------------------------------------------ | ----------------------------: | ----------------------------------- |
| B0  | 89,849-byte flat case catalogue with unranked raw graph and source ledger                                    |      0 / 0 / 0 (limit 2 each) | blocked before S09; no model output |
| C1  | 23,438-byte task-conditioned graph projection and source evidence                                            |      0 / 0 / 0 (limit 2 each) | blocked before S09; no model output |
| C2  | 90,665-byte raw graph with mechanisms foregrounded at S09; 5,035-byte counterexample evidence staged for S11 |      0 / 0 / 0 (limit 2 each) | blocked before S09; no model output |

The host projection for C1 completed during preparation and selected SmartHR table as near and GitHub run, GOV details, and teamLab object as adjacent. This demonstrates only that the frozen retrieval input was produced; **no S09 Skill used or evaluated it**. The evidence sizes and contents show that the three treatments are prepared differently, not which one yields a better, faster, or more acceptable design. All arm-specific model time is zero because all arms are unrun; the shared upstream cost cannot be attributed to one arm.

The 9UI-178 [accepted design cycle](../9ui178/design-cycle.md) still demonstrates a separate S09–S11 route and a Chrome-operated comparison screen. It is not a matched control for this cohort, evidence of user satisfaction, or evidence that B0 is stable. An exact three-arm result requires resolving the S07 reservation stop and then a new authorized Run with the same explicit limits and frozen inputs. This record does not approve a direction or bypass a human decision.
