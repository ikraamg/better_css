#!/usr/bin/env node
import { DEFAULT_SWEEP, parseViewport, parseViewportList, shutdownChrome, withPage, type Viewport } from './core/connect.js'
import { extract } from './core/extract.js'
import { buildTree, findNode, renderTree } from './core/tree.js'
import { checkInvariants, renderViolations } from './core/invariants.js'
import { explain, renderExplanation } from './core/explain.js'
import { inspect } from './core/inspect.js'
import { diffTrees, loadSnapshot, renderDiff, saveSnapshot } from './core/snapshot.js'
import { checkMatrix, diffMatrix, snapshotMatrix } from './core/matrix.js'
import { verifyMatrix } from './core/verify.js'
import { forcePseudoStates, type PseudoStates } from './core/state.js'
import { hasInteractSteps, interactWasUnsettled, runInteractSteps, type InteractSteps } from './core/interact.js'
import { animateNote, needsAnimationCapture, settleAnimations, type AnimateOpts } from './core/animate.js'
import { measureStability, renderStability } from './core/stability.js'

const USAGE = `bettercss <command> <url> [options]
  layout    <url> [--selector S] [--depth N]   print the LayoutTree (budgeted to 400 lines unless --depth is given)
  inspect   <url> --selector S                 deep-dive one element
  explain   <url> --selector S --property P    trace a property to its source rule
  check     <url>                              run invariants (exit 1 on violations)
  snapshot  <url> --name NAME [--dir DIR]      lock current LayoutTree to a .tree file
  diff      <url> --name NAME [--dir DIR]      diff current layout vs snapshot
  verify    <url> [--name NAME --dir DIR]      composite: check invariants + (if --name given)
                                                diff a snapshot, one run. First output line is
                                                VERDICT: PASS/FAIL; exit 1 on any violation or
                                                layout change. Always runs as a matrix, defaulting
                                                to --viewports ${DEFAULT_SWEEP} when neither
                                                --viewports nor --viewport is given (--viewport acts
                                                as a one-entry sweep; snapshots are always named
                                                <name>@WxH, even with one viewport). States and interact
                                                steps affect the invariant check only — the diff always
                                                compares the resting (unforced, un-interacted) layout, at
                                                the cost of a second page load per viewport when
                                                --hover/--focus/--active/--click/--scroll-to AND --name
                                                are both given
  stability <url> [--duration MS] [--threshold SCORE] [--viewport WxH]
                                                load-time layout-shift report (Cumulative Layout
                                                Shift): waits --duration ms (default 3000) past
                                                load, then reports every shift and any img/video
                                                shift source missing width+height attributes.
                                                Score is the raw sum over the window (the CWV
                                                metric uses session windows — multi-burst pages
                                                may score higher here).
                                                Exit 1 when score > threshold (default 0.1, the
                                                Core Web Vitals "good" boundary). TIMING-DEPENDENT:
                                                an observation, not a deterministic snapshot — local
                                                dev servers under-report; throttle to reproduce
                                                production shifts. No --settled/--at-time/--click/
                                                --scroll-to/--hover/--focus/--active/--viewports
  options: --port N (attach to Chrome at port N instead of 9222/headless)
           --viewport WxH (emulated viewport size, e.g. 1280x800)
           --viewports W1xH1,W2xH2,... (check/snapshot/diff/verify once per viewport)
           --hover S, --focus S, --active S (force a pseudo-state on selector S;
             layout/inspect/explain/check/verify only, not snapshot/diff)
           --click S (repeatable; real click on selector S — the target is first scrolled
             into view, centered, and the scroll is left where it lands), --scroll-to S_or_Y
             (selector or pixel y) — interaction pre-steps, layout/inspect/explain/check/verify
             only, not snapshot/diff. Order: navigate, scroll-to, clicks (in argument order),
             settle, then --hover/--focus/--active, then capture
           --settled (fast-forward every CSS transition/animation to its end state before
             capturing — layout/inspect/explain/check/verify/snapshot/diff; a perpetual
             animation can't end, so it's pinned to its start (t=0) and noted), --at-time N
             (seek every animation to N ms, clamped to its own full duration, instead of its
             end — same commands EXCEPT snapshot/diff, where a specific animation frame isn't
             a deterministic snapshot). Mutually exclusive with each other. Runs after
             interact steps and before --hover/--focus/--active`

