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

// Populated by runInteractSteps' frameNavigated listener, which stays armed past its
// return (the client/listener live for the rest of withPage's callback) — a click
// handler's delayed redirect (setTimeout + location.href) can land during the caller's
// own capture, after runInteractSteps has already returned cleanly. All four capture
// callers (cli.ts, mcp.ts's page(), matrix.ts's checkMatrix, verify.ts) check this AFTER
// capture and abort with assertNoInteractNavigation, so a late redirect is always caught
// instead of silently describing the page it navigated away from.
const navigations = new WeakMap<object, string>()
export function interactSawNavigation(client: object): string | null {
  return navigations.get(client) ?? null
}

function navError(to: string): Error {
  return new Error(`--click caused a navigation to ${to} — interact steps are for same-page UI`)
}

// One-liner for the four capture callers — avoids reconstructing navError's message at
// each call site.
export function assertNoInteractNavigation(client: object): void {
  const to = interactSawNavigation(client)
  if (to) throw navError(to)
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

// Real trusted click: mousePressed/mouseReleased at the target's box-model center,
// exactly what a user click dispatches. Input.dispatchMouseEvent hit-tests VIEWPORT
// coordinates, so the target is first scrolled into view (centered), like a real user
// would — a below-fold target would otherwise silently miss. The scroll is left where
// it lands (documented in the tool descriptions). DOM.getBoxModel's quad is already
// viewport-relative for the current scroll position (verified empirically — no manual
// scroll-offset subtraction needed), so it is read AFTER the scroll.
async function clickTarget(client: any, selector: string): Promise<void> {
  const nodeId = await resolveNode(client, selector)
  const { object } = await client.DOM.resolveNode({ nodeId })
  await client.Runtime.callFunctionOn({ objectId: object.objectId, functionDeclaration: 'function(){ this.scrollIntoView({ block: "center" }) }' })
  const { model } = await client.DOM.getBoxModel({ nodeId })
  const [x0, y0, , , x2, y2] = model.content
  const x = (x0 + x2) / 2
  const y = (y0 + y2) / 2
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

// Two consecutive animation frames with an identical layout signature AND no live
// FINITE animations = settled. The signature hashes every element's getBoundingClientRect —
// unlike a body-box summary it reflects transform transitions and fixed-position
// movement, which never change the body's own box. The finite-animation check closes
// a cold-start gap the hash can't see: a just-started animation can still be
// play-pending across both sampled frames (identical rects) yet about to move.
// Float accumulation is deterministic within a frame; the modulo keeps the magnitude
// well under 2^53 so fractional pixels aren't lost.
// Factored out (not inlined in SETTLE_EXPR) so watch.ts's change-detection poll can
// evaluate the SAME hash directly (SIGNATURE_EXPR below) without paying for settle's
// two-frame wait — it just wants "has anything moved since I last looked".
const SIG_FN = `function () {
  let h = 0
  const els = document.querySelectorAll('*')
  for (const el of els) {
    const r = el.getBoundingClientRect()
    h = (h % 0xffffff) * 31 + r.x + r.y * 3 + r.width * 7 + r.height * 13
  }
  return h + ':' + window.scrollY + ':' + els.length
}`

// Infinite-iteration animations (a.effect.getTiming().iterations === Infinity — a
// perpetual spinner, say) are excluded from the live-animation check on purpose: they
// never end, so counting them would burn every settle up to the cap regardless of
// whether the page has actually stopped moving. src/core/animate.ts's --settled path
// relies on this too: it freezes a finite animation by seeking it past its end (which
// removes it from document.getAnimations() entirely, verified empirically) and an
// infinite one via Animation.setPlaybackRate(0) (which does NOT remove it) — the filter
// here is what lets the post-seek settle resolve instead of hanging on the frozen spinner.
const SETTLE_EXPR = `new Promise((resolve) => {
  const sig = ${SIG_FN}
  const liveFinite = () => document.getAnimations().filter((a) => a.effect && a.effect.getTiming().iterations !== Infinity).length
  requestAnimationFrame(() => {
    const a = sig()
    requestAnimationFrame(() => {
      resolve(liveFinite() === 0 && sig() === a)
    })
  })
})`

// Exported for watch.ts's poll: the raw signature, read synchronously (no settle wait,
// no animation check) — a "has this changed since I last sampled" hash, not a
// settled-or-not verdict.
export const SIGNATURE_EXPR = `(${SIG_FN})()`

const SETTLE_CAP_MS = 2000

// Exported so animate.ts's post-seek settle (a short, separate cap — see its
// composition contract) reuses this exact check instead of re-implementing it.
export async function waitForSettle(client: any, capMs = SETTLE_CAP_MS): Promise<boolean> {
  const deadline = Date.now() + capMs
  do {
    const { result } = await client.Runtime.evaluate({ expression: SETTLE_EXPR, awaitPromise: true, returnByValue: true })
    if (result.value === true) return true
  } while (Date.now() < deadline)
  return false
}

// Order (contract): scrollTo (if given) -> clicks in argument order -> settle. Callers
// (cli.ts, mcp.ts, matrix.ts, verify.ts) run this after navigation and before any
// pseudo-state forcing (state.ts) or capture. A no-op when no steps are given, same
// shape as forcePseudoStates's empty-states no-op.
export async function runInteractSteps(
  client: any, steps: InteractSteps,
  opts: {
    // Set when the caller is about to run animate.ts's settleAnimations with
    // settled/atTime — its own seek (+ short post-seek settle) supersedes this wait
    // entirely, so a click that starts a transition longer than SETTLE_CAP_MS must not
    // burn the full cap polling an animation that's about to be frozen/seeked anyway,
    // nor mark `unsettled` for a note animate.ts's own (accurate) one already covers.
    skipSettleWait?: boolean
  } = {},
): Promise<void> {
  if (!hasInteractSteps(steps)) return

  // Armed for the ENTIRE interact phase and left armed after this function returns (see
  // the `navigations` WeakMap above) — a click handler may schedule a delayed redirect
  // (setTimeout + location.href) that lands well after the click, even during the
  // caller's capture. No URL-inequality filter: withPage's own navigation to the
  // starting page already completed before this phase begins (connect.ts's navigate),
  // so ANY main-frame frameNavigated from here on is interaction-caused — including a
  // same-URL self-redirect (e.g. a full reload), which an inequality filter would miss
  // entirely. Hash-only jumps never fire frameNavigated (verified empirically), so they
  // stay tolerated with no special-casing needed.
  client.Page.frameNavigated(({ frame }: any) => {
    if (!frame.parentId) navigations.set(client, frame.url)
  })
  // Flush + check: chrome-remote-interface delivers messages in order over one
  // connection (the same guarantee explain.ts's collectSheets relies on), so one
  // benign round-trip guarantees an already-queued frameNavigated has been delivered
  // before the check. The flush's own error is swallowed: a navigation destroys the
  // execution context, which is exactly the case being reported.
  const navCheck = async () => {
    await client.Runtime.evaluate({ expression: '1' }).catch(() => {})
    assertNoInteractNavigation(client)
  }

  if (steps.scrollTo !== undefined) await scrollToTarget(client, steps.scrollTo)

  for (const selector of steps.click ?? []) {
    await clickTarget(client, selector)
    await navCheck()
  }

  if (opts.skipSettleWait) {
    // Still give the browser ONE settle pass (~2 requestAnimationFrame ticks) — a
    // just-started transition/animation needs that tick to actually be registered
    // (Animation.animationStarted, cached by connect.ts) before settleAnimations tries
    // to seek it; skipping the wait outright races the seek against an animation Chrome
    // hasn't created yet (verified empirically: cachedAnimations is still empty and the
    // seek becomes a silent no-op). Not looping further up to the full cap — the
    // upcoming seek supersedes waiting out a real transition — and `unsettled` is
    // deliberately left unset here: animate.ts's own post-seek settle note is the
    // authoritative one once it seeks.
    try {
      await waitForSettle(client, 1)
    } catch (err) {
      await navCheck()
      throw err
    }
    await navCheck()
    return
  }

  let settled: boolean
  try {
    settled = await waitForSettle(client)
  } catch (err) {
    // A navigation landing mid-settle destroys the execution context and CDP throws
    // its raw error ("Inspected target navigated or closed" / "Execution context was
    // destroyed") — rethrow as the clear navigation error when that's the cause.
    await navCheck()
    throw err
  }
  await navCheck()

  if (!settled) unsettled.add(client)
}
