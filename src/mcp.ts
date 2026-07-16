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
import { hasInteractSteps, interactWasUnsettled, runInteractSteps, type InteractSteps } from './core/interact.js'

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

function page(
  u: string,
  opts: { port?: number; viewport?: string; states?: PseudoStates; interact?: InteractSteps },
  fn: (client: any) => Promise<string>,
) {
  return withPage(u, async (client) => {
    await runInteractSteps(client, opts.interact ?? {})
    if (opts.states) await forcePseudoStates(client, opts.states)
    let out = await fn(client)
    if (pageWasBusy(client)) out += '\nnote: page was still loading at the 10s cap; results may be early'
    if (interactWasUnsettled(client)) out += '\nnote: page had not settled after interactions'
    return text(out)
  }, { port: opts.port, viewport: opts.viewport ? parseViewport(opts.viewport) : undefined })
}

server.tool('layout', 'Compact deterministic layout tree of the rendered page: positions, sizes, layout modes, inline ⚠ warnings. THE ground-truth view — read this before and after CSS changes. Budgeted to 400 lines by default (auto-truncated to the deepest depth that fits, with a note); pass depth to see the full tree from the root, or selector to scope to a subtree. Pass scrollTo/click to interact with the page first (order: scrollTo, then click(s), then settle), then hover/focus/active to see the layout consequences of interaction states without a mouse.',
  { url, port, viewport, selector: z.string().optional().describe('Scope to this element'), depth: z.number().optional().describe('Max tree depth (disables the default 400-line budget)'), hover, focus, active, click, scrollTo },
  ({ url: u, port: p, viewport: v, selector, depth, hover: h, focus: fo, active: a, click: cl, scrollTo: st }) => page(u, { port: p, viewport: v, states: { hover: h, focus: fo, active: a }, interact: { click: cl, scrollTo: st } }, async (client) => {
    const tree = buildTree(await extract(client))
    checkInvariants(tree)
    const from = selector ? findNode(tree, selector) : undefined
    if (selector && !from) return `No element matching '${selector}' in the layout tree. Run layout without a selector to see what exists.`
    return renderTree(tree, { depth, from, budget: depth === undefined ? 400 : undefined })
  }))

server.tool('inspect', 'Deep-dive ONE element: box model, every non-default computed style, stacking context, and why it has its width/height. Pass scrollTo/click to interact with the page first (order: scrollTo, then click(s), then settle), then hover/focus/active to see the layout consequences of interaction states without a mouse.',
  { url, port, viewport, selector: z.string().describe('CSS selector of the element'), hover, focus, active, click, scrollTo },
  ({ url: u, port: p, viewport: v, selector, hover: h, focus: fo, active: a, click: cl, scrollTo: st }) => page(u, { port: p, viewport: v, states: { hover: h, focus: fo, active: a }, interact: { click: cl, scrollTo: st } }, (client) => inspect(client, selector)))

server.tool('explain', 'Trace one CSS property to its source: which rule wins (file:line, source-mapped), which rules lost and why (specificity/order/importance), and whether layout constraints override the declared value. Pass scrollTo/click to interact with the page first (order: scrollTo, then click(s), then settle), then hover/focus/active to see the layout consequences of interaction states without a mouse.',
  { url, port, viewport, selector: z.string(), property: z.string().describe("e.g. 'width'"), hover, focus, active, click, scrollTo },
  ({ url: u, port: p, viewport: v, selector, property, hover: h, focus: fo, active: a, click: cl, scrollTo: st }) => page(u, { port: p, viewport: v, states: { hover: h, focus: fo, active: a }, interact: { click: cl, scrollTo: st } }, async (client) =>
    renderExplanation(await explain(client, selector, property))))

