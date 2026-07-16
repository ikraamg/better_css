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
  const pinned = infiniteFrozen.get(client)
  const pinnedNote = pinned
    ? `\nnote: ${pinned} infinite animation${pinned === 1 ? '' : 's'} pinned to ${pinned === 1 ? 'its' : 'their'} start (t=0) for determinism`
    : ''
  const settleNote = unsettledAfterSeek.has(client) ? '\nnote: page had not settled after animation seek' : ''
  return pinnedNote + settleNote
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
  // Enforced here, at the shared choke point, so every caller (CLI single-page + matrix,
  // all MCP tools, verify) gets the same loud rejection — the CLI additionally validates
  // upfront for a cheaper pre-Chrome exit 2.
  if (opts.settled && opts.atTime !== undefined) {
    throw new Error('settled and atTime are mutually exclusive — pick one.')
  }
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
      // Clamp to the FULL active duration (delay + duration × iterations, same formula as
      // the settled branch) — clamping to one iteration made every later cycle unreachable.
      // Infinite animations have no end to clamp to: the requested time is used as-is.
      const end = infinite ? Infinity : delay + duration * iterations
      seeks.push({ id: a.id, time: Math.max(0, Math.min(opts.atTime, end)) })
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
  // settled only: under atTime, infinite animations are seeked to the requested time exactly
  // like finite ones — nothing special happened, so a "pinned to t=0" note would be a lie.
  if (opts.settled && infiniteCount) infiniteFrozen.set(client, infiniteCount)

  if (opts.settled && !(await waitForSettle(client, POST_SEEK_SETTLE_CAP_MS))) unsettledAfterSeek.add(client)
}
