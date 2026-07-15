# v6 State × Viewport Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Behavior contracts + test specs, no reference code.

**Goal:** Allow `--hover/--focus/--active` together with `--viewports` on `check` — interaction-state verification across breakpoints (a hover effect that fits at desktop width may bleed at mobile width and vice versa). v5 rejected this combination loudly because forcing requires per-page selector re-resolution; this implements exactly that.

## Global Constraints

- Evidence: `npm run typecheck && npx vitest run` (100/100 green at base `7bf8563`) and `npm run build`. RED-first.
- No new deps; additive contracts (every currently-working invocation byte-identical; the CURRENT loud rejection is the one behavior that changes — from error to working feature); determinism; alchemist commits.
- snapshot/diff remain state-free (v5's deliberate exclusion stands — matrix or not).
- Hygiene: `pkill -f bettercss-` before suite runs if ad-hoc probes were spawned.

---

### Task 1: State forcing inside the viewport matrix

**Files:** Modify `src/core/matrix.ts` (checkMatrix takes optional states), `src/core/state.ts` (if its helper needs a shape tweak — read it first), `src/cli.ts` (drop the rejection for `check`; keep it for snapshot/diff), `src/mcp.ts` (check tool accepts states+viewports together; snapshot/diff schemas unchanged). Tests: `test/cli.test.ts`, `test/mcp.test.ts`. Fixture: extend `fixtures/hover/` with a media query so the hover consequence is viewport-dependent.

**Contract:**
1. `check --viewports A,B --hover S` (and focus/active, and MCP equivalents) forces the state(s) INSIDE each per-viewport page, after navigation, before extraction — selector re-resolved per page (fresh nodeIds per viewport; reuse the v5 forcing helper).
2. Unknown state selector fails with the existing suggestions error, per viewport semantics: fail fast on the FIRST viewport that can't resolve it (elements may exist at one viewport and not another — e.g. `display:none` at mobile removes layout but the DOM node still exists; a selector matching zero DOM nodes anywhere is the error case. Note: DOM.querySelector matches display:none nodes, so per-viewport differences only arise from JS-conditional DOM, which static fixtures don't have — document this reasoning in a comment or the report).
3. Output identical in shape to the existing matrix: `[WxH] `-prefixed violations, summary line, exit 1 if any viewport dirty; busy-note preserved.
4. `layout/inspect/explain` never take `--viewports` (unchanged); `snapshot/diff` keep rejecting state flags (unchanged, still tested).
5. Fixture: extend `fixtures/hover/main.css` with `@media (max-width: 700px) { .rail { width: 500px } }` so `--hover .cta` (400px wide cta) bleeds the 300px rail at 1280x800 but FITS the 500px rail at 600x800.

**RED tests (must fail on current code):**
- (a) CLI: `check <hover fixture> --viewports 1280x800,600x800 --hover .cta` exits 1; output contains `[1280x800] parent-bleed` naming `.cta`, contains NO `[600x800]`-prefixed violation, and the summary line reads `1280x800=1 violations, 600x800=clean` (current code: exits 2 with the rejection error — that's the RED).
- (b) MCP: check with `viewports` + `hover` params mirrors (a).
- (c) Regression: `snapshot --viewports ... --hover S` still exits 2 with the rejection message.
- (d) Stateless matrix and single-viewport state runs byte-identical (existing tests unmodified).

**Steps:** fixture → RED tests → implement → full evidence run → commit `Added state forcing to the viewport matrix`.

## Self-Review
One task, one seam (checkMatrix callback gains a forcing step). The per-viewport re-resolution is the entire technical content — the v5 rejection existed precisely because skipping it would silently produce unforced results. Contract 2's reasoning about querySelector-vs-display:none is called out for documentation rather than over-engineering. Media-query fixture makes the feature's value self-demonstrating.
