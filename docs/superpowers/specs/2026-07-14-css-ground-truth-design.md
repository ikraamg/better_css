# better_css — CSS Ground Truth for Coding Agents

**Date:** 2026-07-14
**Status:** Approved design, pre-implementation

## Problem

Coding agents lack hard ground truth for CSS/layout work. Backend agents get
deterministic feedback (tests, API responses, DB state); CSS agents get pixels
(fuzzy, nondeterministic) or interactive DevTools poking (slow, non-repeatable).
Agents guess at what the browser actually rendered and why.

## Goal

Give agents deterministic, token-efficient, assertable truth about rendered
layout — extracted live from the browser — plus the ability to trace any
rendered value back to the source CSS rule (file:line) that caused it.

Philosophy: **lean but informative — trust the agent, but give it strong enough
support that it never has to guess.** Rich structured truth + always-on
invariant checks; no heavyweight spec-authoring language.

## Decisions (from brainstorming)

- **Shape:** full loop (extract → check → trace) with **live MCP** as the
  primary interface; CLI over the same core for CI and self-testing.
- **Engine:** Chromium-only via raw Chrome DevTools Protocol (CDP). CDP is the
  only engine API exposing layout boxes, computed styles, and cascade tracing
  with source ranges in bulk. Cross-browser is out of scope for v1.
- **Assertion model:** universal invariants (zero config) + golden layout
  snapshots. No declarative spec language in v1.
- **Proving ground:** fixture pages with planted bugs; they are the tool's own
  permanent test suite.
- **Strategy:** build standalone (this repo). Upstreaming pieces to
  chrome-devtools-mcp is a future distribution decision, not an architecture
  decision.

## Architecture

```
better_css/
├── src/
│   ├── core/
│   │   ├── connect.ts     # CDP connection (chrome-remote-interface); attach to
│   │   │                  # running Chrome (port 9222) or launch headless
│   │   ├── extract.ts     # DOMSnapshot.captureSnapshot → raw DOM + boxes + styles
│   │   ├── tree.ts        # raw truth → compact LayoutTree text format
│   │   ├── explain.ts     # CSS.getMatchedStylesForNode → cascade trace to
│   │   │                  # source file:line (source-map aware)
│   │   ├── invariants.ts  # always-a-bug checks
│   │   └── snapshot.ts    # save / structural diff of LayoutTrees
│   ├── mcp.ts             # thin MCP server (stdio) over core
│   └── cli.ts             # thin CLI over core (same code paths)
├── fixtures/              # HTML/CSS pages with planted bugs + expected.json
└── test/                  # asserts core output against fixtures
```

- TypeScript / Node.
- Runtime dependencies: `chrome-remote-interface` and the MCP SDK only.
  No Playwright/Puppeteer.
- One bulk `DOMSnapshot.captureSnapshot` per extraction (single round trip);
  per-element cascade traces are lazy, on demand.

**Live data flow:** dev server renders → agent calls MCP tool → core pulls
truth over CDP → compresses to LayoutTree → agent edits CSS → HMR reloads →
agent calls `diff`/`layout` again and sees the actual effect of its change in
numbers.

## The LayoutTree format

One line per rendered element, indentation = hierarchy, layout-relevant facts
only:

```
body (0,0 1440x2380) ⚠H-OVERFLOW:+64px
  header#top (0,0 1440x64) flex row gap:16 pad:0,24
    img.logo (24,12 40x40)
    nav (1100,20 316x24) flex row gap:24
  main (0,64 1440x1200) grid cols:240,1fr
    aside.sidebar (0,64 240x1200)
    section.content (240,64 1200x1200) pad:32 ⚠CLIP: h3 "Latest upda…" truncated
      div.card ×6 (grid-item ~380x220 gap:20)
```

Format rules:

- Geometry always: `(x,y WxH)`. Layout mode + child-shaping properties
  (`flex row gap:16`, `grid cols:240,1fr`). Padding/margin only when nonzero.
