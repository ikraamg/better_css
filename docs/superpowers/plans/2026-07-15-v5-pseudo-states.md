# v5 Pseudo-State Forcing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Behavior contracts + test specs, no reference code.

**Goal:** Give agents ground truth for interaction states — the layout consequences of `:hover`/`:focus`/`:active`, which agents notoriously cannot see. CDP's `CSS.forcePseudoState` forces an element into a pseudo-class state without input events; the page then reflows and every existing tool reports the forced-state truth.

## Global Constraints

- Evidence: `npm run typecheck && npx vitest run` (88/88 green at base `ea1f771`) and `npm run build`. RED-first.
- No new deps; additive contracts (stateless invocations byte-identical — all 88 existing tests unmodified); determinism (same page + same forced state → same output); alchemist commits.
- Hygiene: `pkill -f bettercss-` before suite runs if any ad-hoc probe was spawned.

---

### Task 1: Pseudo-state forcing across layout, check, inspect, explain

**Files:** Modify `src/core/connect.ts` or a new small `src/core/state.ts` (implementer's judgment — one clear responsibility: resolve selector → force state), `src/cli.ts`, `src/mcp.ts`. Tests: `test/cli.test.ts`, `test/mcp.test.ts`, plus a focused core test file. Fixture: new `fixtures/hover/index.html`.

**API contract (lean by design — one flag per state, no combined grammar to parse):**
1. CLI: `--hover S`, `--focus S`, `--active S` — each takes a CSS selector; usable together (different or same selectors); valid on `layout`, `check`, `inspect`, `explain` (NOT snapshot/diff in v1 — forced-state snapshots invite stale-state confusion; explicitly out of scope, revisit on demand).
2. MCP: optional `hover?: string`, `focus?: string`, `active?: string` params on the same four tools, same semantics; tool descriptions explain the capability ("see the layout consequences of interaction states without a mouse").
3. Unknown selector for any state flag → the existing clear-error path (reuse `resolveNode`'s suggestions message).

**Mechanics contract:**
4. Forcing happens after navigation, before extraction/inspection: `DOM.getDocument` → `DOM.querySelector` → `CSS.forcePseudoState({ nodeId, forcedPseudoClasses: [...] })` (CSS domain must be enabled — reuse the existing enable path in explain's collectSheets or enable directly; verify empirically whether forcing triggers reflow synchronously or needs a settle await — document what you find).
5. When the same selector is passed to multiple flags, one forcePseudoState call with the combined list.
6. Forced state applies for the lifetime of that tool invocation's page (each invocation opens its own page, so no cleanup needed — state dies with the tab).

**Fixture `fixtures/hover/index.html`:** a 300px-wide `.rail` containing `a.cta` styled `width: 200px`, with `.cta:hover { width: 400px }` (creates a parent-bleed ONLY under forced hover) and `.cta:focus { outline: 4px solid; min-height: 60px }` or similar focus-visible layout change. Pin all sizes.

**RED tests:**
- (a) CLI `check <hover fixture>` → no violations; `check --hover .cta` → parent-bleed with exact px (fails today: flag unknown).
- (b) CLI `layout --hover .cta` shows `.cta` at 400px wide; without the flag, 200px.
- (c) `explain --hover .cta --selector .cta --property width` names the `:hover` rule's file:line as winner (the cascade payload under forced state includes the :hover rule — verify empirically; if getMatchedStylesForNode needs the force applied first, the ordering in contract 4 covers it).
- (d) MCP `check` with `hover` param mirrors (a).
- (e) Determinism: two forced-hover layouts byte-identical.

**Steps:** fixture → RED tests → implement → full evidence run → commit `Added pseudo-state forcing to layout, check, inspect, and explain`.

## Self-Review
API chose per-state flags over a combined grammar (Tailwind-class colons make `SELECTOR:pseudo` parsing ambiguous — evidence from v2's selector escaping bug). Snapshot/diff exclusion is deliberate and documented. All contracts RED-testable; the one empirical unknown (reflow timing after forcePseudoState) is called out for the implementer to verify rather than assume.
