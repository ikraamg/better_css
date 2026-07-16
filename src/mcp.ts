#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { DEFAULT_SWEEP, pageWasBusy, parseViewport, parseViewportList, shutdownChrome, withPage } from './core/connect.js'
import { extract } from './core/extract.js'
import { buildTree, findNode, renderTree } from './core/tree.js'
import { checkInvariants, renderViolations } from './core/invariants.js'
import { explain, renderExplanation } from './core/explain.js'
import { inspect } from './core/inspect.js'
import { diffTrees, loadSnapshot, renderDiff, saveSnapshot } from './core/snapshot.js'
import { checkMatrix, diffMatrix, snapshotMatrix } from './core/matrix.js'
import { verifyMatrix } from './core/verify.js'
import { forcePseudoStates, type PseudoStates } from './core/state.js'
import { assertNoInteractNavigation, hasInteractSteps, interactWasUnsettled, runInteractSteps, type InteractSteps } from './core/interact.js'
import { animateNote, needsAnimationCapture, settleAnimations, type AnimateOpts } from './core/animate.js'
import { measureStability, renderStability } from './core/stability.js'

const server = new McpServer({ name: 'bettercss', version: '0.1.0' })

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const url = z.string().describe('Page URL (usually your dev server)')
const port = z.number().optional().describe('Chrome debugging port (default: 9222 or auto-launched headless)')
const viewport = z.string().optional().describe('Emulated viewport size as WxH, e.g. 1280x800 (default: 1280x800)')
const viewports = z.string().optional().describe('Comma-separated WxH list, e.g. "600x800,1280x800" — runs once per viewport, prefixing each output line with [WxH] (check/snapshot/diff only; overrides viewport when given)')
// see the layout consequences of interaction states without a mouse — layout/inspect/explain/check only,
// not snapshot/diff (forced-state snapshots invite stale-state confusion)
const hover = z.string().optional().describe('Force :hover on this selector before reading the page')
const focus = z.string().optional().describe('Force :focus on this selector before reading the page')
const active = z.string().optional().describe('Force :active on this selector before reading the page')
// interaction pre-steps — layout/inspect/explain/check/verify only, not snapshot/diff (same
// stale-state reasoning as hover/focus/active). Order: scrollTo, then click(s) in array
// order, then a settle wait, then hover/focus/active, then capture.
const click = z.array(z.string()).optional().describe('Real trusted click(s) on these selectors, in order, before reading the page. Each target is first scrolled into view (centered) and the scroll is left where it lands. Runs after scrollTo and before hover/focus/active. Aborts if a click navigates to a new page.')
const scrollTo = z.string().optional().describe('Scroll to this selector (scrollIntoView) or pixel Y before reading the page. Runs before click(s).')
// --settled/--at-time — layout/inspect/explain/check/verify get both; snapshot/diff get
// settled ONLY (a specific animation frame isn't a deterministic snapshot). Runs after
// interact steps and before hover/focus/active.
const settled = z.boolean().optional().describe('Fast-forward every CSS transition/animation to its end state before reading the page. A perpetual animation (e.g. a spinner) can\'t end, so it\'s pinned to its start (t=0) for determinism, with a note. Recommended when the page has animations, for a deterministic read. Mutually exclusive with atTime.')
const atTime = z.number().optional().describe('Seek every animation to this many ms (instead of its end), clamped to each animation\'s own full duration (delay + duration x iterations). Mutually exclusive with settled.')

// snapshot/diff/stability don't support some of the params above — declared here as
// optional (not omitted) so a schema-driven agent can see the param exists and read why
// it's refused, instead of it silently vanishing (the old behavior: these tools never
// declared them, so the zod shape just dropped anything unknown). The handlers below
// throw the CLI's exact rejection wording for the same case.
const rejectedStr = (why: string) => z.string().optional().describe(`NOT supported here — ${why} Declared so you can see it exists; passing it throws.`)
const rejectedArr = (why: string) => z.array(z.string()).optional().describe(`NOT supported here — ${why} Declared so you can see it exists; passing it throws.`)
const rejectedBool = (why: string) => z.boolean().optional().describe(`NOT supported here — ${why} Declared so you can see it exists; passing it throws.`)
const rejectedNum = (why: string) => z.number().optional().describe(`NOT supported here — ${why} Declared so you can see it exists; passing it throws.`)

const STALE_STATE = 'forced/interacted-state captures invite stale-state confusion; use layout/inspect/explain/check/verify.'
const NOT_A_SNAPSHOT = 'a snapshot must be a deterministic capture, not one pinned to a specific animation frame; use settled instead.'
const STABILITY_SCOPE = 'it observes one natural page load (no animation seeking, no viewport matrix).'

