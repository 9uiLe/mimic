# Local workspace monitor

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

The server binds only to `127.0.0.1`, requires its exact Host, rejects foreign/null Origin, uses fixed GET routes, sets no CORS permissions and disables caching. Public JSON is a fresh fixed projection of IDs, exact refs, closed state/type/stage/stop buckets, counts and the observation time. Prompts, questions, generated artifact contents, raw checkpoint/work/manifest data, model/account information, receipts, paths, environment and native streams are not public fields. Error responses contain only fixed generic codes. The monitor writes no workspace files and offers no model, authorization, approval, resume or commit action. Stop it with Ctrl-C; port `0` selects an available loopback port.
