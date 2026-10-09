# 9UI-181 provisional color strategy probe

Generated and checked 2026-10-09. This is an **official Codex model probe with
the Mimic color-role checker**, not an accepted Mimic S13/S16 Run or an approved
brand. It keeps the model's output bytes intact for inspection.

| Evidence                    | File / identity                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed task and source brief | [`9ui181-color-probe-prompt.txt`](9ui181-color-probe-prompt.txt), SHA-256 `79da10c15dd1438eb293fb02fe3b6755d9434bd32fd4885a2773c4b5f081e59d`                           |
| Structured response schema  | [`9ui181-color-probe.schema.json.raw`](9ui181-color-probe.schema.json.raw), SHA-256 `139c9ecc946bc5540fbc97d4a699de71333aa86f5d0241b6122974fc55da1053`                 |
| Original model output       | [`9ui181-color-probe-output.json.raw`](9ui181-color-probe-output.json.raw), SHA-256 `75f51de03ad751e274588ddd23b7c5622a667fb58b1cf58170e8948aa0450555`                 |
| Model session               | Official Codex CLI 0.160.0, `gpt-6.1-sol`, `01a121cb-16a0-7f70-8e11-65a3ac06a6db`, read-only, native ChatGPT login; no new account, provider, or payment configuration |

All three strategies use the same Run-review facts and five contexts: proposal
comparison, Run in progress, blocked work, proposed selection, and completed
work. The recommendation remains explicitly **proposed, not human-approved**;
no progress percentage or event time was invented. The source IDs link to
`knowledge/seed/sources.json`; the output distinguishes observed source
mechanisms from untested Mimic predictions.

| Provisional strategy            | Source mechanisms                                              | Intended effect                                                                         | Tradeoff / rejection condition                                                                            |
| ------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Warm core, quiet surfaces       | kintone's brand-core priority and SmartHR's semantic roles     | An approachable identity remains visible while neutral cards carry comparison evidence. | Warmth consumes attention; reject if it competes with task state or does not match approved brand intent. |
| Sparse signature moments        | YouTube's selective emphasis and SmartHR's semantic roles      | Brand accent appears in a few identity moments while work surfaces stay restrained.     | Detail views may feel less connected; reject if persistent orientation requires a stronger anchor.        |
| Layered utility, minimal chroma | Carbon's contextual surface depth and SmartHR's semantic roles | Workspace, panel, and raised detail levels organize nested diagnostics.                 | Extra layers add maintenance and visual weight; reject on a shallow screen.                               |

The saved output passed `checkColorRoleProposal` with zero reported omissions or
unexplained shared values for all three candidates. The repository test also
checks the raw digest, identical contexts, proposal language, and three
different brand-accent values. This establishes a comparable role-map probe;
it does not establish rendered contrast, visual preference, user outcomes, or
that the free-text screen descriptions use every token correctly. One action
description says “surface.raised text”; that token use needs review in a
rendered implementation.

[`9ui181-color-probe-preview.html`](9ui181-color-probe-preview.html) repeats
identical content and markup in three panels, substituting only the generated
role values. [`render-9ui181-color-probe.mjs`](render-9ui181-color-probe.mjs)
generates it from the immutable raw output; `html-validate` passes. This is a
synthetic inspect-only preview, not a Mimic screen or a visually reviewed
result. Browser policy blocked opening both localhost and local-file URLs from
this task's Mac Chrome session, so no screenshot or visual conclusion is
claimed here.

An accepted Mimic S13 Run requires exact brand, design-direction,
product-ui-contract, and **approved foundations-and-governance** input. The
9UI-178 Run has provisional S10 directions and no approved foundation. Its
references cannot be relabeled as approved or inserted into S13. A later
independent Run must bind genuine approved inputs, or a test must be clearly
identified as synthetic. S16 critique and human brand choice remain open.
