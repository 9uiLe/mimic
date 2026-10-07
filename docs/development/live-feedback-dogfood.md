# Live System Feedback continuation (9UI-159)

The review packet is in [`fixtures/dogfood/live-feedback/system-first`](../../fixtures/dogfood/live-feedback/system-first). It preserves one real CLI S04 answer and a new pending source proposal. It does not claim a completed System Feedback loop, deployed Riverbend service, or human approval.

## Why another source proposal is necessary

The final 9UI-157 Run `run_9ui157_live_reviewed` contains five pending artifacts and no canonical selection. Its source `art_rb157_current_inspection@1` is provisional at `sha256:279c7f4e919acae0715b668ed78920bf7ad6719355ba11db3546f5bc35d82aa2`; its detail freshness request `art_rb157_detail_freshness_request@1` is provisional at `sha256:1890967be5d1c6055f102a6d6c032de6e6ea4a7f02c7631484b828b1753601b4`. The only old packet, `packet_rb157_product`, proposes product intent @1, which locks the unapproved source @1. The old request also locks @1. Its Run plan cannot acquire a fifth task under the same Run ID, and completed S04 cannot accept a changed work submit under its existing reservation. A new Run inherits only approved canonical selections, of which there are none.

The original 157 workspace existed at its recorded location and was read without editing it. All five stored artifact digests were recomputed and matched. A separate working copy retained the exact pending-only history for a new revision; it carried no approved store. `run_9ui159_source_review` has one S04 task and an empty base. The task's routed evidence is the same constructed input packet; old pending snapshots are historical context, not substituted evidence. The new answer explicitly leaves detail freshness, production semantics, authorization, error behavior and assignment result unknown.

The new source `art_rb157_current_inspection@2` was validated at schema-only level and submitted by the regular CLI. Exact digest: `sha256:0c8180500def077593d3b0bb11ffabeda44504b39a3dea3a7f618a9925f9d0c0`. The Run is `review-ready`, packet `packet_rb159_source` has the ready pending `proposal_rb159_source`, and canonical remains empty. This is a proposal for the bounded **constructed inventory**, not a claim that a production backend has the described behavior. The 9UI-150 design direction decision and any PR merge do not authorize it.

## Decision options

| Option                       | Effect and limit                                                                                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approve exact bounded source | After a separate real confirmation and Human Commit Point, the planned @3 revision could become canonical. It still leaves detail freshness unresolved and does not approve S01 or the request. |
| Request revision             | Obtain more exact system evidence or change the wording, then generate a new proposed revision and recompute every lock.                                                                        |
| Reject                       | Record a real rejection; a future renewed source must be a later revision that cites that rejection.                                                                                            |

The packet includes a full, machine-shaped decision preview and commit preview. Its proposed approved @3 envelope has digest `sha256:f39c8286a87bb8d4e71c8934e99230e93ed81e51f99fffd68945bda4e716dc60`, scope `org_local` / organization, no dependencies, and approval tied to `decision_rb159_source`. The preview actor and timestamp are hypothetical fields for exact review; neither file has been executed or confirmed. Actual approval requires owner confirmation on those exact bytes, or a regenerated preview if any field changes. The only planned commit effect is canonical source @3; old @1, pending product, request and downstream locks remain historical and unchanged.

After a real source approval, a later Run must explicitly generate new S01/S02/S05 revisions and a new request revision against the approved source lock, with fresh proposal/decision steps for durable changes. The old S01 packet and old request cannot be relabeled as approved. An upstream answer can state that the detail update guarantee is unknown; no missing backend API is inferred. Any downstream `onChange: revise` impact requires new work and readback, not an automatic lock rewrite.

## 158 recovery checkpoint

The 158/PR #60 merge is a prerequisite only for exercising its revised CLI side-channel behavior. The intended check is a retry of the exact 157 S05 package/work on the isolated copy, followed by regular CLI status/next and saved side-channel readback. Compare the accepted request's Run/task/work digest, exact source/request/affected locks, and `pending-source-approval` state. Retry the same bytes again for idempotence, and a changed work on the same task must conflict. No new event is required if Core verifies a request already in the Run. This check awaits the parent's merge completion notice; it has not been represented as completed here.
