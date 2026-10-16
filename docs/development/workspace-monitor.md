# Local workspace monitor

## Explicit working-base selection

For a saved `awaiting-human-selection` Run, the owner may explicitly start a
separate loopback operation surface after reviewing its operable candidates:

```sh
node scripts/9ui236-selection-ui.mjs /absolute/workspace/trial-config.json human_actor_id 4320 4318
```

The actor ID must identify the human who will actually use the form; it is not an
AI-generated adoption decision. This uses the existing cooperative local-host
trust model, not remote user authentication. Do not expose or proxy the service
to untrusted users. The form requires an unselected candidate/S11 exact-ref pair,
a reason and explicit confirmation. It reuses `LocalRevisionSelectionAuthority`
and Core `selectRevisionBase`; it does not merge a proposal, grant model use, run
a model or make a final adoption decision. Selection changes are deliberately
outside this first-selection UI: use the existing CLI confirmation and
`supersedesSelectionId` contract rather than overwriting a saved choice.

The first confirmed submission is atomically journaled under
`.mimic/working-selection-ui/<runId>.json`. Repeated identical submission and
restart retry that same request. A changed reason/candidate, another human,
external selection or stale exact refs are rejected; the process never invents a
supersession. Interrupted confirmation is not recorded as a successful selection.
Reload to review and explicitly retry. Do not delete a pending journal to bypass
a conflict. Once selected, the process starts the existing 9UI-220 revision
preparation UI on the fourth argument's port and links to it. If that port is
unavailable, the saved selection remains intact and reload retries starting the
preparation UI. Either port may be `0` for an available port. Ctrl-C stops both
services. A previously selected Run without this UI's matching journal must use
the standalone 9UI-220 command instead.

On restart with the matching saved selection, the preparation service starts
before the selection service reports ready; an existing preparation tab can be
reloaded first when its configured port is unchanged. If that port is occupied,
reload the selection page to see the saved choice and retry preparation. An old
CSRF token is rejected with instructions to return and reload the selection page.

If this selection consumes the last allowed revision, it remains saved and the
page reports the revision limit without starting preparation. An unselected Run
with no remaining revision budget cannot open the form. Each journal reload
checks the human actor again, including when another process creates it after
this process starts.

Add `--working-selection-port 4320` when starting the usual monitor alongside
`--review-current <review.html>`. Only an awaiting current review gets the link
to the explicitly started operation surface. The monitor and saved comparisons
remain GET-only/read-only; their static snapshot does not update after selection.
The operation surface re-reads the saved Run before displaying or saving it.

## Read-only monitor

After building, run the production CLI against an existing workspace:

```sh
node apps/cli/dist/main.js monitor --root /absolute/workspace --port 4317
```

Open the printed `http://127.0.0.1:4317` URL. The monitor reads actual Core Run records, task plans, exact artifact references and validated session checkpoints every two seconds. It orders Runs by the most recent recorded Core journal sequence. Stopped sessions take precedence over an `executing` task reservation; `accepted` with an `approval` stop means submitted and awaiting human approval. It displays counts and output-type stage classifications without invented percentages or stage completion. Recorded states do not certify approval or canonical authority. Failed polls visibly mark the connection and previous display as stale.

To operate an existing generated product bundle in a new tab, explicitly select its directory:

```sh
node apps/cli/dist/main.js monitor --root /absolute/workspace --port 4317 --preview /absolute/generated/bundle
```

The preview may be outside the selected workspace. It is clearly labeled as a separately selected, existing synthetic prototype; it is not evidence that the monitored Run produced it or that a backend, data persistence or approval succeeded. Without a valid selected bundle, the page reports an honest unavailable or unselected state. Only bounded regular `index.html`, `prototype.css`, `prototype.js` and `manifest.json` files are read; links are rejected. Additional bundle files are ignored, and no manifest, plan or arbitrary file route is served. The bundle is loaded once at monitor startup.

The preview runs in an opaque-origin `srcdoc` frame with only `allow-scripts`, restrictive intersecting CSPs and `connect-src 'none'`. Scripts/styles are inlined for this isolated frame. It cannot access the monitor parent/API, open popups, submit forms or navigate the top-level page. Product controls operate only on the prototype's synthetic data.

To inspect explicit 9UI-197 design-trial review snapshots on the same loopback service, add any of `--review-current <review.html>`, `--review-stopped <review.html>`, and `--review-replay <review.html>`. The corresponding links appear on the monitor and fixed design-review pages. The current slot accepts a stopped report and labels it as a stopped partial review; it rejects historical replay. The stopped and replay slots require their respective report states. The replay slot is for an explicitly marked historical report, such as the saved 9UI-197 replay made from earlier accepted artifacts; the normal `plan` command does not create replay Runs. A missing, linked, oversized, or mismatched file is shown as unavailable with no route. Only the selected regular HTML files and their explicitly linked, digest-bound, bounded PNG captures are read once at startup. They are served from fixed `/trial-review/{current,stopped,replay}` and numbered capture routes with a restrictive CSP. Re-run the harness `review` command and restart the monitor to show a later Run state. A stopped review does not prove a new candidate was generated; the replay snapshot uses past artifacts and is not a new model run. Neither review grants a human selection or final adoption. The monitor does not generate, select, approve, or commit a trial.