// Throws the CLI's exact wording (cli.ts's stateFlags/hasInteractSteps checks) for one
// consistent error surface across both front ends.
function rejectStateAndInteract(
  tool: string, args: { hover?: string; focus?: string; active?: string; click?: string[]; scrollTo?: string },
): void {
  const stateFlag = (['hover', 'focus', 'active'] as const).find((k) => args[k] !== undefined)
  if (stateFlag) throw new Error(`--${stateFlag} is only valid for layout/inspect/explain/check/verify, not ${tool} — forced-state snapshots invite stale-state confusion.`)
  if ((args.click?.length ?? 0) > 0 || args.scrollTo !== undefined) {
    throw new Error(`--click/--scroll-to are only valid for layout/inspect/explain/check/verify, not ${tool} — interacted-state snapshots invite stale-state confusion.`)
  }
}

function page(
  u: string,
  opts: { port?: number; viewport?: string; states?: PseudoStates; interact?: InteractSteps; animate?: AnimateOpts },
  fn: (client: any) => Promise<string>,
) {
  return withPage(u, async (client) => {
    await runInteractSteps(client, opts.interact ?? {})
    await settleAnimations(client, opts.animate ?? {})
    if (opts.states) await forcePseudoStates(client, opts.states)
    let out = await fn(client)
    // A click's delayed redirect can land during fn's capture, after runInteractSteps
    // already returned clean — check again now (see interact.ts).
    assertNoInteractNavigation(client)
    if (pageWasBusy(client)) out += '\nnote: page was still loading at the 10s cap; results may be early'
    if (interactWasUnsettled(client)) out += '\nnote: page had not settled after interactions'
    return text(out + animateNote(client))
  }, {
    port: opts.port, viewport: opts.viewport ? parseViewport(opts.viewport) : undefined,
    captureAnimations: needsAnimationCapture(opts.animate ?? {}),
  })
}

server.tool('layout', 'Compact deterministic layout tree of the rendered page: positions, sizes, layout modes, inline ⚠ warnings. THE ground-truth view — read this before and after CSS changes. Budgeted to 400 lines by default (auto-truncated to the deepest depth that fits, with a note); pass depth to see the full tree from the root, or selector to scope to a subtree. Pass scrollTo/click to interact with the page first (order: scrollTo, then click(s), then settle), then settled/atTime to fast-forward or seek animations, then hover/focus/active to see the layout consequences of interaction states without a mouse.',
  { url, port, viewport, selector: z.string().optional().describe('Scope to this element'), depth: z.number().optional().describe('Max tree depth (disables the default 400-line budget)'), hover, focus, active, click, scrollTo, settled, atTime },
  ({ url: u, port: p, viewport: v, selector, depth, hover: h, focus: fo, active: a, click: cl, scrollTo: st, settled: se, atTime: at }) => page(u, { port: p, viewport: v, states: { hover: h, focus: fo, active: a }, interact: { click: cl, scrollTo: st }, animate: { settled: se, atTime: at } }, async (client) => {
    const tree = buildTree(await extract(client))
    checkInvariants(tree)
    const from = selector ? findNode(tree, selector) : undefined
    if (selector && !from) return `No element matching '${selector}' in the layout tree. Run layout without a selector to see what exists.`
    return renderTree(tree, { depth, from, budget: depth === undefined ? 400 : undefined })
  }))

server.tool('inspect', 'Deep-dive ONE element: box model, every non-default computed style, stacking context, and why it has its width/height. Pass scrollTo/click to interact with the page first (order: scrollTo, then click(s), then settle), then settled/atTime to fast-forward or seek animations, then hover/focus/active to see the layout consequences of interaction states without a mouse.',
  { url, port, viewport, selector: z.string().describe('CSS selector of the element'), hover, focus, active, click, scrollTo, settled, atTime },
  ({ url: u, port: p, viewport: v, selector, hover: h, focus: fo, active: a, click: cl, scrollTo: st, settled: se, atTime: at }) => page(u, { port: p, viewport: v, states: { hover: h, focus: fo, active: a }, interact: { click: cl, scrollTo: st }, animate: { settled: se, atTime: at } }, (client) => inspect(client, selector)))

server.tool('explain', 'Trace one CSS property to its source: which rule wins (file:line, source-mapped), which rules lost and why (specificity/order/importance), and whether layout constraints override the declared value. Pass scrollTo/click to interact with the page first (order: scrollTo, then click(s), then settle), then settled/atTime to fast-forward or seek animations, then hover/focus/active to see the layout consequences of interaction states without a mouse.',
  { url, port, viewport, selector: z.string(), property: z.string().describe("e.g. 'width'"), hover, focus, active, click, scrollTo, settled, atTime },
  ({ url: u, port: p, viewport: v, selector, property, hover: h, focus: fo, active: a, click: cl, scrollTo: st, settled: se, atTime: at }) => page(u, { port: p, viewport: v, states: { hover: h, focus: fo, active: a }, interact: { click: cl, scrollTo: st }, animate: { settled: se, atTime: at } }, async (client) =>
    renderExplanation(await explain(client, selector, property))))