- Repeated siblings collapse (`div.card ×6`); a deviant sibling gets its own
  line with the delta (`div.card[4] … ⚠ 2px taller than siblings`).
- Warnings inline where they occur (`⚠H-OVERFLOW`, `⚠CLIP`, `⚠OVERLAP:nav`).
- No computed-style dumps in the tree (no colors/fonts/transitions) — fetched
  per element via `inspect` only when needed. Full page ≈ 2–4k tokens.
- **Deterministic:** same render → byte-identical text. This is what makes the
  format diffable and snapshot-able.

## Tools (MCP) / commands (CLI)

| Tool | Input | Output |
|------|-------|--------|
| `layout` | url, selector?, depth? | LayoutTree text, scoped/truncated as asked |
| `inspect` | url, selector | One element in full: box model, non-default computed styles, stacking context, why it is this size |
| `explain` | url, selector, property | Cascade trace: winning rule → file:line (source-mapped), the rules it beat and why (specificity / order / importance), inherited vs set |
| `check` | url | Invariant violations: element, numbers, suspect source rule |
| `snapshot` | url, name | Lock current LayoutTree to a `.tree` file |
| `diff` | url, name | Structural diff vs snapshot, with causes |

CLI mirrors: `bettercss layout|inspect|explain|check|snapshot|diff <url> [args]`.

Example `explain` output:

```
.sidebar width = 240px
  ✓ grid-template-columns: 240px 1fr   main.css:18 (parent grid, col 1)
  ✗ width: 300px                       sidebar.css:4 — ignored: grid item, column sizes win
  ✗ width: 100%                        reset.css:12 — lost: lower specificity (0,0,1 vs 0,1,0)
```

## Invariants (v1 — always-a-bug, zero config)

1. Horizontal overflow of viewport (unintended scrollbar)
2. Text clipped/truncated without `text-overflow` opt-in
3. Visible elements overlapping unintentionally: boxes intersect, neither is
   an ancestor of the other, and neither element (nor an ancestor up to their
   common parent) opts into layering via a non-static `position` (with or
   without `z-index`), negative margins, or transforms
4. Zero-size or off-screen elements that are visible + interactive
5. Element overflows its parent's padding box (content bleeding)
6. Tap targets under 24px on interactive elements

Each violation reports element, numbers (`overflows by 64px`), and suspect rule
via the cascade machinery. Escape hatch: `data-bettercss-ignore` attribute on
an element. No config file.

## Snapshots / diff

- `.tree` files live in the project (like `__snapshots__`).
- Diff is structural, not textual: parses both trees, reports moves / resizes /
  appears / disappears with deltas, then runs `explain` on changed elements to
  name the causing rule.
- Content-only changes (text swapped, same box) ignored by default.

Example diff line:
`nav moved (1100→1084,20), cause: header pad 24→32 @ app.css:12`

## Error handling (lean)

- Chrome unreachable → one clear message with the exact
  `--remote-debugging-port=9222` launch command.
- Selector matches nothing → say so; suggest nearest matches from the tree.
- Page still loading → wait for network-idle, 10 s cap, then extract anyway
  and note the page was still busy.
- No retry frameworks, no config.

## Testing

- Every fixture = a page with a planted bug + `expected.json` (what `check`
  must find, what `layout` must contain).
- `npm test` launches headless Chrome, runs core against all fixtures, asserts
  exact findings.
- v1 fixtures (~10): one per invariant (6), a cascade-tracing fixture (three
  competing `width` rules), a source-map fixture (Tailwind-built page), a
  snapshot-diff fixture, and a sibling-collapse/deviant fixture.

## Out of scope for v1

Animations/transition timing, cross-browser engines, automatic multi-viewport
matrices (a viewport size can be passed to any tool), accessibility auditing
beyond tap targets, AI-side heuristics — the tool reports facts only.

## Success criteria

An agent, given only this tool's output (no screenshots), can:
1. Detect every planted bug in the fixture suite (`check`).
2. Name the source rule to edit for each (`explain`).
3. Verify its fix by re-running and seeing the violation gone (`diff`/`check`).
