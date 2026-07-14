# v2 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three findings from the 2026-07-14 dogfood run (usetrmnl.com, news.ycombinator.com): suspect-rule lookup silently failing on Tailwind-class selectors, parent-bleed flooding on intentional-overflow patterns, and layout output far exceeding the token budget on real pages.

**Architecture:** All three are contained changes to existing modules (explain.ts, invariants.ts, tree.ts/cli.ts/mcp.ts). Unlike the v1 plan, tasks specify behavior contracts and exact test cases rather than full code — the implementer reads the current sources (they evolved through 20+ review fixes) and writes the code. TDD is mandatory: every behavior change lands RED-first.

**Tech Stack:** unchanged (TypeScript, chrome-remote-interface, MCP SDK, vitest).

## Global Constraints

- No new dependencies. Evidence commands: `npm run typecheck && npx vitest run` (58/58 green at base `1ce0251` — must stay green plus new tests) and `npm run build`.
- LayoutTree determinism is inviolable: same render → byte-identical text.
- Public contracts may only change additively (optional params/fields).
- Commit messages alchemist style (`Added …`/`Fixed …`/`Updated …`).
- Every new behavior gets a fixture-backed test proven RED against the old code.

---

### Task 1: Suspect lookup via backendNodeId

**Problem (verified live):** `renderViolations` calls `explain(client, v.selector, 'width')` where `v.selector` is `selectorOf()` output. Tailwind arbitrary-value classes (`.w-[calc(100%-2rem)]`) and variant colons (`.xs:w-72`) make that string invalid for `DOM.querySelector`, so `resolveNode` throws, the `.catch(() => null)` swallows it, and 533/535 parent-bleeds on usetrmnl.com shipped with no `suspect:` line.

**Files:** Modify `src/core/explain.ts`, `src/core/invariants.ts` (renderViolations). Test: `test/explain.test.ts`, `test/invariants-1.test.ts` (or a new focused file), new fixture `fixtures/tailwindish/index.html`.

**Interfaces (additive only):**
- `explain(client, target: string | { backendNodeId: number }, property)` — when given `{ backendNodeId }`, resolve the CDP nodeId via `DOM.pushNodesByBackendIdsToFrontend` (call `DOM.getDocument` first if required by CDP — verify empirically) and skip `resolveNode` entirely. The returned `Explanation.selector` should carry a display string: accept an optional third piece of context or synthesize from `DOM.describeNode` (implementer's judgment; keep it lean, it's display-only).
- `inspect` may remain selector-only (user-facing; users type valid selectors).
- `renderViolations` passes `{ backendNodeId: v.backendNodeId }` instead of `v.selector`.

**Behavior contract:**
1. `check` on a page whose offending element has class `w-[calc(100%-2rem)]` MUST include a `suspect:` line (RED today: silently absent).
2. String selectors keep working identically (all existing explain tests green, unchanged).
3. A backendNodeId that no longer exists (stale) → explain throws a clear error, and renderViolations' existing catch degrades to no suspect line (no crash).

**Fixture `fixtures/tailwindish/index.html`:** minimal page with `* { margin: 0 }`, a 200px-wide parent, and a child `<div class="w-[calc(100%-2rem)] xs:w-72">` given `width: 300px` via a `<style>` rule targeting an escaped class or attribute selector (e.g. `[class*="w-["] { width: 300px }`) so the bleed is plain-CSS reproducible.

**Steps:**
- [ ] Write failing test: `check`-level (via `checkInvariants` + `renderViolations` against the tailwindish fixture) asserting output matches `/suspect: width: 300px/`. Run; confirm RED (no suspect line).
- [ ] Write failing unit: `explain(client, { backendNodeId }, 'width')` for a node obtained from a built tree; assert winner value/file. Confirm RED (signature rejects object).
- [ ] Implement; run both tests GREEN; full suite green.
- [ ] Commit: `Fixed suspect lookup for unescapable selectors via backendNodeId`

---

### Task 2: Visible-bleed semantics + violation grouping

**Problem (verified live):** (a) The carousel pattern — cards intentionally overflow a flex row that an ANCESTOR clips — produced 535 parent-bleed reports; the exemption only checks the direct parent's overflow. (b) Identical violations repeat per element (~40 near-identical lines), flooding agent context.

**Files:** Modify `src/core/invariants.ts`. Test: `test/invariants-1.test.ts` or new file; new fixture `fixtures/carousel/index.html`; update `fixtures/bleed/index.html` only if needed (existing assertions must stay green).

