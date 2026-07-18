# v10 Field Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Behavior contracts + test specs, no reference code. Four tasks in field-priority order.

**Goal:** Adopt the six improvements from the first real production-app sweep (a live Rails marketing site + logged-in dashboard, 2026-07-18). Field verdict: the tool was "the diagnostic hero" but ~99% of raw violations on app pages were false positives from three root causes, and the all-or-nothing verdict blocks CI adoption. Source doc (local-only): docs/notes/csstruth-improvements.md.

## Global Constraints

- Evidence: FOREGROUND `npm run typecheck && npx vitest run && npm run build`, exit codes checked. 223/223 green at base `0bdbca8`. RED-first.
- No new deps; additive contracts; determinism preserved (settling makes captures MORE deterministic, never less); alchemist commits.
- Hygiene (hard rules): no leak-pattern literals in compound shells; standalone pkill (`csstruth-` prefix now); single-process MCP spawns; foreground suites.
- Fixture realism: every fix gets a fixture modeled on the actual field failure (async-render page, sr-only toggle, standing-violations baseline page).

---

### Task 1: Settle-before-extract + placeholder-overlap guard (field #1 + #5)

**The field's biggest finding:** app pages holding persistent connections (websocket/Turbo) never reach network-idle — every capture hit the 10s cap and read a MID-RENDER DOM: flex items before shrink (site-wide phantom bleed), empty async parents stacked (54 phantom overlaps), `w-full` buttons at 0 width. `stability` proved the real page was rock-solid (CLS 0.002).

**Files:** Modify `src/core/connect.ts` (navigate/withPage), reuse `waitForSettle` (src/core/interact.ts), `src/core/invariants.ts` (overlap guard), verify's verdict path for the inconclusive case. Fixtures: new `fixtures/async-render/` (page whose layout builds via JS over ~600ms with a never-closing connection — e.g. an open EventSource/long-poll fetch to the fixture server keeping network busy, plus staged JS that shrinks a flex row and fills empty containers). Tests: new + existing suites stay green.

