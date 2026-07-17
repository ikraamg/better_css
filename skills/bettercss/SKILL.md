---
name: bettercss
description: Ground-truth CSS/layout workflow using the bettercss MCP tools (mcp__bettercss__*) or CLI. Use whenever working on CSS, layout, styling, responsive design, or visual bugs in a web project with a reachable page (dev server or file over HTTP) — diagnosing why an element renders wrong, making CSS changes safely, or verifying frontend work before calling it done. Triggers: "fix this layout", "why is this element X wide", "the sidebar/nav/card looks wrong", "make it responsive", editing any .css/.scss/tailwind classes, or declaring CSS work complete.
---

# bettercss: CSS ground truth for agents

bettercss extracts the browser's ACTUAL rendered layout as deterministic text.
Eight tools — six inspectors, one composite verdict (`verify`), one load-time
stability report (`stability`) — as MCP tools (`mcp__bettercss__*`) or the
`bettercss` CLI.

## The one hard rule

Never claim anything about what renders without reading it from bettercss.
No guessing from source, no "this should now be centered". Diagnose with the
tool, edit the source, re-verify with the tool.

## Workflow

**1. Before touching any CSS on a working page — lock the good state:**
`snapshot` with a `name` and an ABSOLUTE `dir` (e.g. `<project>/.bettercss`).
Relative dirs resolve against the MCP server's cwd, not the project. For
responsive work snapshot with `viewports` so diffs exist per breakpoint.

**2. Diagnose (in this order):**
- `layout` — the whole rendered tree: positions `(x,y WxH)`, flex/grid facts,
  inline `⚠` warnings. Scope with `selector`/`depth` on big pages.
- `inspect` — one element in depth: box model, non-default styles, stacking
  context, why it has its width/height.
- `explain` — REQUIRED before editing any rule you didn't write: which
  declaration wins (file:line, source-mapped), which lost and why, and what
  layout constraint overrides the declared value (flex-basis, min/max, grid).
  Fix the rule explain names — not the first plausible one in the source.

**3. After every edit:** `diff` against your snapshot. It reports exact moves/
resizes in px. `(no layout changes)` + your intended change = success. Unrelated
movement = your edit had side effects; explain them before proceeding.

**Editing for a while? Start `watch` instead of re-running `diff`.** CLI only
(`bettercss watch <url>`, no MCP tool — a streaming daemon doesn't fit
request/response): start it once in a background shell, then read its stream
as you edit instead of re-running `diff`/`check` after every change. It
prints the layout delta and any NEW/RESOLVED violations under a `[HH:MM:SS]`
block on each real change, and stays quiet otherwise — no need to re-invoke a
tool per edit. Stop it (Ctrl+C / kill the background job) when you're done.

**4. Before declaring CSS work done — the gate:**
`verify` (one call). Defaults to the 375x800/768x800/1280x800 sweep; pass
`name`+`dir` to include snapshot diffs. First output line is `VERDICT: PASS`
or `VERDICT: FAIL (...)`. Do not report CSS work complete on a FAIL.
For interactive elements also run with `hover`/`focus` (states apply to the
invariant check; snapshot diffs always compare the resting layout). On pages
with late-loading images, fonts, or ads, also run `stability` — it reports
Cumulative Layout Shift with the exact element that moved, when, and any
unsized `img`/`video` suspect.

## Interaction and animation states

`hover`/`focus`/`active` params (a CSS selector each) force pseudo-state
without a mouse — works on layout/check/inspect/explain/verify, and combines
with `viewports` (hover effects often fit at desktop but bleed at mobile).

For JS-driven UI a pseudo-state can't reach (menus, tabs, anything behind a
click), use `click` (repeatable, real trusted click) and `scrollTo` (selector
or pixel Y) — same tools, run before capture in order: scrollTo → click(s) →
settle.

For animated pages, add `settled` to fast-forward every CSS transition/
animation to its end state before capturing — recommended before
`snapshot`/`diff`/`verify` on anything with a CSS animation, so the capture
isn't a flaky mid-flight frame. `atTime N` seeks to a specific ms instead
(layout/inspect/explain/check/verify only, not snapshot/diff — a specific
frame isn't a reproducible baseline).

## Reading violations

`check`/`verify` violations are tuned to be real bugs: viewport overflow,
visible parent bleed, clipped text, un-layered overlap, zero-size/tiny tap
targets — each with exact px and a `suspect: <rule> @ file:line`. For a
genuinely intentional pattern (animated counters, marquees), add
`data-bettercss-ignore` to that element rather than arguing with the check.

## Chrome

Tools attach to Chrome at port 9222 if running (`--remote-debugging-port=9222`
for logged-in/app-state pages), else launch their own headless Chrome.
