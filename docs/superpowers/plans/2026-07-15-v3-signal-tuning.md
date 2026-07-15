# v3 Signal Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Single task; behavior contracts + test specs, no reference code.

**Goal:** Make `check`'s "violations are ALWAYS bugs" promise true on real pages. Live investigation (usetrmnl.com, 2026-07-15) root-caused the three remaining false-positive classes and one grouping gap (news.ycombinator.com).

**Evidence base (from live probes, geometry verified):** the ×307 p-vs-p overlaps are `position:absolute; z-index:auto` overlays (intentional; CSS defines paint order for positioned elements); the ×10 path overlaps are SVG internals; the ×24 "off-screen" links sit inside `div.overflow-x-auto` (scroll-reachable); HN's `a#up_<digits>` unique ids give every violation its own group.

## Global Constraints

- Evidence: `npm run typecheck && npx vitest run` (73/73 green at base `caa4be1`) and `npm run build`. RED-first for every behavior change.
- No new deps; additive public contracts; determinism inviolable; alchemist commits.
- **Spec amendment included:** `docs/superpowers/specs/2026-07-14-css-ground-truth-design.md` invariant #3 must be updated to the new overlap semantics in the same commit (the spec previously required position **+ explicit z-index** for the layering opt-in).

---

### Task 1: Check signal tuning

**Files:** Modify `src/core/invariants.ts`, `fixtures/overlap/index.html`, `fixtures/zero-size/index.html`, the spec (invariant #3 wording). Tests: `test/invariants-2.test.ts`, `test/invariants-3.test.ts` (+ fixture additions as needed).

**Contract A — any non-static position is a layering opt-in (overlap):**
- `layered()` treats `position` ≠ `static` as opt-in regardless of `z-index` (transforms and negative margins unchanged).
- The existing `.oops` fixture case (absolute, no z-index, overlapping header) becomes a NEGATIVE case — update the fixture comment and the test that currently expects it to be flagged.
- Overlap needs a new TRUE-positive fixture case that survives the new semantics: two grid items explicitly placed into the same cell (`grid-row: 1; grid-column: 1` on both, static position, no transform, no negative margin, no z-index) — a genuine authoring-accident pattern. Test asserts exactly this pair is flagged.
- The X/Y/Z dedup case from v1 must be reworked or replaced so dedup coverage survives (its divs are absolute — under the new semantics they're exempt; rebuild the dedup scenario with same-cell grid placement or another in-flow collision).

**Contract B — SVG descendants are exempt from ALL invariants:**
- Any node whose self-or-ancestor tag is `svg` is skipped by every check (add to the prewalk ctx like `ignored`). The `svg` element itself keeps participating (its box is real flow content; e.g. a tiny interactive `<a>` wrapping an svg must still be a tap-target candidate).
- RED test: fixture with two deliberately overlapping `<path>` elements inside an `<svg>` → zero violations (fails today).

**Contract C — off-screen exemption for scroll/clip-managed content (zero-size check):**
- The OFF-SCREEN branch of zeroSize is skipped when any ancestor has `overflow-x` (or `overflow-y`) in `{auto, scroll, hidden, clip}` — scrollable means reachable; clipped means managed (carousel). The ZERO-DIMENSION branch (w or h === 0) is unaffected.
- RED test: interactive link at x beyond the viewport inside an `overflow-x:auto` container → not flagged (fails today). Keep an unconditional off-screen true positive (e.g. `position:absolute; left:-9999px` with NO clipping/scrolling ancestor) still flagged.

**Contract D — grouping keys ignore ids:**
- `renderViolations` group key becomes `(rule, tag + classes)` — the `#id` segment is excluded from the KEY only; the displayed selector remains the first violation's full `selectorOf` (with id). When a group with >1 members spans multiple distinct ids, no extra qualifier needed (the ×N marker suffices).
- RED test: 3 undersized `<a id="up_1|2|3" class="vote">` tap targets → ONE grouped line `×3` (today: three separate lines).

**Verification epilogue (controller):** re-run `check https://usetrmnl.com` (expect ≤ ~3 lines: the number-flow bleed and little else) and `check https://news.ycombinator.com` (expect a handful of grouped lines, no per-id lines).

**Steps:**
- [ ] Write all RED tests (A .oops flip + grid-cell true positive + dedup rework, B svg fixture, C scroll-container fixture + unconditional off-screen kept, D id grouping). Confirm each fails for the right reason.
- [ ] Implement the four contracts in invariants.ts; update fixtures; amend the spec's invariant #3.
- [ ] `npm run typecheck && npx vitest run && npm run build` — all green.
- [ ] Commit: `Updated invariant semantics from real-world signal tuning`

## Self-Review
Contracts A–D each trace to a live-verified root cause; each has a RED test; the one true-positive loss risk (accidentally mispositioned absolute elements no longer flagged as overlap) is accepted deliberately — positioned overlap is defined behavior, and the check's credibility outweighs the narrow catch. Spec amendment is in-scope and explicit.
