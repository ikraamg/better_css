# bettercss

[![test](https://github.com/ikraamg/better_css/actions/workflows/test.yml/badge.svg)](https://github.com/ikraamg/better_css/actions/workflows/test.yml)

**Hard ground truth for CSS.** bettercss extracts the browser's *actual*
rendered layout — positions, boxes, the cascade — as deterministic, diffable
text, so coding agents (and humans) stop guessing what rendered.

Backend code gets real feedback: tests fail, APIs return status codes,
databases have state. CSS gets… pixels and vibes. Screenshot diffing is fuzzy
and nondeterministic; poking DevTools by hand is slow and unrepeatable.
bettercss gives layout the "backend treatment": structured truth you can
assert against, byte-identical across runs, with every violation traced to the
source rule that caused it.

```
$ bettercss verify http://localhost:3000
VERDICT: PASS
checked 3 viewports: 375x800=clean, 768x800=clean, 1280x800=clean
```

```
$ bettercss check http://localhost:3000 --hover .cta
parent-bleed: a.cta bleeds 100px outside div.rail (child 400px wide, parent 300px)
  suspect: width: 400px @ main.css:4
```

```
$ bettercss explain http://localhost:3000 --selector .sidebar --property width
.sidebar width = 240px
  ✓ width: 300px   sidebar.css:1 (.sidebar (0,1,0)) — computed 240px differs from
      declared 300px — constrained by max-width: 240px @ main.css:1
  ✗ width: 100%    reset.css:1 (div (0,0,1)) — lost: lower specificity (0,0,1) vs (0,1,0)
```

## How it works

Chromium's DevTools Protocol exposes everything DevTools itself knows: one bulk
`DOMSnapshot` call returns the full DOM with layout boxes and computed styles;
`CSS.getMatchedStylesForNode` returns the complete cascade for any element —
every rule that matched, its specificity, and the stylesheet position it came
from (source-mapped back through your build). bettercss packages that truth
into eight composable tools instead of megabytes of protocol JSON.

The core representation is the **LayoutTree**: one line per rendered element,
deterministic (same render → byte-identical text), with warnings inline:

```
body (0,0 1280x623)
  header#top (0,0 1280x64) flex row pad:0,24
    span.logo (24,25 55x15)
    nav (964,13 292x39) flex row gap:8
  main (0,95 1280x480) flex row
    aside.sidebar (0,95 240x480) pad:16
    section.content (240,95 1040x480) pad:24
      div.card ×6 (~317x140)
```

Deterministic text is what makes layout *diffable* — "did my CSS change break
anything?" becomes a structural diff with exact px deltas, not a flaky
screenshot comparison.

## The tools

| Tool | What it answers |
|------|-----------------|
| `verify` | **"Is this OK?"** — one call: invariants across a viewport sweep (default 375/768/1280) + optional snapshot diffs. First line is always `VERDICT: PASS` or `VERDICT: FAIL (…)`. |
| `check` | Layout-bug scan: viewport overflow, visible parent bleed, clipped text, unintended overlap, zero-size/tiny tap targets — exact px + the suspect rule at `file:line`. |
| `layout` | The LayoutTree of the rendered page (scope with `selector`/`depth`; auto-budgeted on huge pages). |
| `inspect` | One element in depth: box model, non-default styles, stacking context, why it has its width/height. |
| `explain` | Trace any property to its source: which declaration wins (`file:line`, source-mapped), which lost and why, and what layout constraint overrides the declared value (flex-basis, min/max, grid). |
| `snapshot` | Lock the current layout to a named `.tree` file (per-viewport with `--viewports`). |
| `diff` | Structural diff vs a snapshot: what moved/resized/appeared/disappeared, in px. |
| `stability` | Load-time layout-shift report (Cumulative Layout Shift): what moved, when, and by how much, plus unsized `img`/`video` suspects. Timing-dependent (an observation, not a deterministic snapshot). |

**Interaction states:** pass `--hover/--focus/--active <selector>` (CLI) or the
matching params (MCP) to force pseudo-states without a mouse — combinable with
`--viewports`, because hover effects that fit at desktop routinely bleed at
mobile widths.

**Violations are designed to be real bugs.** The invariants are tuned against
real-world pages (intentional overlays, carousels, SVG internals, and
scroll-managed content are exempt). For a genuinely intentional pattern, put
`data-bettercss-ignore` on the element.

## Install

```bash
git clone https://github.com/ikraamg/better_css.git
cd better_css
npm install && npm run build
```

Requires Node ≥ 20 and Chrome/Chromium. bettercss attaches to a running Chrome
at port 9222 (`--remote-debugging-port=9222` — useful for logged-in pages),
otherwise it launches its own headless instance.

## Use as an MCP server (the agent loop)

```bash
claude mcp add --scope user bettercss -- node /path/to/better_css/dist/mcp.js
```

or per-project in `.mcp.json`:

```json
{
  "mcpServers": {
    "bettercss": { "command": "node", "args": ["/path/to/better_css/dist/mcp.js"] }
  }
}
```

The agent loop this enables: dev server renders → agent reads `layout` →
edits CSS → `diff` shows the actual effect in px → `verify` gates "done".

Note: `snapshot`/`diff` resolve a relative `dir` (default `.bettercss`) against
the MCP **server's** working directory. With a globally-registered server, pass
an absolute `dir`.

## Use from the CLI (CI / scripts)

```bash
bettercss verify  http://localhost:3000                  # the one-call gate, exit 1 on FAIL
bettercss check   http://localhost:3000 --viewports 375x800,1280x800
bettercss layout  http://localhost:3000 --selector main
bettercss explain http://localhost:3000 --selector .sidebar --property width
bettercss snapshot http://localhost:3000 --name home --dir .bettercss
bettercss diff     http://localhost:3000 --name home --dir .bettercss
```

`check`/`verify` exit 1 on violations — drop them straight into CI.

## Claude Code skill

`skills/bettercss/SKILL.md` encodes the working doctrine (snapshot before
editing, `explain` before touching a cascade you didn't write, `diff` after
every edit, `verify` before done). Install it user-wide:

```bash
cp -r skills/bettercss ~/.claude/skills/
```

## Development

```bash
npm run typecheck   # strict TS over src + test
npm test            # 111 tests against real headless Chrome — fixture pages with planted bugs
npm run build       # emits dist/
```

Every fixture in `fixtures/` is a page with a deliberately planted layout bug
(or a deliberately clean control); the tests assert bettercss finds exactly
what was planted. The design docs and per-release plans live in
`docs/superpowers/`.

## Limitations

Chromium-only (CDP is the only engine API exposing the full cascade with
source positions). Static layout truth — no animation timing. Framed content
(iframes) is not walked. Heuristic ceilings are commented in the source where
they live.

## License

[MIT](LICENSE)
