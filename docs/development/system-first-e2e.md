# System-first dogfood: synthetic Riverbend Repairs

This is the 9UI-124 repeatable System-first exercise. The [case file](../../fixtures/dogfood/system-first/case.json) describes a constructed city water-leak repair desk, two work orders, and a read-only inventory of the existing list/detail/assignment behavior. It contains no resident, employee, credential, provider, or production data. `fixture:rb-work-orders-v1` supports only the stated **constructed** current capability. The proposed two-order comparison has no current endpoint in that inventory.

## Workflow and provenance

`fixtures/dogfood/system-first/setup.ts` writes schema-valid exact revisions to `ArtifactStore` backed by a shared workspace transaction. The constructed capability is recorded with a fact provenance pointer to the case evidence. Product Definition and User/Task Model feed the shared Product UI Contract. Triage and Dispatch are separate because their primary goals and interaction models differ. Their Journey preserves the work-order ID, terminology, navigation, return path, and assignment state. The Problem Profile names competing priorities, identity continuity, and assignment risk. The far reference contributes a persistent-entity-context mechanism, not its screen or incident labels. Queue/detail and paired inspection differ in task structure; the latter remains proposed and has an explicit capability gap.

A `system-first` Run begins with verified canonical revisions. A candidate direction is produced and submitted as an exact proposal. The tests demonstrate rejection, a new revision linked to the rejection, unapproved commit refusal, a simulated approval/commit, and unchanged revision reuse on a later Run. The simulated actor ID begins `synthetic_`: this proves Run guards and atomic publication, **not** that an owner reviewed or approved the direction. A genuine Human Commit Point is still required for 9UI-124 acceptance. The review candidate is paired inspection; options are approve it as a provisional direction, retain queue/detail, or request revision. The evidence is the two structural mechanisms, the constructed capability inventory, and the observed generated prototype behavior. Limits are no real dispatcher observation, no comparison implementation, and no real human decision.

### Owner review packet (not yet decided)

| Option                                                   | Mechanism and evidence                                                                                                                                                                                                    | Cost or unresolved condition                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Approve paired inspection as a **provisional direction** | Explicit two-order inspection tray; [synthetic case](../../fixtures/dogfood/system-first/case.json) contains WO-1042 and WO-1043 and no comparison endpoint. Browser checks show the mock Proposed state remains labeled. | Requires a new system capability before operational use; no real dispatcher evidence. |
| Retain queue/detail                                      | Uses the constructed current list/detail capability and preserves exact work-order ID.                                                                                                                                    | Comparing orders requires switching selections and remembering prior details.         |
| Request revision                                         | Keeps both structures open for another design pass.                                                                                                                                                                       | A new exact direction revision and evidence review are needed.                        |

A real owner decision would authorize selection of one **direction revision** at the Human Commit Point. It would not approve a missing comparison endpoint, establish usability, or authorize a Design Package release. The evidence needed to decide is the two exact direction revisions, their risks, the Current/Proposed generated screen, and the mode quality-gate defect [9UI-142](https://linear.app/9uile/issue/9UI-142/prototype-modes出力をquality-gateが誤ってbundle-manifest-failにする). The synthetic Run decision in tests is not this owner decision.

The authored render and mode plans are separate, reviewable inputs. `buildPrototypeModes` generates Current and Proposed HTML/CSS/JS, preserving the exact scenario and product contract. Proposed labels name the exact System Request; Current does not display the proposed capability. These inputs and browser flows show deterministic behavior only. They do not establish that an AI independently made a good design judgment.

The test also builds a standalone Current bundle with the same approved sources. Static quality checks run against its exact bytes and artifact locks. Desktop and mobile Playwright flows open the **generated** Current and Proposed pages, use keyboard and pointer actions, check the work-order ID, state transitions, responsive card positions, overflow, and automated axe rules. Manual accessibility and representative task success remain `UNVERIFIED`; automated axe results never assert WCAG 2.2 AA conformance. A malformed HTML variant produces a scoped `FAIL` finding. A wrong digest and an unapproved scenario fail closed.

The standalone bundle, synthetic case, all exact selected approved artifacts, quality evidence, and decision-limit note feed the real `compilePackage` and `FilePackagePublisher` in temporary local storage. Tests reconstruct both Reference and Portable modes through `PackageRegistry`, compare exact prototype bytes, check a synthetic external dependency, and reject publication without exact synthetic release authority. This is a deterministic publication simulation only, not a production or human-approved release. The `case.json` plus this report are a privacy-safe sample for later 9UI-122 work; they do not attempt its full deliverable.

## Reproduce

Use Node 24.21.0 and pnpm 12.9.1:

```sh
pnpm exec vitest run packages/core/src/dogfood-tests/system-first.test.ts
pnpm exec playwright test apps/demo-lab/tests/system-first-e2e.spec.ts
pnpm check
pnpm test:browser
```

The tests create and remove their output roots under the OS temporary directory. They do not write a release, require a provider key, or request external data.

## Integration gaps and acceptance limits

- [9UI-142](https://linear.app/9uile/issue/9UI-142/prototype-modes出力をquality-gateが誤ってbundle-manifest-failにする): `buildPrototypeModes` places Current at `comparison/current` but saves the render plan's `outputPath` as `current`. `runStaticQualityGates` compares that value from the trusted root and reports `bundle-manifest: FAIL/BLOCKER`. The first test reproduces this directly and shows the standalone builder path passing. The core implementation is outside 9UI-124's write set.
- [9UI-147](https://linear.app/9uile/issue/9UI-147/ai向けcliのpreviewreleaseを実装しsystem-first経路を接続する): In an initialized temporary CLI workspace, `preview` and `release` each returned `MIMIC_4` / unsupported exit code 4; direct core builder/compiler calls are not evidence that the AI-operated CLI path works. The dogfood therefore does not yet satisfy the complete CLI-to-release path.
- [9UI-146](https://linear.app/9uile/issue/9UI-146/webkitで生成prototypeのtab初回フォーカスが失敗する): on this macOS host, WebKit desktop/mobile did not move first `Tab` focus to the generated `Show success` button. The existing prototype-builder and keyboard-focus gate tests failed the same way. Do not convert this observed `FAIL` to a pass or skip WebKit.
- [9UI-145](https://linear.app/9uile/issue/9UI-145/macosローカルplaywright-firefoxがsandbox拡張エラーで起動timeoutする): local Firefox launch timed out at 180 seconds with `sandbox_extension_issue_file_to_process ... Operation not permitted`. The full local `pnpm test:browser` reached 43 passed, 15 failed, and 2 interrupted before the stuck run was stopped; the 15 failures comprise Firefox launch and WebKit focus/gate failures. This is not a green browser run.
- The fixture authority is explicitly synthetic. Owner review and a real Human Commit Point are needed before calling the direction selected or the package released. Mobile browser checks and static gates establish scoped deterministic facts, not usability or design quality.

This issue remains open until the parent reviews these gaps and a real owner decision and full AI-operated path are exercised. No synthetic output should be treated as an approved product asset.
