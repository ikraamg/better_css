import { resolveNode } from './explain.js'

export interface InteractSteps { click?: string[]; scrollTo?: string }

export function hasInteractSteps(steps?: InteractSteps): boolean {
  return Boolean(steps && ((steps.click?.length ?? 0) > 0 || steps.scrollTo !== undefined))
}

// Mirrors connect.ts's busyPages WeakSet pattern: settle() hitting its cap is a
// per-client fact the caller (cli.ts/mcp.ts/matrix.ts/verify.ts) surfaces as a note,
// not an error.
const unsettled = new WeakSet<object>()
export function interactWasUnsettled(client: object): boolean {
  return unsettled.has(client)
}

const NUMERIC_Y = /^\d+$/

async function scrollToTarget(client: any, target: string): Promise<void> {
  if (NUMERIC_Y.test(target)) {
    await client.Runtime.evaluate({ expression: `window.scrollTo(0, ${Number(target)})` })
    return
  }
  // resolveNode first for the suggestions error on no match, same as click; then
  // Runtime.callFunctionOn(scrollIntoView) on the resolved object — real DOM call,
  // fires actual scroll events (needed for real page scroll handlers to see it).
  const nodeId = await resolveNode(client, target)
  const { object } = await client.DOM.resolveNode({ nodeId })
  await client.Runtime.callFunctionOn({ objectId: object.objectId, functionDeclaration: 'function(){ this.scrollIntoView() }' })
}

// Real trusted click: box-model center + mousePressed/mouseReleased, exactly what a
// user click dispatches. DOM.getBoxModel's quad is already viewport-relative for the
// CURRENT scroll position (verified empirically — no manual scroll-offset subtraction
// needed, unlike raw document coordinates), so this works correctly after scrollTo.
async function clickTarget(client: any, selector: string): Promise<void> {
  const nodeId = await resolveNode(client, selector)
  const { model } = await client.DOM.getBoxModel({ nodeId })
  const [x0, y0, , , x2, y2] = model.content
  const x = (x0 + x2) / 2
  const y = (y0 + y2) / 2
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

// Two consecutive animation frames with an identical cheap layout signature = settled.
// document.querySelectorAll('*').length catches subtree insert/remove that
// getBoundingClientRect alone would miss; scrollY catches scroll-driven changes.
const SETTLE_EXPR = `new Promise((resolve) => {
  const sig = () => {
    const r = document.body.getBoundingClientRect()
    return r.x + ',' + r.y + ',' + r.width + ',' + r.height + ',' + window.scrollY + ',' + document.querySelectorAll('*').length
  }
  requestAnimationFrame(() => {
    const a = sig()
    requestAnimationFrame(() => { const b = sig(); resolve(a === b ? b : null) })
  })
})`

const SETTLE_CAP_MS = 2000

async function waitForSettle(client: any): Promise<boolean> {
  const deadline = Date.now() + SETTLE_CAP_MS
  do {
    const { result } = await client.Runtime.evaluate({ expression: SETTLE_EXPR, awaitPromise: true, returnByValue: true })
    if (result.value !== null) return true
  } while (Date.now() < deadline)
  return false
}

// Order (contract): scrollTo (if given) -> clicks in argument order -> settle. Callers
// (cli.ts, mcp.ts, matrix.ts, verify.ts) run this after navigation and before any
// pseudo-state forcing (state.ts) or capture. A no-op when no steps are given, same
// shape as forcePseudoStates's empty-states no-op.
export async function runInteractSteps(client: any, steps: InteractSteps): Promise<void> {
  if (!hasInteractSteps(steps)) return

  // Armed for the whole phase (not just clicks) — only checked around clicks below,
  // since scrollTo triggering a real navigation is out of scope for this guard.
  let navigatedTo: string | null = null
  client.Page.frameNavigated(({ frame }: any) => { if (!frame.parentId) navigatedTo = frame.url })

  if (steps.scrollTo !== undefined) await scrollToTarget(client, steps.scrollTo)

  for (const selector of steps.click ?? []) {
    await clickTarget(client, selector)
    // Flush: chrome-remote-interface delivers events for a domain in order over one
    // connection (same guarantee explain.ts's collectSheets relies on for
    // styleSheetAdded) — this Runtime round-trip guarantees a frameNavigated already
    // queued by the click has been delivered to our listener before we check it.
    // Swallow errors here: a navigation can detach the old execution context, which is
    // exactly the case we're about to report via navigatedTo anyway.
    await client.Runtime.evaluate({ expression: '1' }).catch(() => {})
    if (navigatedTo) throw new Error(`--click caused a navigation to ${navigatedTo} — interact steps are for same-page UI`)
  }

  if (!(await waitForSettle(client))) unsettled.add(client)
}