server.tool('check', 'Run layout invariants (overflow, bleed, clipped text, unintended overlap, zero-size/tiny interactive elements). Violations are ALWAYS bugs — fix them. Pass scrollTo/click to interact with the page first (order: scrollTo, then click(s), then settle), then settled/atTime to fast-forward or seek animations, then hover/focus/active to see the layout consequences of interaction states without a mouse — combinable with viewports, re-running scrollTo/click(s)/settled/state fresh inside each one.',
  { url, port, viewport, viewports, hover, focus, active, click, scrollTo, settled, atTime },
  ({ url: u, port: p, viewport: v, viewports: vs, hover: h, focus: fo, active: a, click: cl, scrollTo: st, settled: se, atTime: at }) => vs
    ? checkMatrix(u, parseViewportList(vs), { port: p, states: { hover: h, focus: fo, active: a }, interact: { click: cl, scrollTo: st }, animate: { settled: se, atTime: at } }).then((r) => text(r.output))
    : page(u, { port: p, viewport: v, states: { hover: h, focus: fo, active: a }, interact: { click: cl, scrollTo: st }, animate: { settled: se, atTime: at } }, async (client) => {
      const violations = checkInvariants(buildTree(await extract(client)))
      return renderViolations(client, violations)
    }))

server.tool('snapshot', 'Lock the current layout as a named .tree snapshot for later diffing. Do this when the page looks CORRECT. Pass settled (recommended for animated pages, for a deterministic snapshot). atTime is NOT supported here — a specific animation frame pinned by hand is not a reproducible baseline; use layout/check with atTime to inspect mid-animation states instead.',
  {
    url, port, viewport, viewports, name: z.string(), dir: z.string().optional().describe("Snapshot dir (default .bettercss relative to the MCP server's working directory — pass an absolute path when the server isn't launched from your project root)"), settled,
    hover: rejectedStr(STALE_STATE), focus: rejectedStr(STALE_STATE), active: rejectedStr(STALE_STATE),
    click: rejectedArr(STALE_STATE), scrollTo: rejectedStr(STALE_STATE), atTime: rejectedNum(NOT_A_SNAPSHOT),
  },
  ({ url: u, port: p, viewport: v, viewports: vs, name, dir, settled: se, hover: h, focus: fo, active: a, click: cl, scrollTo: st, atTime: at }) => {
    rejectStateAndInteract('snapshot', { hover: h, focus: fo, active: a, click: cl, scrollTo: st })
    if (at !== undefined) throw new Error(`--at-time is not valid for snapshot — ${NOT_A_SNAPSHOT}`)
    return vs
      ? snapshotMatrix(u, parseViewportList(vs), name, dir, { port: p, settled: se }).then((s) => text(s))
      : page(u, { port: p, viewport: v, animate: { settled: se } }, async (client) => {
        const tree = buildTree(await extract(client))
        checkInvariants(tree)
        return `saved ${saveSnapshot(renderTree(tree), name, dir)}`
      })
  })

server.tool('diff', 'Structural diff of the current layout vs a named snapshot: what moved/resized/appeared/disappeared, in px. Run after every CSS change to see its actual effect. Pass settled (recommended for animated pages, matching how the snapshot was likely taken). atTime is NOT supported here — a specific animation frame pinned by hand is not a reproducible baseline; use layout/check with atTime to inspect mid-animation states instead.',
  {
    url, port, viewport, viewports, name: z.string(), dir: z.string().optional().describe("Snapshot dir (default .bettercss relative to the MCP server's working directory — pass an absolute path when the server isn't launched from your project root)"), settled,
    hover: rejectedStr(STALE_STATE), focus: rejectedStr(STALE_STATE), active: rejectedStr(STALE_STATE),
    click: rejectedArr(STALE_STATE), scrollTo: rejectedStr(STALE_STATE), atTime: rejectedNum(NOT_A_SNAPSHOT),
  },
  ({ url: u, port: p, viewport: v, viewports: vs, name, dir, settled: se, hover: h, focus: fo, active: a, click: cl, scrollTo: st, atTime: at }) => {
    rejectStateAndInteract('diff', { hover: h, focus: fo, active: a, click: cl, scrollTo: st })
    if (at !== undefined) throw new Error(`--at-time is not valid for diff — ${NOT_A_SNAPSHOT}`)
    return vs
      ? diffMatrix(u, parseViewportList(vs), name, dir, { port: p, settled: se }).then((s) => text(s))
      : page(u, { port: p, viewport: v, animate: { settled: se } }, async (client) => {
        const tree = buildTree(await extract(client))
        checkInvariants(tree)
        return renderDiff(diffTrees(loadSnapshot(name, dir), renderTree(tree)))
      })
  })

