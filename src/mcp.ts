#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { pageWasBusy, parseViewport, shutdownChrome, withPage } from './core/connect.js'
import { extract } from './core/extract.js'
import { buildTree, findNode, renderTree } from './core/tree.js'
import { checkInvariants, renderViolations } from './core/invariants.js'
import { explain, renderExplanation } from './core/explain.js'
import { inspect } from './core/inspect.js'
import { diffTrees, loadSnapshot, renderDiff, saveSnapshot } from './core/snapshot.js'

const server = new McpServer({ name: 'bettercss', version: '0.1.0' })

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const url = z.string().describe('Page URL (usually your dev server)')
const port = z.number().optional().describe('Chrome debugging port (default: 9222 or auto-launched headless)')
const viewport = z.string().optional().describe('Emulated viewport size as WxH, e.g. 1280x800 (default: 1280x800)')

function page(
  u: string,
  opts: { port?: number; viewport?: string },
  fn: (client: any) => Promise<string>,
) {
  return withPage(u, async (client) => {
    let out = await fn(client)
    if (pageWasBusy(client)) out += '\nnote: page was still loading at the 10s cap; results may be early'
    return text(out)
  }, { port: opts.port, viewport: opts.viewport ? parseViewport(opts.viewport) : undefined })
}

server.tool('layout', 'Compact deterministic layout tree of the rendered page: positions, sizes, layout modes, inline ⚠ warnings. THE ground-truth view — read this before and after CSS changes. Budgeted to 400 lines by default (auto-truncated to the deepest depth that fits, with a note); pass depth to see the full tree from the root, or selector to scope to a subtree.',
  { url, port, viewport, selector: z.string().optional().describe('Scope to this element'), depth: z.number().optional().describe('Max tree depth (disables the default 400-line budget)') },
  ({ url: u, port: p, viewport: v, selector, depth }) => page(u, { port: p, viewport: v }, async (client) => {
    const tree = buildTree(await extract(client))
    checkInvariants(tree)
    const from = selector ? findNode(tree, selector) : undefined
    if (selector && !from) return `No element matching '${selector}' in the layout tree. Run layout without a selector to see what exists.`
    return renderTree(tree, { depth, from, budget: depth === undefined ? 400 : undefined })
  }))

server.tool('inspect', 'Deep-dive ONE element: box model, every non-default computed style, stacking context, and why it has its width/height.',
  { url, port, viewport, selector: z.string().describe('CSS selector of the element') },
  ({ url: u, port: p, viewport: v, selector }) => page(u, { port: p, viewport: v }, (client) => inspect(client, selector)))

server.tool('explain', 'Trace one CSS property to its source: which rule wins (file:line, source-mapped), which rules lost and why (specificity/order/importance), and whether layout constraints override the declared value.',
  { url, port, viewport, selector: z.string(), property: z.string().describe("e.g. 'width'") },
  ({ url: u, port: p, viewport: v, selector, property }) => page(u, { port: p, viewport: v }, async (client) =>
    renderExplanation(await explain(client, selector, property))))

server.tool('check', 'Run layout invariants (overflow, bleed, clipped text, unintended overlap, zero-size/tiny interactive elements). Violations are ALWAYS bugs — fix them.',
  { url, port, viewport },
  ({ url: u, port: p, viewport: v }) => page(u, { port: p, viewport: v }, async (client) => {
    const violations = checkInvariants(buildTree(await extract(client)))
    return renderViolations(client, violations)
  }))

server.tool('snapshot', 'Lock the current layout as a named .tree snapshot for later diffing. Do this when the page looks CORRECT.',
  { url, port, viewport, name: z.string(), dir: z.string().optional().describe("Snapshot dir (default .bettercss relative to the MCP server's working directory — pass an absolute path when the server isn't launched from your project root)") },
  ({ url: u, port: p, viewport: v, name, dir }) => page(u, { port: p, viewport: v }, async (client) => {
    const tree = buildTree(await extract(client))
    checkInvariants(tree)
    return `saved ${saveSnapshot(renderTree(tree), name, dir)}`
  }))

server.tool('diff', 'Structural diff of the current layout vs a named snapshot: what moved/resized/appeared/disappeared, in px. Run after every CSS change to see its actual effect.',
  { url, port, viewport, name: z.string(), dir: z.string().optional().describe("Snapshot dir (default .bettercss relative to the MCP server's working directory — pass an absolute path when the server isn't launched from your project root)") },
  ({ url: u, port: p, viewport: v, name, dir }) => page(u, { port: p, viewport: v }, async (client) => {
    const tree = buildTree(await extract(client))
    checkInvariants(tree)
    return renderDiff(diffTrees(loadSnapshot(name, dir), renderTree(tree)))
  }))

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
