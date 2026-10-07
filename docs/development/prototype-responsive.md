# Responsive prototype transforms

The optional `PrototypeBuilderInput.responsive` is an authored, versioned, non-artifact plan for narrow-viewport interaction. It supplements the existing per-state semantic tree and column layout. The builder does not infer it from scenario prose or treat a scenario approval as approval of these later DOM decisions. The complete input is saved in `plan.json`; its canonical digest binds every executable declaration in `manifest.json`. Omit `responsive` to retain the prior plan hash and emitted bytes.

Version 1 has a list of required-state entries. Each entry names the exact selected `responsiveRule` reference, a task and accessibility rationale, continuity IDs for entity, primary action, critical information and return path, and a finite ordered operation list. The rule is already an exact approved dependency of the scenario. Authors must inspect its meaning: equality of locks proves identity, not that the rule endorses a particular UI transformation. If interaction steps change from the approved scenario, author a new proposed scenario revision with its own review; never mutate the approved snapshot.

```ts
responsive: {
  version: 1,
  states: [{
    state: "success",
    rule: selection.responsiveRule,
    rationale: "Put the decision first while keeping evidence reachable",
    continuity: {
      entity: { desktopId: "candidate", mobileId: "candidate" },
      primaryAction: { desktopId: "choose", mobileId: "mobile-choose" },
      criticalInfo: [{ desktopId: "uncertainty", mobileId: "uncertainty" }],
      returnPath: { desktopId: "back", mobileId: "back" },
    },
    operations: [
      { kind: "reorder", parentId: "view", childIds: ["actions", "context"] },
      { kind: "progressive-disclose", targetId: "context", summary: "Candidate context" },
      { kind: "replace", targetId: "choose", with: {
        tag: "button", id: "mobile-choose", componentId: selectedButtonId,
        text: "Choose candidate", targetState: "disabled",
      }, focusMap: [{ desktopId: "choose", mobileId: "mobile-choose" }] },
    ],
  }],
}
```

`reorder` lists every direct child ID of one parent, once, and moves the actual DOM nodes into that reading and keyboard order. `collapse` and `progressive-disclose` both use a native `details` and `summary` control. They differ in the author's declared intent; both start closed on mobile and preserve their open state during viewport changes. `replace` supplies an explicit validated subtree; it cannot introduce arbitrary JavaScript, HTML or an unselected component. Each focusable action in the old and new subtrees needs a one-to-one focus mapping. The browser program restores the original nodes and order on desktop, retaining the active state, disclosure state and mapped focus through both resize directions. If a programmatically focused, ID-less heading is replaced on resize, focus moves to a visible heading in the current state; a closed disclosure sends focus to its summary. The existing state renderer and delegated state actions remain shared. `hide`, `split`, arbitrary callbacks and unknown operations are unsupported and fail closed.

Targets must belong to the named state, IDs and replacement IDs must be unique, actions and fragments must remain valid, and every continuity ID must exist on its stated surface. A required action hidden inside a disclosure has a named keyboard path through its summary. The machine checks these structural claims; it cannot establish that the replacement really means the same thing, that the stated entity is the right one, or that a user can complete the task. Those remain author review and, where needed, observed viewport evidence. Without that evidence, empirical mobile parity stays `UNVERIFIED`.

Current/Proposed comparisons add one mode binding per responsive operation. That binding classifies the entire operation, including summary and replacement behavior, to a System Capability choice. The Proposed status notice stays outside transformed groups and visible in each state. Static and browser quality findings bind actual saved bytes and report their tested scope. The [dedicated fixture](../../fixtures/prototype-responsive/approved.ts) and [generated browser test](../../apps/demo-lab/tests/prototype-responsive.spec.ts) exercise DOM order, disclosure keyboard paths, replacement, action completion, resize focus, mode notices, and axe on synthetic data; they do not certify WCAG 2.2 AA or real user success.
