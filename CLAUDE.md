# csstruth — Agent Context

Hard ground truth for CSS: extracts the browser's *actual* rendered layout as
deterministic, diffable text so agents stop guessing. Chromium-only, via the
Chrome DevTools Protocol. Public (MIT): github.com/ikraamg/csstruth · npm: csstruth.

## Architecture (learn this first)

- **One core, two skins.** All logic lives in `src/core/*`. `src/cli.ts` and
  `src/mcp.ts` are thin wrappers that call identical core functions. Never put
  logic in a skin — if both skins need it, it goes in core.
- **The seam is `withPage(url, fn, opts)`** in `src/core/connect.ts`: opens a
  page, sets viewport, navigates, settles, runs `fn`, always tears down. Almost
  everything flows through it. Opts compose (`captureAnimations`, `beforeNavigate`,
  `skipSettle`) — mirror that pattern for new connection concerns.
- **The LayoutTree** (`tree.ts`) is the core representation: one line per element,
  **byte-identical across runs**. Determinism is the whole thesis — never add
  timestamps, key-order dependence, or randomness to rendered output.
- 12 CLI commands (10 also MCP tools; `watch` is CLI-only). Core modules:
  connect, extract, tree, invariants, explain, inspect, snapshot, verify, matrix,
  baseline, interact, animate, stability, state, fix, blame, watch, serve.

## The invariant checks (`src/core/invariants.ts`)

Six rules power `check`/`verify`, each tuned so a violation is a REAL bug —
the exemptions are deliberate, not laziness, and each is tagged `field #N` /
`NEXT-*` in a comment (grep them for the rationale):

- **viewport-overflow** — content wider than the viewport.
- **parent-bleed** — a child past its container's padding box, BOTH axes
  (`checkBleed` mirrors horizontal/vertical, clamped by the nearest overflow-x/y).
  Exempts absolute/fixed and deliberately-displaced children (`displaced()`:
  negative margin, a *translating* transform via `translatesBox` — `translateZ(0)`
  and other no-op transforms still flag — or non-static position with a real inset).
- **zero-size / off-screen** — interactive element with a 0 dimension or parked
  off-screen (unless inside a scroll/clip ancestor).
- **text-clip** — text past a hidden-overflow box with no ellipsis opt-in.
- **overlap** — two un-layered siblings overlapping. Exempts SVG internals,
  sr-only, empty async placeholders (`isPlaceholderOverlap`), and a descendant
  that escaped an intermediate container and lapped a cousin
  (`escapesIntermediateContainer` — parent-bleed owns that defect).
- **tap-target** — sub-24px interactive element. Measures an input's `<label>`
  not the sr-only input; exempts a text link inline in a sentence (WCAG 2.5.8 —
  requires its own text, display:inline, and real parent text — an icon-only link
  still flags).

