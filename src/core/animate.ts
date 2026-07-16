import { cachedAnimations } from './connect.js'
import { waitForSettle } from './interact.js'

export interface AnimateOpts { settled?: boolean; atTime?: number }

export function needsAnimationCapture(opts: AnimateOpts): boolean {
  return Boolean(opts.settled) || opts.atTime !== undefined
}

// Mirrors interact.ts's unsettled WeakSet pattern: a per-client fact the caller
// (cli.ts/mcp.ts/matrix.ts/verify.ts) surfaces as a note, not an error.
const infiniteFrozen = new WeakMap<object, number>()
const unsettledAfterSeek = new WeakSet<object>()

export function animateNote(client: object): string {
  const frozen = infiniteFrozen.get(client)
  const frozenNote = frozen ? `\nnote: ${frozen} infinite animation${frozen === 1 ? '' : 's'} frozen mid-flight` : ''
  const settleNote = unsettledAfterSeek.has(client) ? '\nnote: page had not settled after animation seek' : ''
  return frozenNote + settleNote
}

// A short cap, not interact's 2s one: seeking + freezing already puts the page in its
// final state directly (CDP calls are synchronous within the renderer — same finding as
// state.ts's forcePseudoState), so this is a safety net for any cascading reflow the seek
// itself triggers, not a wait for animations to finish (those are handled below already).
// --settled only (see settleAnimations): a --at-time seek to anything short of an
// animation's full duration leaves it "running" forever (verified empirically — it never
// naturally finishes), so running this check there would always time out and misreport a
// deliberate mid-animation freeze as "not settled".
const POST_SEEK_SETTLE_CAP_MS = 300

// Order (contract): interact steps -> settle/seek -> state forcing -> capture. Callers run
// this after runInteractSteps and before forcePseudoStates. A no-op unless --settled/--at-time
// was requested (contract 4: Animation.enable must not be armed otherwise) — withPage's
// captureAnimations opt gates that arming, so cachedAnimations is empty when this is a no-op.
export async function settleAnimations(client: any, opts: AnimateOpts): Promise<void> {
  if (!needsAnimationCapture(opts)) return
  const animations = cachedAnimations(client)
  if (animations.length === 0) return

  let infiniteCount = 0
  const seeks: Array<{ id: string; time: number }> = []
  for (const a of animations) {
    const delay = a.source?.delay ?? 0
    const duration = a.source?.duration ?? 0
    const iterations = a.source?.iterations // CDP omits this key entirely for `infinite` (verified empirically)
    const infinite = iterations === undefined
    if (infinite) infiniteCount++

    if (opts.atTime !== undefined) {
      seeks.push({ id: a.id, time: Math.max(0, Math.min(opts.atTime, delay + duration)) })
    } else if (infinite) {
      // Can't seek to "the end" of something that never ends (contract 1) — pin to a fixed,
      // reproducible point (its own start) instead of leaving it wherever real-clock jitter
      // between the navigate and this seek happened to land it. That jitter is exactly what
      // broke the byte-identical-double-run money assertion the first time this was tried
      // (a rotated spinner's bounding box shifts by sub-pixel amounts run to run) — seeking
      // finite ones to their end is already deterministic, so infinite ones need the same.
      seeks.push({ id: a.id, time: 0 })
    } else {
      // Finite: fast-forward to its true end state (contract 1).
      seeks.push({ id: a.id, time: delay + duration * iterations })
    }
  }

  // Freeze BEFORE seeking: setPlaybackRate is global by design (freezes the page's
  // entire animation clock), and doing it first means each animation sits at exactly
  // its seek target afterwards. Seek-then-freeze left a few ms of clock drift between
  // the two CDP calls — enough to rotate the spinner a fraction of a degree and flip
  // its rounded bounding box, which broke the byte-identical double-run contract.
  await client.Animation.setPlaybackRate({ playbackRate: 0 })
  // Animation.seekAnimations takes ONE currentTime for its whole animations array
  // (confirmed against the CDP protocol and empirically), so animations targeting
  // different times each need their own call.
  for (const s of seeks) await client.Animation.seekAnimations({ animations: [s.id], currentTime: s.time })
  if (infiniteCount) infiniteFrozen.set(client, infiniteCount)

  if (opts.settled && !(await waitForSettle(client, POST_SEEK_SETTLE_CAP_MS))) unsettledAfterSeek.add(client)
}
