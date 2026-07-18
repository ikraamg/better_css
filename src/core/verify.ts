import { forEachViewport, layoutNeverSettled, pageWasBusy, type Viewport } from './connect.js'
import { extract } from './extract.js'
import { buildTree, renderTree } from './tree.js'
import { checkInvariants, renderViolations, violationKey } from './invariants.js'
import { diffTrees, loadSnapshot, renderDiff } from './snapshot.js'
import { forcePseudoStates, type PseudoStates } from './state.js'
import { assertNoInteractNavigation, hasInteractSteps, interactWasUnsettled, runInteractSteps, type InteractSteps } from './interact.js'
import { animateNote, needsAnimationCapture, settleAnimations, type AnimateOpts } from './animate.js'

function prefixLines(label: string, text: string): string {
  return text.split('\n').map((line) => `[${label}] ${line}`).join('\n')
}

// Mirrors matrix.ts's busy/unsettled-note helper (matrix paths bypass mcp.ts's page() wrapper).
function busyNote(client: object): string {
  return (pageWasBusy(client) ? '\nnote: page was still loading at the 10s cap; results may be early' : '') +
    (interactWasUnsettled(client) ? '\nnote: page had not settled after interactions' : '') +
    animateNote(client)
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

export interface VerifyOpts { port?: number; states?: PseudoStates; interact?: InteractSteps; animate?: AnimateOpts; name?: string; dir?: string }

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
    await runInteractSteps(client, opts.interact ?? {}, { skipSettleWait: needsAnimationCapture(opts.animate ?? {}) })
    await settleAnimations(client, opts.animate ?? {})
    if (opts.states) await forcePseudoStates(client, opts.states)
    // The diff below always wants THIS tree (the resting layout at check time), so the
    // persistence filter's second capture (only taken when the settle cap was hit) is a
    // separate, throwaway extract that only feeds the violation-identity comparison.
    const tree = buildTree(await extract(client))
    const first = checkInvariants(tree)
    let violations = first
    const persistenceFiltered = layoutNeverSettled(client)
    if (persistenceFiltered) {
      await new Promise((r) => setTimeout(r, 400))
      const secondKeys = new Set(checkInvariants(buildTree(await extract(client))).map(violationKey))
      violations = first.filter((v) => secondKeys.has(violationKey(v)))
    }
    // A click's delayed redirect can land during the extract/checkInvariants capture(s)
    // above, after runInteractSteps already returned clean — check again now (see
    // interact.ts).
    assertNoInteractNavigation(client)
    const persistenceNote = persistenceFiltered ? '\nnote: page never settled — reporting only violations stable across two captures' : ''
    let block = (await renderViolations(client, violations)) + persistenceNote + busyNote(client)
    let changes = 0
    if (opts.name && !modified) {
      const d = diffOrNote(opts.name, vp.label, opts.dir, renderTree(tree))
      block += `\n${d.rendered}`
      changes = d.changes
    }
    return { violations: violations.length, block, changes, neverSettled: persistenceFiltered }
  }, { port: opts.port, captureAnimations: needsAnimationCapture(opts.animate ?? {}) })

  let diffed: Array<{ label: string; result: { rendered: string; changes: number } }> | undefined
  if (opts.name && modified) {
    // Mirrors snapshot/diff's own contract: settled only, never at-time — a diff compares
    // against a deterministic snapshot, not one pinned to a specific animation frame.
    diffed = await forEachViewport(url, viewports, async (client, vp) => {
      await settleAnimations(client, { settled: opts.animate?.settled })
      const tree = buildTree(await extract(client))
      const d = diffOrNote(opts.name!, vp.label, opts.dir, renderTree(tree))
      return { rendered: d.rendered + busyNote(client), changes: d.changes }
    }, { port: opts.port, captureAnimations: Boolean(opts.animate?.settled) })
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
  // Field #1, contract 2c: at least one viewport never settled — never a confident FAIL
  // on possibly-mid-render truth, even though the (already persistence-filtered)
  // violations are still real enough to keep exit code 1.
  const anyNeverSettled = checked.some((c) => c.result.neverSettled)
  const verdict = dirty
    ? (anyNeverSettled
      ? `VERDICT: INCONCLUSIVE (page never settled; ${totalViolations} persistent violations)`
      : `VERDICT: FAIL (${totalViolations} violations across ${viewports.length} viewports${totalChanges ? `, ${totalChanges} layout changes` : ''})`)
    : (anyNeverSettled ? 'VERDICT: PASS (page never fully settled)' : 'VERDICT: PASS')
  const output = `${verdict}\n${blocks.join('\n')}\nchecked ${checked.length} viewports: ${summary}`
  return { output, dirty }
}
