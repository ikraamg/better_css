---
name: csstruth
description: Ground-truth CSS/layout workflow using the csstruth MCP tools (mcp__csstruth__*) or CLI. Use whenever working on CSS, layout, styling, responsive design, or visual bugs in a web project with a reachable page (dev server or file over HTTP) — diagnosing why an element renders wrong, making CSS changes safely, or verifying frontend work before calling it done. Triggers: "fix this layout", "why is this element X wide", "the sidebar/nav/card looks wrong", "make it responsive", editing any .css/.scss/tailwind classes, or declaring CSS work complete.
---

# csstruth: CSS ground truth for agents

csstruth extracts the browser's ACTUAL rendered layout as deterministic text.
Eleven tools — six inspectors, one composite verdict (`verify`), one baseline
writer (`baseline`), one load-time stability report (`stability`) — as MCP
tools (`mcp__csstruth__*`) or the `csstruth` CLI.

## The one hard rule

Never claim anything about what renders without reading it from csstruth.
No guessing from source, no "this should now be centered". Diagnose with the
tool, edit the source, re-verify with the tool.

## Workflow

**1. Before touching any CSS on a working page — lock the good state:**
`snapshot` with a `name` and an ABSOLUTE `dir` (e.g. `<project>/.csstruth`).
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
(`csstruth watch <url>`, no MCP tool — a streaming daemon doesn't fit
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
`data-csstruth-ignore` to that element rather than arguing with the check.

## Adopting on a page that isn't clean yet — baselines

`verify`'s all-or-nothing `VERDICT: FAIL` is useless for confirming a
targeted fix when the page has standing, known-benign violations, and it
blocks `verify` from ever gating CI on a page that isn't already fully clean.
Don't hand-diff violation lists — baseline them:

1. `baseline` once, with the SAME `viewports`/`hover`/etc. you'll pass to
   `verify` later: writes a sorted, diff-friendly file of the current
   violation set (a `.csstruth-baseline` path is a reasonable default).
2. From then on pass `baseline` (the file path) to `check`/`verify`. Already-
   accepted violations collapse to `baseline: N accepted violations
   unchanged`; only violations NOT in the file are itemized and drive the
   verdict/exit — this is what "confirm my fix didn't break anything else on
   an otherwise-messy page" actually needs. Anything RESOLVED (was in the
   file, gone now) is itemized as `resolved: <rule> <selector>` — report the
   win, don't bury it in a clean re-baseline.
3. After intentionally fixing or accepting a batch, pass `updateBaseline: true`
   alongside `baseline` on that run to rewrite the file to the current set;
   the output names what was added/removed. Commit the updated file — it's a
   small, reviewable diff, not a blob.

A baseline's viewport labeling must match what it's compared against:
capture and compare with the same `viewports` (or neither side passes it).
Without `baseline`, `check`/`verify` behave exactly as before.

## Mobile emulation

Any viewport ≤500px wide (the default sweep's 375 leg included) renders as a
real phone: `mobile: true`, `deviceScaleFactor: 2`, touch enabled — not a
desktop window squeezed narrow. So `<meta viewport>` fallback, coarse-pointer/
hover media queries, and touch feature detection all behave as they do on a
phone. Reported geometry stays in CSS px regardless of DPR, so a static page's
boxes are unchanged from before — only genuinely mobile-specific rendering
differs (a page missing `<meta name=viewport>` renders at the ~980px desktop
fallback, exactly as a real phone would). Pass the CLI `--desktop-only` flag to
force the old squeezed-desktop emulation (`mobile: false`, DPR 1) everywhere.

## Chrome

Tools launch their own isolated headless Chrome by default (they won't touch a
browser you have open). For logged-in/app-state pages, run Chrome with
`--remote-debugging-port=9222` and pass the CLI `--attach` flag; the MCP tools
are always isolated.
