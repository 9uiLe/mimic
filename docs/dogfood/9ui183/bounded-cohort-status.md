# 9UI-183 bounded cohort: common upstream stopped before the three arms

Observed 2026-10-09 22:20 UTC. This is one new Run from merged main `a9abf7427cfb9044ccf01da3a756a181be82e091`, using the same captured monitor page, source corpus, model, and dispatch settings for all planned arms. It does **not** compare their design output: S07 stopped before S08, so B0, C1, and C2 were never invoked. The original S07 work and submission marker remain intact; the session checkpoint is stopped.

The [frozen input summary](bounded-cohort-inputs.json), [frozen input files](frozen-inputs/), [machine report](bounded-cohort-report.json), and [attempt and reconciliation record](bounded-cohort-attempts.json) preserve the cohort ID, exact source and evidence content, accepted refs, timing, session config and schema hashes, stops, and marker digest. The original Run remains on the task host. A restricted archive of its Core state, prepared work, and submission marker was also preserved outside temporary storage (SHA-256 `029fb3ea268ae3f0f1f70c0a2ba1951388b10a0e206db966daa38b50d93e4ef5`, mode 0600). Access to that archive is limited to the task host; it is not a public reproducibility artifact. Authorization receipts and the host authorization helper are excluded. The committed files contain no model prompt, credential, or copied source slide.

## Common upstream cost and stop

| Task | Model attempts used / limit | Result                                                                     | Recorded attempt time |
| ---- | --------------------------: | -------------------------------------------------------------------------- | --------------------: |
| S04  |                       1 / 2 | accepted, 3 exact refs                                                     |             32,599 ms |
| S01  |                       1 / 2 | accepted, 1 exact ref                                                      |             39,851 ms |
| S02  |                       1 / 2 | accepted, 1 exact ref                                                      |             42,147 ms |
| S05  |                       1 / 2 | accepted, 1 exact ref                                                      |             60,178 ms |
| S07  |                       2 / 2 | first timed out while executing; second stopped `prepared/unknown-outcome` |  120,295 + 118,712 ms |
| S08  |                       0 / 2 | blocked by S07; not invoked                                                |                     — |

The six model attempts total **413,782 ms** of recorded wall time. This excludes preparation, inspection, and the attempted CLI resume; it is not a time-to-reviewable-design measurement. The report verifies one-to-one session logs and frozen dispatch settings (`gpt-6.1-sol`, medium effort, one generation, 120-second timeout) for these attempts. Four common tasks were accepted; there is no S07 Core acceptance event. S07-a has no saved work or marker. S07-b has saved work and an immutable submission marker. After read-only inspection, a `session-main resume` with the same config returned `reservation-invalid`. Code inspection shows this invocation lacked the checkpoint's `authorized-existing-credit-risk-once` dispatch, so the execution-policy check stopped it **before replaying the saved work or calling static submit**. It then persisted `reservation-invalid` as a terminal stop. This does not establish whether the candidate would have been accepted. No output, marker, or prior Run was edited, and no third S07 candidate was generated. Recovering this exact checkpoint needs a reviewed authorized-resume path; changing the marker or checkpoint to bypass the stop is not a valid comparison.

## Same-stage arm comparison

| Arm | Frozen S09/S11 input                                                                                         | S09 / S10 / S11 attempts used | Actual result                       |
| --- | ------------------------------------------------------------------------------------------------------------ | ----------------------------: | ----------------------------------- |
| B0  | 89,849-byte flat case catalogue with unranked raw graph and source ledger                                    |      0 / 0 / 0 (limit 2 each) | blocked before S09; no model output |
| C1  | 23,438-byte task-conditioned graph projection and source evidence                                            |      0 / 0 / 0 (limit 2 each) | blocked before S09; no model output |
| C2  | 90,665-byte raw graph with mechanisms foregrounded at S09; 5,035-byte counterexample evidence staged for S11 |      0 / 0 / 0 (limit 2 each) | blocked before S09; no model output |

The host projection for C1 completed during preparation and selected SmartHR table as near and GitHub run, GOV details, and teamLab object as adjacent. This demonstrates only that the frozen retrieval input was produced; **no S09 Skill used or evaluated it**. The evidence sizes and contents show that the three treatments are prepared differently, not which one yields a better, faster, or more acceptable design. All arm-specific model time is zero because all arms are unrun; the shared upstream cost cannot be attributed to one arm.

The 9UI-178 [accepted design cycle](../9ui178/design-cycle.md) still demonstrates a separate S09–S11 route and a Chrome-operated comparison screen. It is not a matched control for this cohort, evidence of user satisfaction, or evidence that B0 is stable. An exact three-arm result requires a supported reconciliation path for S07 ([9UI-186](https://linear.app/9uile/issue/9UI-186/認可済み-session-の保存候補を安全に再開できるようにする)) or a new authorized Run with the same explicit limits and frozen inputs. This record does not approve a direction or bypass a human decision.
