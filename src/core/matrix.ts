import { forEachViewport, pageWasBusy, type Viewport } from './connect.js'
import { extract } from './extract.js'
import { buildTree, renderTree } from './tree.js'
import { checkInvariants, renderViolations } from './invariants.js'
import { diffTrees, loadSnapshot, renderDiff, saveSnapshot } from './snapshot.js'
import { forcePseudoStates, type PseudoStates } from './state.js'

function prefixLines(label: string, text: string): string {
  return text.split('\n').map((line) => `[${label}] ${line}`).join('\n')
}

// Matrix paths bypass mcp.ts's page() wrapper, so mirror its busy note here —
// same wording, appended per viewport (each viewport gets its own 10s cap).
function busyNote(client: object): string {
  return pageWasBusy(client) ? '\nnote: page was still loading at the 10s cap; results may be early' : ''
}

// check, once per viewport (sequential, input order). Exit-worthiness (`dirty`) is any
// viewport with violations; groups stay per-viewport since each renderViolations call
// only ever sees its own viewport's violations.
//
// States force per-viewport, after navigation and before extraction: each viewport gets
// its own withPage/client (forEachViewport), so nodeIds aren't shared across viewports —
// forcePseudoStates re-resolves the selector fresh on every call, which is exactly why
// v5's forcing helper works unmodified here (see src/core/state.ts). forEachViewport awaits
// viewports sequentially, so an unresolvable selector throws out of the FIRST viewport that
// can't find it — later viewports never run. DOM.querySelector (resolveNode) matches
// display:none nodes too, so a selector that exists in the DOM at one viewport but not
// another only happens with JS-conditional DOM; static fixtures never hit that case, so a
// selector matching zero DOM nodes anywhere is always the actual error.
export async function checkMatrix(
  url: string, viewports: Viewport[], opts: { port?: number; states?: PseudoStates },
): Promise<{ output: string; dirty: boolean }> {
  const results = await forEachViewport(url, viewports, async (client) => {
    if (opts.states) await forcePseudoStates(client, opts.states)
    const violations = checkInvariants(buildTree(await extract(client)))
    return { violations, rendered: (await renderViolations(client, violations)) + busyNote(client) }
  }, opts)
  const body = results.map((r) => prefixLines(r.label, r.result.rendered)).join('\n')
  const summary = results
    .map((r) => `${r.label}=${r.result.violations.length ? `${r.result.violations.length} violations` : 'clean'}`)
    .join(', ')
  const dirty = results.some((r) => r.result.violations.length > 0)
  return { output: `${body}\nchecked ${results.length} viewports: ${summary}`, dirty }
}

// snapshot, once per viewport → `<name>@WxH.tree` per file (plain saveSnapshot naming,
// no snapshot.ts changes needed).
export async function snapshotMatrix(
  url: string, viewports: Viewport[], name: string, dir: string | undefined, opts: { port?: number },
): Promise<string> {
  const results = await forEachViewport(url, viewports, async (client, vp) => {
    const tree = buildTree(await extract(client))
    checkInvariants(tree)
    return `saved ${saveSnapshot(renderTree(tree), `${name}@${vp.label}`, dir)}${busyNote(client)}`
  }, opts)
  return results.map((r) => prefixLines(r.label, r.result)).join('\n')
}

// diff, once per viewport against its `<name>@WxH.tree` snapshot. A missing/mismatched
// per-viewport snapshot throws loadSnapshot's existing resolved-path error.
export async function diffMatrix(
  url: string, viewports: Viewport[], name: string, dir: string | undefined, opts: { port?: number },
): Promise<string> {
  const results = await forEachViewport(url, viewports, async (client, vp) => {
    const tree = buildTree(await extract(client))
    checkInvariants(tree)
    return renderDiff(diffTrees(loadSnapshot(`${name}@${vp.label}`, dir), renderTree(tree))) + busyNote(client)
  }, opts)
  return results.map((r) => prefixLines(r.label, r.result)).join('\n')
}
