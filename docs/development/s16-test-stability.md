# S16–S18 integration test stability (9UI-141)

## Reproduction and environment

At baseline commit `925c033dc1af3a653e6eb502703648c409b9a2be`, the unchanged S16–S18 test had intermittent five-second timeouts in unrelated full-suite runs. The local reproduction used macOS Darwin 27.0.0 arm64 on a 10-CPU machine, Node 24.21.0, pnpm 12.9.1, and `pnpm install --frozen-lockfile --offline` (318 cached packages, no lockfile change). Vitest 4.1.9 found 25 test files and 247 tests before the fix. The repository does not set `maxWorkers`; this Vitest version uses `availableParallelism() - 1` for a non-watch run, so the local default was nine workers. The targeted command ran one file; the full command used that default. No external load generator was added while other development work was active.

| Baseline run                         | S16 productive test | S18 productive test | Result         |
| ------------------------------------ | ------------------: | ------------------: | -------------- |
| First targeted, after frozen install |            1,736 ms |            1,711 ms | 8/8 passed     |
| First full, same unchanged commit    |    5,037 ms timeout |    5,028 ms timeout | 245/247 passed |
| Instrumented targeted, warm          |            1,811 ms |            1,709 ms | 8/8 passed     |
| Instrumented full, warm              |            4,623 ms |            1,933 ms | 247/247 passed |

These are bounded samples, not a statistical flake rate. “Cold” means the first local run after the worktree's frozen install; the machine's OS cache was not cleared. The full suite supplies realistic concurrent file workers, while targeted runs do not. The first full failure and later full success at the same baseline commit reproduce the reported sensitivity to contention.

## Phase evidence and diagnosis

Temporary `performance.now()` probes in this test measured setup (temporary root, schema directory, Skill package), `boundInputs` (seed Run, fixture sources, proposal, human decisions, commit, quality Run), `runSkillPackage`, output assertions, and cleanup. Probes were removed from the final patch. For the seven S16 productive scenarios in the instrumented full run:

| Phase                                      | Sum across scenarios | Largest one |
| ------------------------------------------ | -------------------: | ----------: |
| Setup and input binding together           |             3,266 ms |      554 ms |
| `runSkillPackage` with real file workspace |             1,162 ms |      197 ms |
| Output read and assertions                 |                69 ms |       19 ms |
| Total per-scenario work                    |             4,497 ms |      758 ms |

Eight setup calls (one declaration check and seven scenarios) took 623 ms in total, including 379 ms for repeated schema loads and 210 ms for repeated Skill loads. The seven input bindings took 2,745 ms: source creation 1,018 ms, human decisions 530 ms, Run start/snapshot 432 ms, proposal 272 ms, commit 261 ms, seed start 232 ms (rounded). S16 cleanup of eight roots took 12 ms. Each operation completed; the measured cost is repeated independent integration setup and real file I/O, amplified by parallel suite load. No single `runSkillPackage` call or cleanup phase approached five seconds. The data do not establish a runtime deadlock or a CLI cleanup cause.

The old S16 and S18 cases each placed all productive scenarios into one Vitest case. The 5,000 ms watchdog covered the sum, so normal per-scenario costs could cross it under contention. Vitest can mark an async test timed out while its callback is still running; the previous shared `afterEach` root list could then race with later work. A separate CLI `rmSync` directory failure was observed elsewhere and is not attributed to S16 here.

## Fix and coverage mapping

Each productive scenario now has its own Vitest case and its own default 5,000 ms watchdog. A per-package declaration case retains the exact scenario ID/mode inventory, manifest alternatives, instruction length, example schema validation, and S16 context-variant assertions. Every productive case still creates an independent real file workspace, approves exact fixture references through the real registry, invokes `runSkillPackage`, and runs all original output, provenance, lock, state, and approval assertions. The five blocked/rejection/reuse/replay guard cases retain their bodies.

| Former group                                    | New cases                                              |
| ----------------------------------------------- | ------------------------------------------------------ |
| S16 declaration plus seven productive scenarios | One declaration case plus seven named productive cases |
| S17 declaration plus four productive scenarios  | One declaration case plus four named productive cases  |
| S18 declaration plus eight productive scenarios | One declaration case plus eight named productive cases |
| Five guard cases                                | Same five cases                                        |

The file therefore reports 27 cases instead of 8; 19 productive scenarios are now separately bounded. No scenario or assertion was removed, skipped, or weakened. The timeout was not increased. Temporary roots are tracked per case with `AsyncLocalStorage` and deleted in that case's `finally`, after its async work settles. A timed-out callback cannot cause the next case's cleanup to remove its workspace. The default watchdog still reports a hung scenario. Abrupt worker or host termination can still prevent JavaScript cleanup, as with any process-local temporary directory.

## Validation and limits

The corrected test file passed 27/27 twice: first on base `925c033` (largest S16 case 278 ms) and again after integrating main `eac03b6` (largest S16 case 381 ms). Full Vitest passed 266/266 across 25 files on the base (largest S16 684 ms, S18 488 ms, suite 15.59 s), then 267/267 across 26 files on the updated branch (largest S16 834 ms, S18 688 ms, suite 16.73 s). The new Demo Lab catalog test accounts for the extra file and case. `pnpm exec vitest list --json` discovered all 267 tests after integration.

The unmodified `pnpm check` then passed on the updated branch: formatting, ESLint, Stylelint, HTML validation, Markdown lint, TypeScript, 18 schemas and fixtures, all three builds, CI script tests, DCO tests, and Vitest 267/267 across 26 files. Its Vitest phase took 15.40 s and the full command took 28.77 s. All runs used the pinned Node/pnpm versions and default nine-worker full-suite configuration; no tests were disabled.

A deliberate `--testTimeout=50` run of only `s16-design-critic executes criterion-review` failed at 66 ms as expected; no `mimic-quality-skills-*` directory remained in `/tmp` after process exit. This validates the local timeout cleanup path, not cleanup after a force-killed worker.

These runs bound observed local behavior and do not prove the flake is absent on every machine. The local checks ran on macOS arm64; hosted Linux exact-head CI remains necessary before review readiness. More severe ambient contention and abrupt process termination remain untested.
