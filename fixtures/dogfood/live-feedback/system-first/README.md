# 9UI-159 — source review packet

This is a new S04 answer and pending source proposal, not a completed System Feedback loop. The controlling AI read the exact 9UI-157 input and saved artifact snapshots. The original workspace `/tmp/mimic-9ui-157-reviewed.SxJHia` was first inspected without modification. A separate working copy retained that pending-only history for the new source Run; it did not promote old pending artifacts into the new Run's base. The original path was later used only for the post-158 exact S05 recovery.

For the human-facing background and options, read [`review-packet.ja.md`](review-packet.ja.md).

## Inputs and new source Run

- `inputs/input-packet.json` is byte-identical to the 157 synthetic input. Its constructed inventory and limits are the only routed evidence file for the new S04 task. The old S04/request snapshots are historical context and are not disguised as a routed evidence file.
- `tasks.json` contains only `task_source_review`, a new `PROPOSE_ONLY` S04 task in `run_9ui159_source_review`. The 157 Run plan remains the original four tasks.
- `work/task_source.json` is the authored S04 answer. `work/source.artifact.json` is the same candidate for `mimic validate`.
- `execution/commands.json` records argv, stdout, stderr and exit for validation, run, submit, next, decisions and status. `execution/readback.json` records persisted candidate, packet, events, both Run states, canonical state, submission binding and exact digests. `execution/validation.json` holds independent digest and preview checks. This new source Run used the starting 9UI-159 branch before the 158 merge.

The new Run started with `base: []` and `canonical: {}`. `submit` returned exit 0 and `submissionState: accepted`. Readback has one ready pending proposal, `proposal_rb159_source` in `packet_rb159_source`. Candidate `art_rb157_current_inspection@2` is `proposed/pending` at `sha256:0c8180500def077593d3b0bb11ffabeda44504b39a3dea3a7f618a9925f9d0c0`. All five original 157 snapshot digests were independently recomputed from the persisted workspace and matched their stored locks. The original source @1 and request @1 remain pending; canonical remains empty.

The candidate's `meta.createdAt=2026-10-07T23:25:00.000Z` was a fixed authored envelope value, not an observed generation time. The CLI `produce-provisional` and `submit-proposal` events are at `23:23:54.004Z`, about 66 seconds earlier. The persisted bytes and events were not rewritten.

## S04 answer and decision preview

**Known from the constructed inventory:** a synthetic GET `/work-orders` list contains exact work-order ID, zone, severity, age and assigned crew. One detail can be opened and one crew assignment action is inventoried. The word “current” is bounded to that inventory.

**Unknown:** whether the detail read refreshes severity, age or crew; update time; assignment persistence/result; authorization and error behavior; deployed implementation; user observations. The candidate does not add a comparison or bulk endpoint. The earlier freshness request is a conditional question, and an answer that detail freshness is unguaranteed is valid.

`planning/decision.preview.json` binds the exact candidate to an **unexecuted** approved @3 envelope. `planning/commit.preview.json` names only that proposal and decision. Their actor/time fields are hypothetical review values, not confirmation. Real owner confirmation must bind the exact packet, candidate, output and request; if the actual decision time, actor, content or dependencies change, regenerate the preview and digest. No `decide`, `commit`, local confirmation, receipt or authority injection occurred. `execution/recovery/planned-validate.json` records a regular CLI schema-only validation of the planned artifact, exit 0; it does not validate authority or final publication.

If the owner approves and commits the source, the preview would publish `art_rb157_current_inspection@3` at `sha256:f39c8286a87bb8d4e71c8934e99230e93ed81e51f99fffd68945bda4e716dc60` as canonical. The old S01 proposal still locks unapproved source @1, so this source decision alone does not approve the product or its downstream artifacts. A later Run must explicitly revise/rebind product, task, contract and request to the approved source @3. The old request @1 is never edited or treated as re-bound.

If the owner requests edits, produce another proposed revision with a new exact digest and packet. If rejected, record a human rejection through the normal boundary and create a later revision citing it when renewed. The saved previews are then inapplicable.

## Post-158 v1 recovery and path boundary

`execution/recovery-preflight.json` records a read-only comparison of the original and relocated package/work digests before execution. In the original real path, both digests match the v1 marker. The merged 158 CLI retried the exact original S05 package/work there. `execution/recovery/commands.json` has each argv, stdout, stderr and exit. The accepted result created an immutable `.revision.json` sidecar; `revision-requests` read back one request in `pending-source-approval`. The same retry returned accepted again. A changed work input returned exit 5, `Submission retry changed input`. The original workspace state, v1 marker and original work hash, plus event and artifact counts, remained unchanged. No routing receipt or human decision was created. The recovery added a sidecar and CLI outputs; the negative test added a separate work file. The original work bytes were unchanged. `execution/recovery/verify.json` checks the sidecar digest, exact bindings and zero canonical/decision/commit state.

Moving the old workspace to a different root changes `loadSkillPackage().directory` and therefore the package digest even when package file bytes match. `execution/recovery/relocated-conflict.json` records the separate-root v1 retry failing at exit 5 without changing that copy's state or marker. A clean-root execution with new Run and artifact envelopes is a replay, not a recovery of the old accepted submit. It has not been used as a substitute for the successful original-path recovery.

The two runtime roots are separate: the new source proposal is in `/tmp/mimic-9ui-159-source-review`, while the recovered legacy request side-channel is in `/tmp/mimic-9ui-157-reviewed.SxJHia`. No cross-root selection or automatic rebind occurred. A later source decision and newly bound S01/S02/S05/request Run must execute in one chosen workspace through the regular CLI; if the original root is chosen, the new source Run itself must be reproduced there through normal CLI commands. That continuation has not been performed.

The old source remains provisional, so the request remains pending source approval. Upstream response, new capability revision, downstream freshness assessment and 9UI-124 completion remain future work.
