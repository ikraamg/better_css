# v4 Responsive Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Behavior contracts + test specs, no reference code.

**Goal:** Close the two gaps proven by the graduation exercise (2026-07-15): single-viewport verification lets non-responsive fixes pass, and `explain`'s layout note doesn't name the actual constraining declaration. Plus: a CI workflow so the suite runs off this machine.

**Evidence:** a blind agent restored a broken layout to geometric equivalence at 1280px using `repeat(3, 320px)` where the original was `repeat(3, 1fr)` — `check` and `diff` both passed, yet at 900px the "fix" overflows by 282px. Separately, the agent needed two extra `explain` queries because the layout note said "layout constraints override" instead of naming `flex-basis`.

## Global Constraints

- Evidence: `npm run typecheck && npx vitest run` (80/80 green at base `3e1c27c`) and `npm run build`. RED-first for behavior changes.
- No new deps; additive public contracts; determinism inviolable; alchemist commits.

---

### Task 1: Viewport matrix for check and diff

**Files:** Modify `src/cli.ts`, `src/mcp.ts`, and whatever core assembly is shared (implementer's judgment — a small helper in core is fine). Tests: `test/cli.test.ts`, `test/mcp.test.ts`. Fixture: reuse `fixtures/basic` plus a new `fixtures/responsive/index.html` that is clean at 1280 but overflows at 600 (e.g. a fixed-width `720px` element).

**Contract:**
1. CLI `check` accepts `--viewports 600x800,1280x800` (comma-separated WxH list; reuses the existing `parseViewport`); MCP `check` accepts `viewports: string` (same format). When given, the page is checked once per viewport and each violation line is prefixed with `[WxH] `. Groups don't merge across viewports. Exit 1 if ANY viewport has violations.
2. A trailing summary line per run: `checked N viewports: <WxH>=clean|M violations, ...` — deterministic ordering (input order).
3. `diff` accepts the same `--viewports` list ONLY when the snapshot side matches: snapshots are per-viewport — `snapshot --viewports ...` writes `<name>@WxH.tree` files (single-viewport behavior unchanged: plain `<name>.tree`); `diff --viewports ...` diffs each against its `@WxH` file and prefixes output identically. Mismatched/missing per-viewport snapshot → the existing clear-error path (resolved path in message).
4. Single-viewport invocations behave byte-identically to today (all existing tests green unmodified).
5. RED tests: (a) responsive fixture `check --viewports 1280x800,600x800` exits 1 and output contains `[600x800] viewport-overflow` but no `[1280x800]`-prefixed violation; (b) snapshot+diff round-trip with two viewports → `(no layout changes)` per viewport; then a CSS-visible change (test can copy the fixture to a temp dir and serve the modified copy) shows a `[600x800]`-prefixed diff line.

**Steps:** RED tests → implement → full evidence run → commit `Added multi-viewport matrix to check, snapshot, and diff`.

---

### Task 2: layoutNote names the actual constraint

**Files:** Modify `src/core/explain.ts`. Tests: `test/explain.test.ts`. Fixture: extend `fixtures/cascade/` with a flex case (`.flexrow { display:flex } .flexchild { width: 300px; flex: 0 0 200px }` → computed 200px).

**Contract:**
1. When declared winner ≠ computed and the note fires (both px / geometry property — existing gating unchanged), attempt to NAME the constraint, checking in order: (a) the element's own `flex-basis` differs from declared width/height and parent is flex → `flex-basis: <value> (from flex shorthand)` when it came via the shorthand (reuse the existing `via` machinery); (b) the element's own min/max-width/height clamps the declared value (computed equals the min/max) → name that property and its source file:line via the same matched-rules data already fetched; (c) parent `display: grid` → keep the existing grid wording. If none match, fall back to the current generic message.
2. Output format: the note becomes e.g. `computed 200px differs from declared 300px — constrained by flex-basis: 200px (via flex: 0 0 200px) @ styles.css:N`. Existing grid-fixture test updated only if its wording changes; the generic fallback keeps every other existing assertion green.
3. RED test: flex fixture — explain('.flexchild', 'width') note must contain `flex-basis` and the file:line (fails today with the generic message).

**Steps:** RED → implement → evidence → commit `Updated layout note to name the constraining declaration`.

---

### Task 3: CI workflow (best-effort — no remote exists to run it)

**Files:** Create `.github/workflows/test.yml`. No tests (CI validates itself when the repo gets a remote).

**Contract:** ubuntu-latest; checkout; setup-node 20 with npm cache; `npm ci`; `npm run typecheck`; `npx vitest run`; `npm run build`. Chrome: ubuntu-latest runners ship Chrome — no install step, but set `CHROME_PATH` from `which google-chrome` if the connect logic needs it (check `CHROME_PATHS` in connect.ts — `/usr/bin/google-chrome` is already listed, so likely zero config). Add a `timeout-minutes: 15`. Guard the POSIX-only Chrome-leak test: it must not be skipped silently — it already works on Linux (pgrep exists); leave as-is. Commit `Added CI workflow for the test suite` with a body noting it is unexercised until a remote exists.

## Self-Review
Task 1 matrix semantics chosen smallest-that-closes-the-gap (per-viewport prefix + per-viewport snapshot files; no cross-viewport diffing). Task 2 checks own-element constraints before parent-display heuristics, reusing already-fetched data (no new CDP calls). Task 3 explicitly flagged unverifiable-until-pushed. All contracts RED-testable except Task 3 (excluded from that rule by nature).
