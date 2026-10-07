# C-204 executable synthetic journey

This fixture builds a local specification prototype for [9UI-148](https://linear.app/9uile/issue/9UI-148). It uses fixture authority and synthetic cases. It does not represent real approval, a committed decision, a backend, or user research.

## Open the local demo

From the repository root, use Node 24.21.0 and pnpm 12.9.1:

```sh
pnpm install --frozen-lockfile
node fixtures/prototype-journey/demo.mjs
```

Open the printed loopback URL. The command prints the exact plan digest and generated bundle directory. Press Ctrl+C to stop and remove the temporary fixture. This only serves the generated HTML, CSS, and JavaScript on the local machine.

## What to do and observe

1. Enter `needs-review` in **Filter cases by status**. C-204 and C-205 remain; C-206 disappears.
2. Open **C-204**. The Review view shows C-204, approval `pending`, and committed decision `none`.
3. Type `My C-204 draft <uncommitted>` in **Uncommitted review draft**. The preview shows those characters as text.
4. Select **Return to filtered queue**. The filter still reads `needs-review`, C-206 remains hidden, and focus returns to the filter.
5. Open C-204 again. The draft is unchanged.
6. Return, open C-205, and observe its blank draft. Give it different text. Return to C-204 and confirm C-204 kept its own draft.
7. Select **Discard draft** on C-204. Its draft clears; approval remains `pending` and committed decision remains `none`.
8. Try **Show error** and **Show success**, then resize across 640px. The same case is retained; mobile Review reorders the decision, collapses evidence, and progressively discloses history.

The draft and filter live only in the current page session. Reloading resets them. The controls perform finite local actions only; they make no network request or production data change. Current/Proposed comparison is separately synthetic. Automated axe, HTML lint, and keyboard checks are bounded evidence, not full accessibility or usability proof. The macOS Firefox sandbox and separate legacy WebKit focus difference tracked in 9UI-146 remain environment limits; the generated journey has its own checked forward-Tab handoff.

## Reproduce checks

```sh
pnpm exec vitest run packages/core/src/prototype-journey/prototype-journey.test.ts packages/core/src/prototype-modes/journey.test.ts
pnpm exec playwright test apps/demo-lab/tests/prototype-journey.spec.ts --project=chromium-desktop --workers=1
```

See [the journey contract](../../docs/development/prototype-journey.md) for plan and exact-source rules.