`findNode` (tree.ts) resolves a compound selector (tag + #id + class subset) for
layout scoping; `escapeCssSelector` (explain.ts) lets Tailwind selectors round-trip
into `resolveNode`/`inspect`. Both fall back to the prior exact/raw contract on a
miss, so they are strictly additive.

## What's good (rely on it)

- **The adversarial review loop is the real quality engine.** Every feature was
  implemented → reviewed by an independent agent with *live reproducers* → fixed
  → re-verified. It caught, live: a symlink container-escape, a stale-guard
  patching the wrong CSS rule, `blame` framing an innocent commit, `baselineKey`
  silently never collapsing id-bearing selectors, mobile emulation silently
  disabling overflow detection. Do not skip it. RED-first, always.
- **Self-calibrating over hardcoded.** `extract.ts`'s `boundsScale` measures the
  device-pixel ratio per capture (layoutViewport/cssLayoutViewport) instead of
  assuming one — survived Chrome flipping the unit. Prefer this shape.
- **Fixtures are pages with *planted* bugs + a clean control.** Model every new
  fixture on a real failure. Class-only selectors hide id-bugs; static pages hide
  timing/mobile bugs — cover the actual shape.
- Violations are tuned to be *real* bugs (intentional overlays, SVG internals,
  carousels, sr-only, scroll-managed content are exempt). Escape hatch:
  `data-csstruth-ignore`.

## What's bad / fragile (the scars)

- **Chrome process lifecycle is a minefield, mostly on Linux.** SIGKILL a Chrome
  and a renderer forked at that instant can become `ps`-visible only *after* the
  killer exits — userspace-unreapable (github issue #1). Defenses shipped:
  detached-spawn group-kill, terminal launch latch, `sweepAbandonedProfiles` at
  every launch, env-gated shutdown telemetry (`CSSTRUTH_DEBUG_SHUTDOWN=1`). The
  `blame` SIGINT test still flakes under full-suite load on macOS (Chrome 150
  brought the race cross-platform). Linux CI handles it (logs residual, doesn't
  hard-fail). **Follow-up owed:** make the macOS strict assertion signature-based
  cross-platform.
- **CDP unit/field traps.** DOMSnapshot bounds may be device px (normalize).
  Under `mobile:true`, `cssLayoutViewport` inflates to content width — use
  `cssVisualViewport` for anything measuring overflow. `DOM.getDocument` called
  twice invalidates nodeIds and silently drops forced pseudo-state (cache the
  root per client). `Animation` domain must be enabled *before* navigation.
- **Baseline had the least continuous authorship** (recovered from two dead
  subagents, finished by hand) — it got the hardest review and is solid now, but
  touch it carefully. `baselineKey` MUST equal `groupingKey` (single source in
  invariants.ts) or id-bearing selectors silently never collapse.
- Known accepted trade-offs (documented inline): multi-violator `(x,y)` shows the
  first instance only; `wrappingTargetBox` unions all visible descendants; the
  settle gate is per-`withPage` and skipped only for `stability`.

## Process rules (learned the hard way — non-negotiable)

- **Chrome-orphan hygiene:** kill orphans with a STANDALONE command —
  `pkill -9 -f "user-data-dir=.*csstruth-"` — and NEVER put that pattern in the
  same shell line as the test suite. The leak-detection tests `ps | grep` for it
  and will match your own shell, producing phantom "failures" (this footgun
  wasted an entire CI-debugging session). Sweep between heavy runs; the suite
  wedges under Chrome contention.
- **Test-spawned MCP servers must be single-process:** `node --import tsx src/mcp.ts`,
  never an `npx → tsx` chain (the chain head dies to signals and orphans the real
  server).
- **Run the suite FOREGROUND with exit codes checked.** Don't pipe vitest into
  grep and lose the exit code. The blame SIGINT test being the *only* failure = green.
- **Tests default to isolated headless Chrome.** csstruth attaches to a dev's
  Chrome on 9222 only with `--attach` (CLI). If a debug Chrome is on 9222, default
  runs ignore it — good, don't fight it.
- Determinism changes are proven by a byte-identical double-run test. Browser-truth
  changes to pinned values must be *justified* (meta-viewport differences are real;
  a silently-disabled check is a bug masquerading as truth — the mobile-overflow
  regression proved this).

## Dev setup

- Local MCP runs from **source** (dev mode), so `src/` edits are live in the next
  session with no rebuild: `node --import <repo>/node_modules/tsx/dist/loader.mjs
  <repo>/src/mcp.ts`. Rebuild `dist/` only for npm consumers / publish.
- Evidence bar for any change: `npm run typecheck && npx vitest run && npm run build`
  all exit 0. Fixtures drive the tests against real headless Chrome.
- Commit style: alchemist (`Added…`/`Fixed…`/`Updated…`, WHY-focused body,
  `Co-Authored-By` trailer). Plans/specs live in `docs/superpowers/`.

## When adding a feature

1. Read the field/spec finding and the code it touches — trace the real flow first.
2. Fixture modeled on the real failure (planted bug + clean control).
3. RED test → minimal core change at the choke point → GREEN → foreground evidence.
4. Independent adversarial review with live reproducers before merge.
5. Update README + `skills/csstruth/SKILL.md` (the agent doctrine) together.
