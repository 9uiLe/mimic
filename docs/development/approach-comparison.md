# 9UI-182: Mimic の参照・試行・判断の方式比較

Status: provisional comparison design, 2026-10-09. This document is an input to
9UI-183/184, not an adopted operating policy. The owner's desired outcome is a
reviewable Design Package reached with convincing evidence and reasonable time.
Reducing model calls or approvals is useful only when that outcome improves.

## Evidence inventory and its limits

| Domain                         | Checked evidence and graph route                                                                                                                                                                                                                                                                                                  | Transfer condition and limit                                                                                                                                                                                                                     | Current execution evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structural divergence          | [9UI-179 source review](../../knowledge/seed/product-ui-source-review.md): teamLab's object collection, SmartHR's comparison table, GitHub Actions' nested run, and Google's expressive emphasis. Trait → principle → reference space → case → mechanism → principle is recorded in `knowledge/seed/{graph,spaces,sources}.json`. | Choose a case for task and mechanism fit, never for visual similarity. A table needs comparable attributes; a run hierarchy needs nested state. Google's expressive treatment may fail on dense diagnosis but is not a permanent anti-reference. | [9UI-178 accepted S09–S11](https://github.com/9uiLe/mimic/blob/ai/9ui-178-next-dogfood/docs/dogfood/9ui178/accepted-design-artifacts.json) used an exact copy of the 179 playbook: SmartHR near; teamLab, GitHub and wiki-history adjacent; Google and Factorio far. Three structural directions were accepted and compared by four common criteria. S09 could not establish graph traversal or exclusions because the supplied graph lacked links to the four new cases. The result is a provisional recommendation, not user adoption. |
| Purpose and information amount | [9UI-180 review](../../knowledge/seed/purpose-information-source-review.md): SmartHR, teamLab, GOV.UK Details and multiple tasks, GitHub Actions.                                                                                                                                                                                 | Keep facts required for the current decision visible, put bounded explanation on demand, and keep IDs inspectable when needed. A long task list is noise for a one-pass task; hiding a decisive difference is a failure.                         | [Same-state before/after](https://github.com/9uiLe/mimic/pull/82) and the S11 four-axis table show a relevant interface change. The 180 playbook was **not** an exact S09 input in that Run; direct use remains unverified.                                                                                                                                                                                                                                                                                                              |
| Brand/color roles              | [9UI-181 review](../../knowledge/seed/color-source-review.md): kintone slides 24–28, YouTube New Hue, SmartHR tokens, Carbon layers.                                                                                                                                                                                              | Approved brand intent precedes a selected hue. Separate brand accent, selection, action and status meanings. Layering must clarify containment; saturation can obscure work evidence.                                                            | [Fixed model probe](../dogfood/9ui181-color-probe.md) produced three same-content role maps, checked by `checkColorRoleProposal`. It is not an accepted S13/S16 Run or visual/user validation: approved foundations are missing.                                                                                                                                                                                                                                                                                                         |

All cases are provisional local knowledge, with authors, URLs, verification dates,
observations and transfer hypotheses in the source ledger. Exact evidence bytes
must be copied into a Run workspace and named in `evidenceFiles`; a graph read
in another process is not automatically available to a Skill. Host-side
`retrieveDesignReferences` must make any claimed graph retrieval explicit.

## Responsibility map

The stage contracts below come from each `skills/s*/manifest.yaml` and
`SKILL.md`; a stage may be skipped when its domain is not involved. “Machine”
means checks the existing runtime can make or a proposed host preflight,
not proof of design quality. All canonical commits and release authority stay
outside a Skill.

| Stage                       | References at point of use                                                | Machine check; model trial                                                                                  | Human decision boundary                                                                                  |
| --------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| S01 Product Definition      | task brief, user tasks, system context                                    | input provenance and schema; propose purpose and scope                                                      | durable product definition only after exact review                                                       |
| S02 User Task Model         | product intent, research, existing model                                  | schema and named evidence; model maps tasks/states                                                          | resolve disputed user goals, not every task row                                                          |
| S03 Brand                   | product context, brand evidence, organization foundation                  | source/scope/role integrity; model proposes character                                                       | owner selects brand identity and color intent                                                            |
| S04 System Capability       | observed implementation and task evidence                                 | cited capability vs request, source locks; model identifies gaps                                            | actual system changes and authority                                                                      |
| S05 Product UI Contract     | exact S01/S02/S04, optional brand/journey/rules                           | required lock/contract consistency; model proposes interaction commitments                                  | approve a durable contract or consequential capability change                                            |
| S06 Principles              | definition/task, optional brand/contract/profile                          | source lineage and asset schema; model states conditional principles                                        | promotion to shared organizational rule                                                                  |
| S07 Experience Architecture | S01/S02/S05, optional capability                                          | cross-domain scope and journey locks; model proposes boundaries                                             | durable domain boundaries and journey choice                                                             |
| S08 Problem Profile         | S02/S05/S07, current task observations                                    | exact snapshot and risk/source shape; model names design problem                                            | clarify disputed task or constraint, not routine profile text                                            |
| S09 Reference Selection     | S08/S05, task-conditioned graph projection, 179/180 playbooks             | source IDs, evidence digest, role/fit and exclusion reasons; model chooses near/adjacent/anti references    | no case is adopted as UI; disputed source rights or strategy may require review                          |
| S10 Directions              | exact S08/S05/S09, optional brand/capability                              | artifact locks, pairwise structural diversity and declared capability gaps; model tries distinct mechanisms | no selected direction before a reviewable comparison                                                     |
| S11 Evaluation              | all exact S10 directions, S08/S05, purpose criteria and counterexamples   | same criteria and exact targets; model compares evidence, noise, trade-offs and uncertainty                 | earliest useful choice point: adopt/revise a direction **only** if a durable choice is needed to proceed |
| S12 System Resolver         | proposed direction, contract, task context, approved assets               | exact approved-asset and policy checks; model proposes compatible reuse or request                          | asset promotion or consequential new system capability                                                   |
| S13 Visual System           | brand, direction, contract, **approved foundations**, color role evidence | exact approval/roles/source check; model proposes visual/token candidates                                   | brand/palette and foundation approval before canonical adoption                                          |
| S14 UI Composition          | task, contract, direction, resolved assets                                | lock/state/capability checks; model plans scenario and composition                                          | material product behavior or capability change                                                           |
| S15 Responsive              | scenario, selected assets, contract                                       | state/viewport/transform validation; model plans adaptation                                                 | new shared asset policy, not each breakpoint                                                             |
| S16 Critique                | contract, optional brand/reference and prototype evidence                 | exact target, failures and uncertainty; model critiques actual candidate                                    | accept a consequential direction change or system request                                                |
| S17 Curator                 | source evidence, existing asset                                           | source/scope/license/promotion checks; model proposes knowledge update                                      | shared-knowledge promotion and policy change                                                             |
| S18 Validation              | contract, observations, prior evaluation                                  | exact scope, static/browser checks and missing observations; model synthesizes residual risk                | final Design Package/release decision                                                                    |

For the current design comparison, accessibility is not an evaluation or
convergence criterion or gate. Existing interaction features and other
independent product quality checks are not removed by this document.

### Where repeated model judgment can be replaced

- **Before S09:** a host graph traversal can check path, source ID, prior
  rejection, fit-role consistency and portfolio omissions deterministically.
  S09 still judges whether a connected mechanism fits this task; the graph
  cannot establish that semantic fit. The accepted 178 S09 lacked graph links
  for its four new cases, so this is a testable improvement, not an observed
  gain.
- **After S10:** exact input locks, declared pairwise structural axes and
  missing capability labels can be checked before asking S11 to interpret
  trade-offs. Mechanical diversity does not prove useful diversity; a model
  still explains how the options change the user's task.
- **At S11:** freeze one problem-derived criterion set and require every
  candidate to answer it. Compare missing decisive facts and excess noise
  separately, as the 180 playbook and 178 four-axis comparison suggest.
  The machine checks coverage and provenance; the model weighs contextual
  consequences; a person chooses a consequential direction.
- **At S12–S18:** exact approved-asset locks, color-role completeness and
  static/browser observations should be computed once and reused by exact
  digest. A model may critique meaning and propose a repair, but cannot
  relabel a failed check or create approval. No automatic accept/reject
  threshold is inferred from the research.

Static rejection before immutable reservation permits an explicit fresh
invocation with the rejected bytes retained. A timeout, cancellation or
unknown outcome requires the existing lease/recovery protocol before retry.
Semantic disagreement at S11 returns to S10 with an explicit changed
question or constraint; a repeated identical prompt is not a design method.
Changes to a source, contract, approved asset or knowledge snapshot require
new exact refs and a new comparison cohort rather than silently updating one
arm. These rules preserve the existing Human Commit Point and history.

## Three comparison arms

The [9UI-178 historical Run](https://github.com/9uiLe/mimic/blob/ai/9ui-178-next-dogfood/docs/dogfood/9ui178/design-cycle.md) is a valuable
functional observation: static rejections and timeouts were recoverable, and
S09–S11 completed. Its model and knowledge changed across attempts. Its ~597 s
of accepted invocation time and ~30 min dispatch interval cannot be used as
the causal baseline for the arms below.

For a matched comparison, first create **one new isolated workspace** and
freeze current page/API observations, S01/S02/S04/S05/S07/S08 input artifact
refs, one repository commit and knowledge file digests, model/version, session
configuration, skill package digests and evaluation questions. Do not mutate
the 178 workspace or localhost. Then run separate IDs for these arms, each
with its own immutable plan, evidence path/digest, session and artifact prefix:

| Arm                           | S09 reference timing                                                                                                                                                                                    | S10/S11 and human packet                                                                                               | Hypothesis / cost                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| B0 flat evidence              | The same task-relevant 179/180 corpus is supplied to S09 in one bounded evidence file, as in the present workflow.                                                                                      | Exact S09 → structurally diverse S10 → all-direction S11. Human sees the S11 packet.                                   | Baseline for matched runs, not the old 178 measurement. Broad context may help synthesis but can distract or increase latency. |
| C1 task-conditioned retrieval | Host retrieves cases against S08 problem traits before S09; the evidence file includes chosen cases, source IDs, conditions, exclusions, and full corpus digest. S09 may revise roles.                  | S10/S11 use the same contracts; a compact S11 packet keeps alternatives and uncertainty.                               | Earlier selection may improve structural fit and reduce prompt noise, but host selection can omit a useful distant mechanism.  |
| C2 staged counterexamples     | S09 receives the same corpus snapshot but foregrounds positive mechanisms; a separate S11 evidence file foregrounds purpose criteria and counterexamples. No source is concealed from the saved bundle. | S10 diverges before the counterexample check; S11 evaluates the same full candidate set and exposes repair/retry need. | Could widen divergence; late failure may cause extra S10 work and delay the decision packet.                                   |

These arms vary **when and how evidence is foregrounded**. They do not relax
the static S09/S10/S11 contract, invent approvals, or change the model between
arms. C1 graph retrieval is a host operation with its own recorded input and
output, not a capability silently attributed to S09. Every arm receives a
complete source inventory digest for audit. C2's later emphasis cannot be
called a knowledge-free S10: its S09 reference selection remains required.

The early human packet is the S11 comparison, exact refs, source/failure
links, viable alternative and what would change with a choice. No sleeping
owner response is simulated. Exploration through S11 is reversible and may
continue without committing a direction; S12–S15 production-equivalent work
still needs the exact approved inputs named by those manifests. A proposal,
schema acceptance, and formal adoption are different states.

## Measurement and decision rule

9UI-183 will record per arm: input and knowledge hashes, model/settings,
dispatch/terminal timestamps, accepted/rejected invocations, retry reason,
tokens if available, exact refs and lock digests, source cases used/excluded,
direction mechanisms, S11 common-criterion findings, and the first time a
decision packet is reviewable. 9UI-184 will show the actual design candidates
and same-state screens separately from machine acceptance. Human response
latency, satisfaction, and user comprehension remain unmeasured until an owner
actually responds or participants are observed.

Prefer a variant only if it preserves contractual correctness and produces
reviewably different, supported alternatives with no material loss of
decisive information. Compare elapsed time and retries without fabricating
precision or rankings from one run. A smaller call count alone is not a win.
If only a subset finishes by the deadline, publish the exact completed arms
and refrain from a causal recommendation.

Do not adopt: automatic selection of a case's visual style; cosmetic
variation counted as a new direction; an approval label supplied by the model;
removing S12/S13 authority checks to get a visual preview; or attributing
historical 178 differences to this comparison. Each either contradicts the
source fit boundary or the existing artifact authority model.

## Reversible rollout

9UI-183 adds a comparison-only entry point and immutable per-arm evidence;
ordinary `mimic run` and prior Run stores remain unchanged. No default route
changes until the owner chooses a method. A failed arm is retained with its
original model candidate and static rejection; rerun uses a new session and
invocation through the normal CLI. Deleting the comparison entry point does
not rewrite historical artifacts. Subsequent visual exploration will require
genuine approved foundations or be labeled synthetic, never an approval
shortcut. The owner decides the final approach after 9UI-184 evidence.
