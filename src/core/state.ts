import { collectSheets, resolveNode } from './explain.js'

export interface PseudoStates { hover?: string; focus?: string; active?: string }

const PSEUDO_STATES = ['hover', 'focus', 'active'] as const

// Forces the given pseudo-classes on their selectors' elements so subsequent
// extraction/inspection sees interaction-state layout/cascade without a real mouse.
// Groups by selector first: the same selector passed to multiple flags gets one
// forcePseudoState call with the combined list, per the mechanics contract.
export async function forcePseudoStates(client: any, states: PseudoStates): Promise<void> {
  const bySelector = new Map<string, string[]>()
  for (const pseudo of PSEUDO_STATES) {
    const selector = states[pseudo]
    if (!selector) continue
    const list = bySelector.get(selector) ?? []
    list.push(pseudo)
    bySelector.set(selector, list)
  }
  if (bySelector.size === 0) return

  // Reuses explain's collectSheets to enable the DOM+CSS domains. collectSheets caches
  // its result per client, so if explain() later runs on this same client its own
  // collectSheets call returns the cache instead of re-enabling CSS — the enable that
  // matters (the one that arms the styleSheetAdded backfill) already happened here.
  await collectSheets(client)

  // Empirically verified (see test/state.test.ts + cli.test.ts): forcePseudoState's
  // effect is visible to the very next DOM.getBoxModel/DOMSnapshot.captureSnapshot/
  // CSS.getMatchedStylesForNode call on the same connection — Chrome computes style
  // and layout lazily, and this CDP round-trip is awaited before any of those run, so
  // no extra settle read is needed.
  for (const [selector, forcedPseudoClasses] of bySelector) {
    const nodeId = await resolveNode(client, selector)
    await client.CSS.forcePseudoState({ nodeId, forcedPseudoClasses })
  }
}