**Contract:**
1. After navigation (load-event + network-idle race as today), EVERY capture path additionally waits for layout stability via the SHARED `waitForSettle` (per-element rect hash + finite-animation emptiness), cap 3s. This runs for check/layout/inspect/explain/verify/snapshot/diff — one seam in withPage or immediately after `navigate()` (implementer's judgment; must not double-settle with interact steps or animation seeking, which already settle — compose, don't stack caps).
2. When the settle cap is hit (page never stabilized): (a) the existing busy-note machinery marks the client; (b) `check`/`verify` apply the PERSISTENCE FILTER — capture twice ~400ms apart and report only violations present in BOTH captures (a mid-render phantom doesn't survive; a real bug does); (c) `verify`'s first line becomes `VERDICT: INCONCLUSIVE (page never settled; N persistent violations)` when the filtered set is non-empty and the cap was hit — never a confident FAIL on mid-render truth; exit code 1 still (CI shouldn't pass), but the wording is honest. Clean filtered set + cap hit → `VERDICT: PASS (page never fully settled)` exit 0.
3. Overlap placeholder guard (field #5, applies always): an overlap where the intersection ≈ the smaller element's full box (≥95% of its area) AND the smaller element has no text, no textBoxes, and no children → suppressed (empty async placeholder signature). RED fixture case.
4. Settled pages behave byte-identically to today except strictly less mid-render noise (existing fixture tests are the regression net — they're all fast-settling, so zero behavioral change expected; any diff is a bug).
5. Note in verify/check output when the persistence filter engaged: `note: page never settled — reporting only violations stable across two captures`.

**RED tests:** (a) async-render fixture WITHOUT the fix shows phantom violations (bleed from unshrunk flex, overlap from empty parents) — with the fix, `check` is clean (settle waited) — structure the RED by pinning the new clean behavior; (b) never-settling variant (perpetual mutation loop) → INCONCLUSIVE wording + persistence filter note, phantom absent; (c) placeholder-overlap fixture case suppressed while the real overlap fixture cases still fire; (d) determinism: two runs on the async fixture byte-identical.

**Commit:** `Added layout-settle gating and placeholder overlap guard`

---

### Task 2: sr-only awareness + label tap-targets + multi-match disambiguation (field #2 + #4)

**Field findings:** the `sr-only` accessibility pattern (1px clipped, purpose-built) flagged as tap-target and text-clip violations on every toggle (Tailwind `peer` switches); generic selectors matching N elements made `check` and `inspect` describe DIFFERENT instances (674px vs 337px — briefly misdiagnosed as a DPR bug).

**Files:** `src/core/extract.ts` (STYLE_WHITELIST += `clip`, `clip-path`), `src/core/invariants.ts` (sr-only detection in ctx; tap-target label resolution; message disambiguation), `src/core/inspect.ts` (multi-match note). Fixtures: `fixtures/sr-only/` (peer-toggle pattern: sr-only input + styled label ≥24px; an sr-only span that must not text-clip), extend an existing fixture with duplicate generic-class elements.

**Contract:**
1. sr-only signature (per field doc): `position:absolute` + box clamped ≤2px in both dims + `overflow` hidden/clip + (`clip` set to a rect OR `clip-path` non-none). Elements matching it are exempt from `tap-target` and `text-clip` (they are non-visual by design). Whitelist additions must not disturb existing style-index consumers (index-aligned — the suite catches slips).
2. Label-as-target: for an interactive `<input>` flagged by tap-target, if an associated `<label>` exists (`for=` matching the input's id, or a wrapping label ancestor), measure the LABEL's box; only flag if the label is also under 24px. Requires attrs (already captured) + a document-order scan (walk) — no new CDP calls.
3. `inspect` on a selector matching N>1: first line gains `(N matches; showing #1 — others: WxH at (x,y), …)` capped at 3 others.
4. Violation messages for generic selectors: append the instance's `(x,y)` — e.g. `div.flex.items-center.gap-2 (at 24,310)` — ONLY when the selector matches more than one element in the tree (keep single-match messages byte-identical; grouping keys unchanged — position is display-only, appended after grouping).

**RED tests:** (a) sr-only fixture: zero tap-target/text-clip violations (fails today with both); label 20px variant still flags (the exemption isn't a blanket pass); (b) inspect multi-match note; (c) duplicate-class violation message carries `(at x,y)` while single-match messages elsewhere are unchanged (pin one existing message).

**Commit:** `Added sr-only awareness, label tap targets, and instance disambiguation`

---

### Task 3: Baseline file + delta verdicts (field #6 — unblocks CI)

**Field finding:** after a genuinely successful fix, `verify` still said `FAIL (49 violations)` because ~15 standing benign flags remained — the fixer had to hand-diff violation lists. All-or-nothing verdicts make the tool unusable for confirming targeted fixes and for CI adoption on non-green pages (the standard linter-adoption problem).

**Files:** New `src/core/baseline.ts`. Modify `src/cli.ts` (new `baseline` command + `--baseline` flag on check/verify), `src/mcp.ts` (baseline param on check/verify + a `baseline` tool or write-mode param — implementer's judgment, document), README + skill (the adopt-on-brownfield workflow).

**Contract:**
1. `csstruth baseline <url> [--viewports ...] [--file .csstruth-baseline]` captures the CURRENT violation set and writes it as a sorted, human-readable, diff-friendly file: one line per accepted violation, keyed `(viewport?, rule, selector)` — the SAME identity keys grouping already uses; px values excluded (they drift). Deterministic output.
2. `check`/`verify` `--baseline FILE`: violations whose key is in the baseline are reported under a collapsed `baseline: N accepted violations unchanged` line (not itemized); NEW violations (not in baseline) are itemized as today and drive the verdict/exit; RESOLVED entries (in baseline, no longer present) are itemized as `resolved: <rule> <selector>` — celebrating the fix is the point. Verdict semantics: `VERDICT: PASS (2 resolved, 0 new, 13 baseline)` exit 0 / `VERDICT: FAIL (1 new …)` exit 1 — the delta decides, not the absolute count.
3. Missing baseline file → clear error (the resolved-path pattern). Baseline + INCONCLUSIVE (Task 1) compose: persistence-filtered violations are what's compared.
4. `--update-baseline` on check/verify: rewrite the file to the current set after a run (adopting intentional changes) — prints what was added/removed from the baseline.
5. Without `--baseline`, behavior byte-identical to today.

**RED tests:** (a) baseline write on the hover fixture (forced state = deterministic violations) → file content pinned; (b) verify --baseline with the same state → PASS with `baseline: N` line despite violations existing (fails today: FAIL); (c) introduce a new violation (second fixture variant) → FAIL naming ONLY the new one; (d) remove a baselined violation → PASS with `resolved:` line; (e) --update-baseline round-trip.

**Commit:** `Added violation baselines with delta verdicts`

---

### Task 4: Mobile emulation fidelity (field #3)

**Field finding:** the 375px "mobile" leg runs `mobile:false, deviceScaleFactor:1` — a desktop window squeezed narrow, not a phone: touch-target rules enforced on a non-touch emulation, `<meta viewport>` behavior unexercised.

**Files:** `src/core/connect.ts` (viewport → emulation mapping), possibly `src/core/extract.ts` (bounds scaling — THE empirical risk), docs.

**Contract:**
1. Viewports with width ≤ 500 emulate `mobile: true, deviceScaleFactor: 2` (plus `Emulation.setTouchEmulationEnabled` if empirically needed for touch semantics); wider viewports unchanged. An explicit escape hatch: `--desktop-only` flag (or `mobile=false` param) to force old behavior — additive.
2. THE KNOWN UNKNOWN (verify empirically FIRST, before wiring): whether `DOMSnapshot` bounds under DPR 2 return CSS px or device px. If device px, normalize by DPR at extraction so every reported number stays CSS px and all existing fixtures/pinned geometry stay byte-identical at DPR 1 AND correct at DPR 2. A dedicated fixture test pins a known element's CSS-px size at 375x800 (mobile) equal to its size under the old emulation — geometry must NOT change from emulation alone for static pages.
3. Existing test suite is the regression net: the default sweep's 375 leg now runs mobile — any pinned-value change must be justified as browser truth (meta-viewport differences) or treated as a bug.

**RED tests:** (a) bounds-normalization pin (element WxH identical across DPR 1/2 emulation on a static fixture); (b) a `<meta name=viewport>`-dependent fixture behaving differently (and correctly) under mobile emulation; (c) --desktop-only escape hatch restores old behavior.

**Commit:** `Added true mobile emulation for narrow viewports`

## Self-Review
Order = field priority (settle kills ~90% of noise; sr-only kills the recurring rest; baseline unblocks CI; mobile is the riskiest change so it goes last with the escape hatch). Task 1's INCONCLUSIVE verdict + persistence filter directly implement the field doc's fallback menu. Every contract carries a fixture modeled on the real failure. The field doc's "verify auto-runs stability when the cap is hit" idea is deliberately deferred — INCONCLUSIVE wording + persistence filter covers the confusion it addressed, at a fraction of the runtime cost; revisit if field data disagrees.
