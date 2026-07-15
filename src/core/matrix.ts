import { forEachViewport, type Viewport } from './connect.js'
import { extract } from './extract.js'
import { buildTree, renderTree } from './tree.js'
import { checkInvariants, renderViolations } from './invariants.js'
import { diffTrees, loadSnapshot, renderDiff, saveSnapshot } from './snapshot.js'

function prefixLines(label: string, text: string): string {
  return text.split('\n').map((line) => `[${label}] ${line}`).join('\n')
}

// check, once per viewport (sequential, input order). Exit-worthiness (`dirty`) is any
// viewport with violations; groups stay per-viewport since each renderViolations call
// only ever sees its own viewport's violations.
export async function checkMatrix(
  url: string, viewports: Viewport[], opts: { port?: number },
): Promise<{ output: string; dirty: boolean }> {
  const results = await forEachViewport(url, viewports, async (client) => {
    const violations = checkInvariants(buildTree(await extract(client)))
    return { violations, rendered: await renderViolations(client, violations) }
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
    return saveSnapshot(renderTree(tree), `${name}@${vp.label}`, dir)
  }, opts)
  return results.map((r) => `saved ${r.result}`).join('\n')
}

// diff, once per viewport against its `<name>@WxH.tree` snapshot. A missing/mismatched
// per-viewport snapshot throws loadSnapshot's existing resolved-path error.
export async function diffMatrix(
  url: string, viewports: Viewport[], name: string, dir: string | undefined, opts: { port?: number },
): Promise<string> {
  const results = await forEachViewport(url, viewports, async (client, vp) => {
    const tree = buildTree(await extract(client))
    checkInvariants(tree)
    return renderDiff(diffTrees(loadSnapshot(`${name}@${vp.label}`, dir), renderTree(tree)))
  }, opts)
  return results.map((r) => prefixLines(r.label, r.result)).join('\n')
}