interface Flags {
  [key: string]: string | string[] | undefined
  click?: string[]
  'scroll-to'?: string
  hover?: string; focus?: string; active?: string
  // required by REQUIRED[cmd] before use on their respective commands — declared
  // non-optional here to match flags()'s prior Record<string,string> typing exactly
  selector: string; property: string; name: string
  depth?: string; port?: string
  viewport?: string; viewports?: string
  dir?: string
  settled?: string; 'at-time'?: string
}

// Repeated occurrences of these flags accumulate into an array instead of last-wins.
const REPEATABLE = new Set(['click'])
// Presence-only flags: no value follows, so the parser must not consume the next argv slot.
const BOOLEAN = new Set(['settled'])

function flags(argv: string[]): Flags {
  // required fields (selector/property/name) are only actually read on commands whose
  // REQUIRED[cmd] check already guarantees they were passed — same pragmatic lie the
  // prior Record<string,string> return type made implicitly.
  const out = {} as Flags
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    if (BOOLEAN.has(key)) { out[key] = 'true'; continue }
    const val = argv[++i]
    if (REPEATABLE.has(key)) {
      const arr = (out[key] as string[] | undefined) ?? []
      arr.push(val)
      out[key] = arr
    } else {
      out[key] = val
    }
  }
  return out
}

const REQUIRED: Record<string, string[]> = {
  inspect: ['selector'],
  explain: ['selector', 'property'],
  snapshot: ['name'],
  diff: ['name'],
}