server.tool('verify', `Composite one-shot "is this page correct": runs layout invariants and, if a name is given, also diffs a locked snapshot — across a viewport sweep, in a single call. FIRST line of the output is always VERDICT: PASS or VERDICT: FAIL (violations + layout changes), so you can branch on line 1 without parsing details. Defaults to the ${DEFAULT_SWEEP} sweep when viewports is omitted — verify always runs as a matrix, even with one viewport, so snapshot files are always named <name>@WxH (never plain <name>.tree). Pass scrollTo/click to interact with the page first (order: scrollTo, then click(s), then settle), then settled/atTime to fast-forward or seek animations, then hover/focus/active to see the layout consequences of interaction states without a mouse. settled is RECOMMENDED whenever the page has animations — the default behavior is unchanged (no seeking) otherwise. IMPORTANT: states, interact steps, and atTime affect the invariant check only — the snapshot diff always compares the resting (unforced, un-interacted, not-pinned-to-a-frame) layout, applying settled if given (since diffing a forced/interacted layout against a resting snapshot would always report a change); this costs a second page load per viewport when states/interact are combined with name. A missing per-viewport snapshot is reported as a note, not a failure (snapshot only the viewports you care about).`,
  { url, port, viewports, hover, focus, active, click, scrollTo, settled, atTime, name: z.string().optional(), dir: z.string().optional().describe("Snapshot dir (default .bettercss relative to the MCP server's working directory — pass an absolute path when the server isn't launched from your project root)") },
  ({ url: u, port: p, viewports: vs, hover: h, focus: fo, active: a, click: cl, scrollTo: st, settled: se, atTime: at, name, dir }) => {
    const hasStates = h !== undefined || fo !== undefined || a !== undefined
    const interact: InteractSteps = { click: cl, scrollTo: st }
    const animate: AnimateOpts = { settled: se, atTime: at }
    return verifyMatrix(u, parseViewportList(vs ?? DEFAULT_SWEEP), {
      port: p, states: hasStates ? { hover: h, focus: fo, active: a } : undefined,
      interact: hasInteractSteps(interact) ? interact : undefined,
      animate: needsAnimationCapture(animate) ? animate : undefined, name, dir,
    }).then((r) => text(r.output))
  })

server.tool('stability', 'Load-time layout-shift report (Cumulative Layout Shift): waits `duration` ms (default 3000) past load, then reports every shift — timing, the moved element\'s selector, its before/after box, and its score — plus any img/video shift source missing width/height attributes (the #1 CLS cause). First line is always STABILITY: <score> (threshold <t>). Score is the raw sum over the observation window; the CWV metric uses session windows — multi-burst pages may score higher here. TIMING-DEPENDENT: this is an OBSERVATION, not a deterministic snapshot — local dev servers under-report; throttle CPU/network to reproduce production shifts. No interact/state/settled params (out of scope) or viewports (single viewport only).',
  {
    url, port, viewport, duration: z.number().optional().describe('Milliseconds to observe past load before collecting shifts (default 3000)'), threshold: z.number().optional().describe('Score above which this is reported as unstable (default 0.1, the Core Web Vitals "good" boundary)'),
    hover: rejectedStr(STALE_STATE), focus: rejectedStr(STALE_STATE), active: rejectedStr(STALE_STATE),
    click: rejectedArr(STALE_STATE), scrollTo: rejectedStr(STALE_STATE),
    settled: rejectedBool(STABILITY_SCOPE), atTime: rejectedNum(STABILITY_SCOPE), viewports: rejectedStr(STABILITY_SCOPE),
  },
  ({ url: u, port: p, viewport: v, duration, threshold, hover: h, focus: fo, active: a, click: cl, scrollTo: st, settled: se, atTime: at, viewports: vs }) => {
    rejectStateAndInteract('stability', { hover: h, focus: fo, active: a, click: cl, scrollTo: st })
    for (const [flag, val] of [['settled', se], ['at-time', at], ['viewports', vs]] as const) {
      if (val !== undefined) throw new Error(`--${flag} is not valid for stability — ${STABILITY_SCOPE}`)
    }
    return measureStability(u, { port: p, viewport: v ? parseViewport(v) : undefined, duration, threshold }).then((r) => text(renderStability(r)))
  })

// Every session launches its own headless Chrome + temp profile (src/core/connect.ts);
// without this, exiting the MCP session leaks both. Cover both ways a session ends:
// the host killing us directly, and the client ending our stdio.
async function shutdown(): Promise<void> {
  await shutdownChrome()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

const transport = new StdioServerTransport()
transport.onclose = shutdown
await server.connect(transport)
