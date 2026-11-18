---
name: mimic-ui
description: Investigate and improve a product UI when it feels confusing or hard to use. Use Mimic to diagnose the issue, apply relevant design knowledge, and check the result.
---

For each invocation, fetch the current Mimic workflow from https://raw.githubusercontent.com/9uiLe/mimic/refs/heads/main/agent/README.md using an available read-only web, GitHub, or shell tool. With the GitHub connector, read `agent/README.md` from `9uiLe/mimic` on `main`. Read the returned Markdown and apply it to the user's UI and request.

Resolve relative links against the file's directory in the same repository and ref. Fetch the relevant Markdown, source notes, and supporting references as the workflow directs. If the raw URL is unavailable, try https://github.com/9uiLe/mimic/blob/main/agent/README.md or a current checkout the user can access. If the workflow cannot be read, say so and ask for accessible text or continue the consultation with that limitation stated.
