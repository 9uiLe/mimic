# 9UI-159 — source review packet

This is a new S04 answer and pending source proposal, not a completed System Feedback loop. The controlling AI read the exact 9UI-157 input and saved artifact snapshots. The original workspace `/tmp/mimic-9ui-157-reviewed.SxJHia` was inspected without modification. The CLI execution used `/tmp/mimic-9ui-159-source-review`, an isolated byte copy of that pending-only workspace. It did not promote old pending artifacts into the new Run's base. The copied workspace's recorded starting SHA-256 is in `execution/readback.json`.

## Inputs and command evidence

- `inputs/input-packet.json` is byte-identical to the 157 synthetic input. Its constructed inventory and limits are the only routed evidence file for the new S04 task. The old S04/request snapshots are historical context and are not disguised as a routed evidence file.
- `tasks.json` contains only `task_source_review`, a new `PROPOSE_ONLY` S04 task in `run_9ui159_source_review`. The 157 Run plan remains the original four tasks.
- `work/task_source.json` is the authored S04 answer. `work/source.artifact.json` is the same candidate for `mimic validate`.
- `execution/commands.json` records argv, stdout, stderr, and exit for validation, run, submit, next, decisions and status. `execution/readback.json` records persisted candidate, packet, events, both Run states, canonical state, and exact digests. The CLI build used the starting 9UI-159 branch, before the 158 merge.

The new Run started with `base: []` and `canonical: {}`. `submit` returned exit 0 and `submissionState: accepted`. Readback has one ready pending proposal, `proposal_rb159_source` in `packet_rb159_source`. Candidate `art_rb157_current_inspection@2` is `proposed/pending` at `sha256:0c8180500def077593d3b0bb11ffabeda44504b39a3dea3a7f618a9925f9d0c0`. All five original 157 snapshot digests were independently recomputed from the original persisted workspace and matched their stored locks. The original source @1 and request @1 remain pending; canonical remains empty.

## S04 answer

**Known from the constructed inventory:** a synthetic GET `/work-orders` list contains exact work-order ID, zone, severity, age and assigned crew. One detail can be opened and one crew assignment action is inventoried. The word “current” is bounded to that inventory.

**Unknown:** whether the detail read refreshes severity, age or crew; update time; assignment persistence/result; authorization and error behavior; deployed implementation; user observations. The candidate does not add a comparison or bulk endpoint. The earlier freshness request is a conditional question, and an answer that detail freshness is unguaranteed is valid.

## Human review and later continuation

`planning/decision.preview.json` binds the exact candidate to an **unexecuted** approved @3 envelope. `planning/commit.preview.json` names only that proposal and decision. Their actor/time fields are a review preview, not confirmation. They require a real owner confirmation bound to the exact packet, candidate, output and request; if the actual decision time, actor, content, or dependencies change, regenerate the preview and digest. No `decide`, `commit`, local confirmation, receipt, or authority injection occurred.

If the owner approves and commits the source, the preview would publish `art_rb157_current_inspection@3` at `sha256:f39c8286a87bb8d4e71c8934e99230e93ed81e51f99fffd68945bda4e716dc60` as canonical. The old S01 proposal still locks unapproved source @1, so this source decision alone does not approve the product or its downstream artifacts. A later Run must explicitly revise/rebind product, task, contract and request to the approved source @3, after reviewing each output and exact lock. The old request @1 is never edited or treated as re-bound.

If the owner requests edits, produce another proposed revision with a new exact digest and packet. If rejected, record a human rejection through the normal boundary and create a later revision citing it when renewed. The saved previews are then inapplicable.

The post-158 exact S05 submit retry and durable side-channel readback are still pending the parent's merge notification. They must use the same original `task_contract` package/work bytes. The original source is provisional, so the expected request state is `pending-source-approval`; it must not be routed as approved. Full upstream answer, downstream freshness reassessment and 9UI-124 completion remain separate future work.