server.tool('check', 'Run layout invariants (overflow, bleed, clipped text, unintended overlap, zero-size/tiny interactive elements). Violations are ALWAYS bugs — fix them. Pass scrollTo/click to interact with the page first (order: scrollTo, then click(s), then settle), then hover/focus/active to see the layout consequences of interaction states without a mouse — combinable with viewports, re-running scrollTo/click(s)/state fresh inside each one.',
  { url, port, viewport, viewports, hover, focus, active, click, scrollTo },
  ({ url: u, port: p, viewport: v, viewports: vs, hover: h, focus: fo, active: a, click: cl, scrollTo: st }) => vs
    ? checkMatrix(u, parseViewportList(vs), { port: p, states: { hover: h, focus: fo, active: a }, interact: { click: cl, scrollTo: st } }).then((r) => text(r.output))
    : page(u, { port: p, viewport: v, states: { hover: h, focus: fo, active: a }, interact: { click: cl, scrollTo: st } }, async (client) => {
      const violations = checkInvariants(buildTree(await extract(client)))
      return renderViolations(client, violations)
    }))

server.tool('snapshot', 'Lock the current layout as a named .tree snapshot for later diffing. Do this when the page looks CORRECT.',
  { url, port, viewport, viewports, name: z.string(), dir: z.string().optional().describe("Snapshot dir (default .bettercss relative to the MCP server's working directory — pass an absolute path when the server isn't launched from your project root)") },
  ({ url: u, port: p, viewport: v, viewports: vs, name, dir }) => vs
    ? snapshotMatrix(u, parseViewportList(vs), name, dir, { port: p }).then((s) => text(s))
    : page(u, { port: p, viewport: v }, async (client) => {
      const tree = buildTree(await extract(client))
      checkInvariants(tree)
      return `saved ${saveSnapshot(renderTree(tree), name, dir)}`
    }))

server.tool('diff', 'Structural diff of the current layout vs a named snapshot: what moved/resized/appeared/disappeared, in px. Run after every CSS change to see its actual effect.',
  { url, port, viewport, viewports, name: z.string(), dir: z.string().optional().describe("Snapshot dir (default .bettercss relative to the MCP server's working directory — pass an absolute path when the server isn't launched from your project root)") },
  ({ url: u, port: p, viewport: v, viewports: vs, name, dir }) => vs
    ? diffMatrix(u, parseViewportList(vs), name, dir, { port: p }).then((s) => text(s))
    : page(u, { port: p, viewport: v }, async (client) => {
      const tree = buildTree(await extract(client))
      checkInvariants(tree)
      return renderDiff(diffTrees(loadSnapshot(name, dir), renderTree(tree)))
    }))

server.tool('verify', `Composite one-shot "is this page correct": runs layout invariants and, if a name is given, also diffs a locked snapshot — across a viewport sweep, in a single call. FIRST line of the output is always VERDICT: PASS or VERDICT: FAIL (violations + layout changes), so you can branch on line 1 without parsing details. Defaults to the ${DEFAULT_SWEEP} sweep when viewports is omitted — verify always runs as a matrix, even with one viewport, so snapshot files are always named <name>@WxH (never plain <name>.tree). Pass scrollTo/click to interact with the page first (order: scrollTo, then click(s), then settle), then hover/focus/active to see the layout consequences of interaction states without a mouse. IMPORTANT: states and interact steps affect the invariant check only — the snapshot diff always compares the resting (unforced, un-interacted) layout, since diffing a forced/interacted layout against a resting snapshot would always report a change; this costs a second page load per viewport when either is combined with name. A missing per-viewport snapshot is reported as a note, not a failure (snapshot only the viewports you care about).`,
  { url, port, viewports, hover, focus, active, click, scrollTo, name: z.string().optional(), dir: z.string().optional().describe("Snapshot dir (default .bettercss relative to the MCP server's working directory — pass an absolute path when the server isn't launched from your project root)") },
  ({ url: u, port: p, viewports: vs, hover: h, focus: fo, active: a, click: cl, scrollTo: st, name, dir }) => {
    const hasStates = h !== undefined || fo !== undefined || a !== undefined
    const interact: InteractSteps = { click: cl, scrollTo: st }
    return verifyMatrix(u, parseViewportList(vs ?? DEFAULT_SWEEP), {
      port: p, states: hasStates ? { hover: h, focus: fo, active: a } : undefined,
      interact: hasInteractSteps(interact) ? interact : undefined, name, dir,
    }).then((r) => text(r.output))
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