**Behavior contract — visible bleed:**
1. Compute the child's *visible* right extent: `visRight = min(child.right, clipRight)` where `clipRight` is the nearest ancestor (strictly above the direct parent, or the direct parent itself as today) with `overflow-x` in `{hidden, clip, auto, scroll}` — using that ancestor's padding-box right edge; if none, `visRight = child.right`.
2. Flag only when `visRight > parentPaddingRight + 1`; the reported px is `visRight - parentPaddingRight` (the VISIBLE bleed). Mirror the same logic on the left edge.
3. Consequences that MUST hold (each is a test):
   - Carousel fixture (wrapper `overflow:hidden` → flex row → cards wider than the row): ZERO parent-bleed violations.
   - A child bleeding 100px past its parent while `body { overflow-x: hidden }` clips at 1280px, child fully inside 1280: STILL flagged with 100px (page-level overflow-x:hidden must not disable the check — this is the regression trap; prove it with a test).
   - Existing bleed fixture assertions (100px and 104px cases) unchanged and green.

**Behavior contract — grouping:**
4. `renderViolations` (and the violations list rendering in CLI/MCP check output) groups violations sharing `(rule, selector)` into ONE line: `parent-bleed: div.card ×39 bleeds 24–312px outside div#track (…)` — count, min–max px range, one suspect lookup for the FIRST element of the group only. Single violations render exactly as today (all existing test assertions must pass unmodified).
5. Grouped output is deterministic (stable ordering: first occurrence order).

**Fixture `fixtures/carousel/index.html`:** wrapper `width:600px; overflow:hidden` → inner flex row (no overflow set) → 8 cards `flex: 0 0 200px`. Plus a second, genuinely-visible-bleed case for grouping: 3 identical `.wide-item` children (fixed 300px) inside three separate 200px parents with no clipping ancestor → expect ONE grouped line `×3`.

**Steps:**
- [ ] Write failing tests for contracts 3a (carousel zero), 3b (body-clip trap), 4 (grouping ×3). Confirm RED (today: carousel floods, grouping absent).
- [ ] Implement visible-bleed in parentBleed; implement grouping in renderViolations.
- [ ] Full suite green (watch the existing bleed/clean-page tests like a hawk).
- [ ] Commit: `Fixed parent-bleed to measure visible overflow and group repeats`

---

### Task 3: Layout output budget

**Problem (verified live):** full `layout` of usetrmnl.com is ~4,946 lines (~60k+ tokens) against a 2–4k token design target.

**Files:** Modify `src/core/tree.ts` (renderTree), `src/cli.ts`, `src/mcp.ts`. Test: `test/tree-render.test.ts`; new fixture `fixtures/deep/index.html` (generated nesting/width producing >400 rendered lines — commit the static file, no build step).

**Behavior contract:**
1. `renderTree` gains optional `budget?: number` (max output lines). When the full render exceeds it, re-render at the deepest depth whose output fits the budget, then append one final line: `… truncated to depth N (M elements total) — pass depth or selector to expand`. Deterministic (same tree + budget → same output).
2. Explicit `depth` always wins over budget (no truncation note beyond the existing `… N children` markers).
3. CLI `layout` and MCP `layout` default to `budget: 400` when neither `depth` nor (for MCP) an explicit budget-disabling choice is given; document the default in `--help`/tool description. `check`/`snapshot`/`diff` are UNAFFECTED (snapshots must stay full-fidelity — a budget-truncated snapshot would corrupt diffs; state this in a comment).
4. Small pages (fixtures/basic) render identically to today — every existing assertion green.

**Steps:**
- [ ] Create the deep fixture; write failing tests: (a) budgeted render ≤ 400 lines + truncation note, (b) explicit depth overrides budget, (c) basic fixture byte-identical with and without default budget. Confirm RED ((a) fails today).
- [ ] Implement; wire CLI/MCP defaults; update README's layout tool row and MCP description.
- [ ] Full suite green + `npm run build`.
- [ ] Commit: `Added line budget with auto depth truncation to layout output`

---

## Verification epilogue (controller, not a task)

Re-run the dogfood probes and record deltas in the ledger:
- `check https://usetrmnl.com` → expect suspect lines on bleeds, grouped output, total independent lines ≪ 904.
- `layout https://usetrmnl.com` → ≤ ~401 lines with truncation note.
- `check https://news.ycombinator.com` → tap-targets still reported (grouped).

## Self-Review

1. Coverage: all three dogfood findings have a task; each contract names its RED test. 2. No placeholders: contracts specify exact behaviors, fixtures, assertions; implementation code is deliberately delegated to implementers who read current sources (stated in Architecture). 3. Consistency: `explain` target union matches Task 1's renderViolations usage; budget excluded from snapshot paths per Task 3 contract 3.
