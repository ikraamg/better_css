import { forEachViewport, pageWasBusy, type Viewport } from './connect.js'
import { extract } from './extract.js'
import { buildTree, renderTree } from './tree.js'
import { checkInvariants, renderViolations } from './invariants.js'
import { diffTrees, loadSnapshot, renderDiff } from './snapshot.js'
import { forcePseudoStates, type PseudoStates } from './state.js'
import { hasInteractSteps, interactWasUnsettled, runInteractSteps, type InteractSteps } from './interact.js'

function prefixLines(label: string, text: string): string {
  return text.split('\n').map((line) => `[${label}] ${line}`).join('\n')
}

// Mirrors matrix.ts's busy/unsettled-note helper (matrix paths bypass mcp.ts's page() wrapper).
function busyNote(client: object): string {
  return (pageWasBusy(client) ? '\nnote: page was still loading at the 10s cap; results may be early' : '') +
    (interactWasUnsettled(client) ? '\nnote: page had not settled after interactions' : '')
}

// A missing per-viewport snapshot is a note, not a failure (contract 3) — agents may
// snapshot only some viewports. Discriminates loadSnapshot's ENOENT-derived error (its
// message always starts with "No snapshot '<name>'") from any other thrown error, which
// propagates unchanged.
function diffOrNote(
  name: string, label: string, dir: string | undefined, currentTree: string,
): { rendered: string; changes: number } {
  const snapName = `${name}@${label}`
  let old: string
  try {
    old = loadSnapshot(snapName, dir)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`No snapshot '${snapName}'`)) {
      return { rendered: `note: no snapshot '${snapName}' — diff skipped for this viewport`, changes: 0 }
    }
    throw err
  }
  const entries = diffTrees(old, currentTree)
  return { rendered: renderDiff(entries), changes: entries.length }
}

export interface VerifyOpts { port?: number; states?: PseudoStates; interact?: InteractSteps; name?: string; dir?: string }

// Composite: check + (optional) diff, per viewport, in input order — verify is ALWAYS a
// matrix, even with one viewport (snapshot files are always named <name>@WxH, never plain
// <name>.tree, so the naming convention never depends on how many viewports were passed).
//
// Contract 5: states (and, by the same reasoning, interact steps) apply to the check only.
// Diffing a forced/interacted layout against a resting snapshot would always show a
// change, so the diff always compares the RESTING layout. When either is given together
// with name that needs a second, unforced+un-interacted page load per viewport (worst case
// 2 loads/viewport) — otherwise the check's own tree already IS the resting layout, so one
// load covers both.
export async function verifyMatrix(
  url: string, viewports: Viewport[], opts: VerifyOpts,
): Promise<{ output: string; dirty: boolean }> {
  const modified = Boolean(opts.states) || hasInteractSteps(opts.interact)
  const checked = await forEachViewport(url, viewports, async (client, vp) => {
    await runInteractSteps(client, opts.interact ?? {})
    if (opts.states) await forcePseudoStates(client, opts.states)
    const tree = buildTree(await extract(client))
    const violations = checkInvariants(tree)
    let block = (await renderViolations(client, violations)) + busyNote(client)
    let changes = 0
    if (opts.name && !modified) {
      const d = diffOrNote(opts.name, vp.label, opts.dir, renderTree(tree))
      block += `\n${d.rendered}`
      changes = d.changes
    }
    return { violations: violations.length, block, changes }
  }, { port: opts.port })

  let diffed: Array<{ label: string; result: { rendered: string; changes: number } }> | undefined
  if (opts.name && modified) {
    diffed = await forEachViewport(url, viewports, async (client, vp) => {
      const tree = buildTree(await extract(client))
      const d = diffOrNote(opts.name!, vp.label, opts.dir, renderTree(tree))
      return { rendered: d.rendered + busyNote(client), changes: d.changes }
    }, { port: opts.port })
  }

  let totalViolations = 0
  let totalChanges = 0
  const blocks = checked.map((c, i) => {
    totalViolations += c.result.violations
    let block = c.result.block
    if (diffed) {
      block += `\n${diffed[i].result.rendered}`
      totalChanges += diffed[i].result.changes
    } else {
      totalChanges += c.result.changes
    }
    return prefixLines(c.label, block)
  })

  const summary = checked
    .map((c) => `${c.label}=${c.result.violations ? `${c.result.violations} violations` : 'clean'}`)
    .join(', ')
  const dirty = totalViolations > 0 || totalChanges > 0
  const verdict = dirty
    ? `VERDICT: FAIL (${totalViolations} violations across ${viewports.length} viewports${totalChanges ? `, ${totalChanges} layout changes` : ''})`
    : 'VERDICT: PASS'
  const output = `${verdict}\n${blocks.join('\n')}\nchecked ${checked.length} viewports: ${summary}`
  return { output, dirty }
}