async function main(): Promise<number> {
  const [cmd, url] = process.argv.slice(2)
  const f = flags(process.argv.slice(4))
  if (!cmd || !url) { console.error(USAGE); return 2 }
  if (!['layout', 'inspect', 'explain', 'check', 'snapshot', 'diff', 'verify', 'stability'].includes(cmd)) {
    console.error(USAGE)
    return 2
  }
  for (const name of REQUIRED[cmd] ?? []) {
    if (!f[name]) {
      console.error(`${cmd} requires --${name}\n\n${USAGE}`)
      return 2
    }
  }
  const stateFlags = (['hover', 'focus', 'active'] as const).filter((k) => f[k] !== undefined)
  if (stateFlags.length && !['layout', 'inspect', 'explain', 'check', 'verify'].includes(cmd)) {
    console.error(`--${stateFlags[0]} is only valid for layout/inspect/explain/check/verify, not ${cmd} — forced-state snapshots invite stale-state confusion.`)
    return 2
  }
  const interact: InteractSteps = { click: f.click, scrollTo: f['scroll-to'] }
  if (hasInteractSteps(interact) && !['layout', 'inspect', 'explain', 'check', 'verify'].includes(cmd)) {
    console.error(`--click/--scroll-to are only valid for layout/inspect/explain/check/verify, not ${cmd} — interacted-state snapshots invite stale-state confusion.`)
    return 2
  }
  // USAGE promises stability takes none of these; silently no-oping them would lie
  // (worst case: --viewports quietly running the default 1280x800 with no signal).
  for (const name of ['settled', 'at-time', 'viewports'] as const) {
    if (cmd === 'stability' && f[name] !== undefined) {
      console.error(`--${name} is not valid for stability — it observes one natural page load (no animation seeking, no viewport matrix).`)
      return 2
    }
  }
  for (const name of ['depth', 'port', 'at-time', 'duration', 'threshold']) {
    if (f[name] !== undefined && Number.isNaN(Number(f[name]))) {
      console.error(`--${name} must be a number, got '${f[name]}'`)
      return 2
    }
  }
  if (f['at-time'] !== undefined && ['snapshot', 'diff'].includes(cmd)) {
    console.error(`--at-time is not valid for ${cmd} — a snapshot must be a deterministic capture, not one pinned to a specific animation frame; use --settled instead.`)
    return 2
  }
  if (f.settled !== undefined && f['at-time'] !== undefined) {
    console.error(`--settled and --at-time are mutually exclusive — pick one.`)
    return 2
  }
  const animate: AnimateOpts = { settled: f.settled !== undefined, atTime: f['at-time'] !== undefined ? Number(f['at-time']) : undefined }
  let viewport: { width: number; height: number } | undefined
  if (f.viewport !== undefined) {
    try { viewport = parseViewport(f.viewport) }
    catch (err) { console.error((err as Error).message); return 2 }
  }
  let viewports: Viewport[] | undefined
  if (f.viewports !== undefined) {
    try { viewports = parseViewportList(f.viewports) }
    catch (err) { console.error((err as Error).message); return 2 }
  }
  if (stateFlags.length && viewports && cmd !== 'check' && cmd !== 'verify') {
    console.error(`--${stateFlags[0]} is not supported together with --viewports yet.`)
    return 2
  }
  if (hasInteractSteps(interact) && viewports && cmd !== 'check' && cmd !== 'verify') {
    console.error(`--click/--scroll-to is not supported together with --viewports yet.`)
    return 2
  }
  const opts = { port: f.port ? Number(f.port) : undefined, viewport, captureAnimations: needsAnimationCapture(animate) }

  if (cmd === 'stability') {
    const result = await measureStability(url, {
      port: opts.port,
      viewport,
      duration: f.duration ? Number(f.duration) : undefined,
      threshold: f.threshold ? Number(f.threshold) : undefined,
    })
    if (result.score > result.threshold) process.exitCode = 1
    console.log(renderStability(result))
    return Number(process.exitCode ?? 0)
  }

  if (cmd === 'verify') {
    const states: PseudoStates = { hover: f.hover, focus: f.focus, active: f.active }
    // --viewport (singular) acts as a one-entry sweep; --viewports wins when both are given
    const { output, dirty } = await verifyMatrix(url, viewports ?? parseViewportList(f.viewport ?? DEFAULT_SWEEP), {
      port: opts.port,
      states: stateFlags.length ? states : undefined,
      interact: hasInteractSteps(interact) ? interact : undefined,
      animate: needsAnimationCapture(animate) ? animate : undefined,
      name: f.name,
      dir: f.dir,
    })
    if (dirty) process.exitCode = 1
    console.log(output)
    return Number(process.exitCode ?? 0)
  }

  if (viewports && ['check', 'snapshot', 'diff'].includes(cmd)) {
    const mopts = { port: opts.port }
    if (cmd === 'check') {
      const states: PseudoStates = { hover: f.hover, focus: f.focus, active: f.active }
      const { output, dirty } = await checkMatrix(url, viewports, { ...mopts, states, interact, animate })
      if (dirty) process.exitCode = 1
      console.log(output)
      return Number(process.exitCode ?? 0)
    }
    if (cmd === 'snapshot') console.log(await snapshotMatrix(url, viewports, f.name, f.dir, { ...mopts, settled: animate.settled }))
    else console.log(await diffMatrix(url, viewports, f.name, f.dir, { ...mopts, settled: animate.settled }))
    return Number(process.exitCode ?? 0)
  }

  const states: PseudoStates = { hover: f.hover, focus: f.focus, active: f.active }
  const output = await withPage(url, async (client) => {
    await runInteractSteps(client, interact)
    await settleAnimations(client, animate)
    await forcePseudoStates(client, states)
    let result: string
    switch (cmd) {
      case 'layout': {
        const tree = buildTree(await extract(client))
        checkInvariants(tree) // populate inline ⚠ warnings
        const from = f.selector ? findNode(tree, f.selector) : undefined
        if (f.selector && !from) throw new Error(`No element matching '${f.selector}' in the layout tree.`)
        const depth = f.depth ? Number(f.depth) : undefined
        result = renderTree(tree, { depth, from, budget: depth === undefined ? 400 : undefined })
        break
      }
      case 'inspect': result = await inspect(client, f.selector); break
      case 'explain': result = renderExplanation(await explain(client, f.selector, f.property)); break
      case 'check': {
        const violations = checkInvariants(buildTree(await extract(client)))
        if (violations.length) process.exitCode = 1
        result = await renderViolations(client, violations)
        break
      }
      case 'snapshot': {
        const tree = buildTree(await extract(client))
        checkInvariants(tree)
        result = `saved ${saveSnapshot(renderTree(tree), f.name, f.dir)}`
        break
      }
      case 'diff': {
        const tree = buildTree(await extract(client))
        checkInvariants(tree)
        result = renderDiff(diffTrees(loadSnapshot(f.name, f.dir), renderTree(tree)))
        break
      }
      default: result = USAGE
    }
    if (interactWasUnsettled(client)) result += '\nnote: page had not settled after interactions'
    return result + animateNote(client)
  }, opts)

  console.log(output)
  return Number(process.exitCode ?? 0)
}

main()
  .then((code) => { process.exitCode = code })
  .catch((err) => { console.error(err.message); process.exitCode = 2 })
  .finally(() => shutdownChrome())