To try an unapproved, self-contained working sketch associated with a selected current review, also pass `--working-preview <working-preview.html> --working-preview-digest sha256:<64 hex digits>`. After running the harness, compute the digest with `shasum -a 256 <working-preview.html>` and retain it with the handoff before deploying. The monitor checks the whole file against it. It also checks that the Run, exact artifact reference, human selection ID, and each candidate's verification state match the current review, that both mark final adoption unapproved, and that the sketch's single script matches its declared hash. A valid sketch is linked from `/trial-review/current` in a separate tab at the fixed `/trial-review/working-preview` route. An invalid or absent sketch has no link or route, and a stale relative link in the saved review is removed. The route serves the bounded file with a restrictive sandbox and no backend write action. Trial selection and revision controls inside the sketch are local to that tab and reset on reload. This is separate from the approved bundle `--preview` route; it does not alter the recorded human working-base selection or grant final adoption.

The sketch keeps an opaque origin. Chrome reports a refresh after in-page navigation as a cross-site document navigation; the server permits that Fetch Metadata combination only for this fixed, read-only sketch route, without an `Origin` header. Cross-site API requests and other routes remain blocked. Its script is hash bound, `default-src 'none'` blocks fetches and other resources, and the server exposes no write route.

To show the three operable 9UI-216 direction screens, pass `--real-screens <real-screens.html> --real-screens-digest sha256:<64 hex digits>` alongside the existing monitor arguments. Compute the digest from the generated file with `shasum -a 256 <real-screens.html>`. The bounded HTML must match the current review's Run, selected working base, and all three exact candidate refs and verification records. A valid file appears on the monitor and current review and is served only at `/design-review/real-screens` with an opaque-origin sandbox. A missing or mismatched file has no route or entry. This separate local trial does not change the selected A working base, approve a direction, or write Run data; the existing working preview, product preview, stopped review, and historical replay remain available.

The same `--real-screens` options also accept the existing unselected candidate
screens for an `awaiting-human-selection` current review. First run
`node scripts/9ui197-harness.mjs candidate-screens <config.json>` and then
`node scripts/9ui197-harness.mjs review <config.json>` against the saved Run.
This only renders existing S10/S11 data, not a new model run; the existing sketch
renderer still requires its supported Mimic comparison brief and three distinct
saved layouts. Pass the resulting `candidate-screens-<runId>.html`, its SHA-256
digest, and the review to the monitor. The unselected sketch has an explicit
`data-run-id`, unselected marker and all three exact candidate refs and
verification records; they must match the current review. Selected-screen
validation still requires its selected working base. Old unselected HTML without
the Run marker must be rendered again from the saved data. The monitor removes
unserved relative candidate-screen links and adds the fixed read-only route only
for a valid file. All three directions are labeled as awaiting human choice.
Comparison controls never save a choice: return to the current review and open
the separately started `--working-selection-port` surface to confirm one.

When a current trial review is selected, the monitor now links its A-style candidate matrix before the saved three-screen trial. Generate that current review with `node scripts/9ui197-harness.mjs review <config>`; it reads the saved candidate and S11 evaluation records rather than the fixed three-screen sample. The matrix is still a read-only snapshot loaded at monitor startup. After a user writes a specific revision issue, the documented `prepare-next` command validates the existing exact working-base selection and prepares a new Run without executing a model. The service owner must refresh the selected review file and restart the monitor to show later Run states.

For an owner-approved local revision preparation session, start `node scripts/9ui220-revision-ui.mjs <current-config.json> 4318` separately. Its printed loopback URL serves an A-style comparison and an explicit issue form for the one human-selected Run. The form binds a CSRF token and fixed next Run ID; POST re-reads the Core Run, exact selected ref, selection ID and revision budget before reusing `prepare-next` to write only the next config/tasks/manifest. After reload, the page shows the saved plan and says that this UI did not start generation; check the Run itself for its current execution state. Repeated submission of the same issue is idempotent, while a changed issue conflicts. It rejects stale selections, cross-origin requests, and arbitrary paths. The process grants no model use, selection or final adoption. Set `--revision-prep-port 4318` on the monitor only if this separate session is running; the selected current review then links to it. The monitor remains GET-only and read-only. Stop the separate process with Ctrl-C.

The server binds only to `127.0.0.1`, requires its exact Host, rejects foreign/null Origin, uses fixed GET routes, sets no CORS permissions and disables caching. Public JSON is a fresh fixed projection of IDs, exact refs, closed state/type/stage/stop buckets, counts and the observation time. Prompts, questions, generated artifact contents, raw checkpoint/work/manifest data, model/account information, receipts, paths, environment and native streams are not public fields. Error responses contain only fixed generic codes. The monitor writes no workspace files and offers no model, authorization, approval, resume or commit action. Stop it with Ctrl-C; port `0` selects an available loopback port.
