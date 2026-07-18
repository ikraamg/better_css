#!/usr/bin/env node
import { DEFAULT_SWEEP, forEachViewport, layoutNeverSettled, parseViewport, parseViewportList, setAttachMode, setDesktopOnly, shutdownChrome, withPage, type Viewport } from './core/connect.js'
import { extract } from './core/extract.js'
import { buildTree, findNode, renderTree } from './core/tree.js'
import { checkInvariants, checkWithPersistence, renderViolations } from './core/invariants.js'
import { applyBaselineUpdate, baselineKey, baselineShapeWarning, diffBaseline, loadBaselineFile, renderBaselineNote, writeBaselineFile, type BaselineDelta } from './core/baseline.js'
import { explain, renderExplanation } from './core/explain.js'
import { inspect } from './core/inspect.js'
import { diffTrees, loadSnapshot, renderDiff, saveSnapshot } from './core/snapshot.js'
import { checkMatrix, diffMatrix, snapshotMatrix } from './core/matrix.js'
import { verifyMatrix } from './core/verify.js'
import { forcePseudoStates, type PseudoStates } from './core/state.js'
import { assertNoInteractNavigation, hasInteractSteps, interactWasUnsettled, runInteractSteps, type InteractSteps } from './core/interact.js'
import { animateNote, needsAnimationCapture, settleAnimations, type AnimateOpts } from './core/animate.js'
import { measureStability, renderStability } from './core/stability.js'
import { applyFixes, buildFixes, renderFixes } from './core/fix.js'
import { blame } from './core/blame.js'
import { watch } from './core/watch.js'

const USAGE = `csstruth <command> <url> [options]
  layout    <url> [--selector S] [--depth N]   print the LayoutTree (budgeted to 400 lines unless --depth is given)
  inspect   <url> --selector S                 deep-dive one element
  explain   <url> --selector S --property P    trace a property to its source rule
  check     <url>                              run invariants (exit 1 on violations). --baseline
                                                FILE collapses violations already in FILE to a
                                                "baseline: N accepted violations unchanged" line;
                                                only NEW violations are itemized and drive exit 1,
                                                RESOLVED ones are itemized as "resolved: <rule>
                                                <selector>". Missing FILE is an error. --update-
                                                baseline (requires --baseline) rewrites FILE to
                                                the current set afterward and prints what was
                                                added/removed. check itself defaults to a SINGLE
                                                unlabeled 1280x800 capture (not a matrix, unlike
                                                verify/baseline) — pairing it with a baseline file
                                                requires passing the SAME --viewports to check that
                                                was passed to baseline (or --viewports to neither);
                                                a shape mismatch prints a loud warning instead of
                                                silently reporting everything new
  snapshot  <url> --name NAME [--dir DIR]      lock current LayoutTree to a .tree file
  diff      <url> --name NAME [--dir DIR]      diff current layout vs snapshot
  fix       <url> --root DIR [--apply] [--selector S]
                                                propose (default) or apply mechanical patches for
                                                fixable violations (text-clip, tap-target,
                                                viewport-overflow/parent-bleed with a fixed px
                                                width). DRY-RUN by default: prints one unified-diff-
                                                style hunk per fixable violation (file:line, -/+
                                                lines) and writes nothing. --apply writes the
                                                patches, confined to --root (path traversal from a
                                                suspect's stylesheet URL is rejected), guarded by a
                                                stale-source check (refuses a patch whose expected
                                                declaration text has drifted more than 3 lines from
                                                where it was seen — other patches in the same run
                                                still apply), then re-runs check and prints
                                                "before: N violations -> after: M violations" plus
                                                any NEW violations the patch introduced. Exit 0 only
                                                if M < N and no new violations — except when nothing
                                                was fixable at all: then --apply exits 0 with "no
                                                patches applied" (nothing attempted is not failure)
                                                and no re-check runs. --selector limits
                                                which violations are attempted. Inline <style>/style=
                                                suspects are never patchable (refused, with the
                                                page:line to hand-edit). Accepts --viewport/--hover/
                                                --focus/--active/--click/--scroll-to/--settled/
                                                --at-time like check; not --viewports (apply writes
                                                once — re-run per viewport instead)
  baseline  <url> [--viewports ...] [--file .csstruth-baseline]
                                                capture the CURRENT violation set (after the
                                                same persistence filter check uses) and write
                                                it as a sorted, diff-friendly file, one line
                                                per violation, keyed (viewport, rule, selector)
                                                grouped the SAME way renderViolations displays
                                                them (id-bearing selectors collapse to one
                                                pattern) — px excluded (drifts). ALWAYS runs as
                                                a matrix (like verify), defaulting to
                                                --viewports ${DEFAULT_SWEEP} when --viewports/
                                                --viewport is omitted, so the keys are always
                                                labeled — pair with verify's own default the
                                                same way (neither passes --viewports). check
                                                defaults to a single UNLABELED 1280x800
                                                capture instead, so pairing baseline with check
                                                needs an explicit matching --viewports on both.
                                                Accepts the same --hover/--focus/
                                                --active/--click/--scroll-to/--settled/
                                                --at-time as check, to baseline a forced state.
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
                                                are both given. --baseline/--update-baseline work
                                                exactly as on check (per-viewport, verdict becomes
                                                "PASS (R resolved, N new, B baseline)" /
                                                "FAIL (R resolved, N new, B baseline)" — the delta
                                                decides, not the raw violation count); baseline's
                                                own default is also --viewports ${DEFAULT_SWEEP}, so
                                                pairing verify's default with a default baseline
                                                (neither passing --viewports) just works. A shape
                                                mismatch (e.g. a baseline captured unlabeled, or with
                                                disjoint --viewports) prints a loud warning instead
                                                of silently reporting everything as new
  blame     --root DIR --page REL.html [--selector S] [--max-commits N] [--viewport WxH]
                                                which commit broke the layout. Scope v1: STATIC
                                                roots only — each historical version is served
                                                from a temp 'git worktree add --detach' checkout
                                                with the built-in static server (no dev-server/
                                                build-step support yet; a --serve CMD hook is the
                                                named future path). Determines the CURRENT bad
                                                state (violations at HEAD's working tree for
                                                --page, optionally scoped to --selector's
                                                subtree); if clean, prints "nothing to blame —
                                                page is clean" and exits 0. Otherwise walks HEAD's
                                                ancestors backwards (linear, newest→oldest, capped
                                                at --max-commits, default 25 — linear beats bisect
                                                because layout states can flicker) until it finds
                                                the first GOOD commit; the culprit is the BAD
                                                commit right after it. Prints 'broken by <sha>
                                                "<subject>" (<date>, <author>)', the layout delta
                                                between the good and bad commits, and the
                                                violations introduced. Exit 1 when a culprit is
                                                found; if every commit within the cap is still
                                                bad, prints "still broken N commits back — raise
                                                --max-commits" (also exit 1) — unless the walk
                                                reached the end of history first (fewer commits
                                                exist than the cap), in which case it prints "the
                                                page was never good in this history" instead
                                                (raising --max-commits would find nothing further
                                                back). The user's HEAD/index/working tree are
                                                never touched — all checkouts are detached
                                                worktrees in a scratch temp dir, removed and
                                                pruned afterward.
  watch     <url> [--viewport WxH] [--interval MS]
                                                live diff stream: holds one page open,
                                                polling the settle-signature hash every
                                                --interval ms (default 500, minimum 50 — a
                                                smaller value outraces its own CDP round-trip
                                                and exits 2). On start,
                                                prints the initial check summary, then
                                                "watching <url> (Ctrl+C to stop)". On a
                                                detected change, waits for settle, then
                                                prints the layout delta and any NEW/
                                                RESOLVED violations (deltas only) under a
                                                wall-clock [HH:MM:SS] block — silent
                                                otherwise (no heartbeat spam). A same-URL
                                                full reload (HMR full-refresh) prints
                                                "page reloaded" and continues; navigating
                                                to a DIFFERENT url prints "navigated away
                                                to <url> — stopping" and exits 1. If the
                                                dev server dies, prints "page unreachable
                                                — stopping" and exits 1 (no retry). SIGINT/
                                                SIGTERM shut Chrome down cleanly, exit 0.
                                                CLI only — no MCP tool (a streaming daemon
                                                doesn't fit request/response); run it in a
                                                background shell and read the stream.
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
  options: --attach (use your own Chrome on port 9222 — e.g. logged-in pages — instead of
             launching an isolated headless instance); --port N (attach to Chrome at port N)
           --viewport WxH (emulated viewport size, e.g. 1280x800) — any viewport ≤500px
             wide (the sweep's 375 leg included) emulates a real phone: mobile:true,
             deviceScaleFactor:2, touch enabled — not a desktop window squeezed narrow.
             Bounds are still reported in CSS px regardless. --desktop-only forces the
             old squeezed-desktop emulation (mobile:false, DPR 1) at every width
           --viewports W1xH1,W2xH2,... (check/snapshot/diff/verify/baseline once per viewport)
           --hover S, --focus S, --active S (force a pseudo-state on selector S;
             layout/inspect/explain/check/verify/baseline only, not snapshot/diff)
           --click S (repeatable; real click on selector S — the target is first scrolled
             into view, centered, and the scroll is left where it lands), --scroll-to S_or_Y
             (selector or pixel y) — interaction pre-steps, layout/inspect/explain/check/verify/
             baseline only, not snapshot/diff. Order: navigate, scroll-to, clicks (in argument
             order), settle, then --hover/--focus/--active, then capture
           --settled (fast-forward every CSS transition/animation to its end state before
             capturing — layout/inspect/explain/check/verify/snapshot/diff/baseline; a perpetual
             animation can't end, so it's pinned to its start (t=0) and noted), --at-time N
             (seek every animation to N ms, clamped to its own full duration, instead of its
             end — same commands EXCEPT snapshot/diff, where a specific animation frame isn't
             a deterministic snapshot). Mutually exclusive with each other. Runs after
             interact steps and before --hover/--focus/--active
           --baseline FILE (check/verify only — report only NEW/RESOLVED violations against
             FILE instead of the raw count; see check's own doc above), --update-baseline
             (requires --baseline — rewrite FILE to the current set after this run), --file
             FILE (baseline command only — where to write; default .csstruth-baseline)`

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
  root?: string; apply?: string
  page?: string; 'max-commits'?: string
  interval?: string
  baseline?: string; 'update-baseline'?: string; file?: string
}

// Repeated occurrences of these flags accumulate into an array instead of last-wins.
const REPEATABLE = new Set(['click'])
// Presence-only flags: no value follows, so the parser must not consume the next argv slot.
const BOOLEAN = new Set(['settled', 'apply', 'update-baseline'])

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
  fix: ['root'],
}

async function main(): Promise<number> {
  const cmd = process.argv[2]

  // --attach opts into using a developer's own Chrome on 9222 (logged-in pages); default is
  // an isolated headless launch. Global boolean flag (present anywhere in argv), not a value
  // flag, so it composes with every command's own arg parsing without threading.
  if (process.argv.includes('--attach')) setAttachMode(true)

  // --desktop-only escape hatch (field #3): viewports ≤500px CSS px now emulate a real
  // phone (mobile:true, DPR 2) by default; this restores the old squeezed-desktop
  // emulation everywhere, for callers that relied on the exact prior geometry.
  if (process.argv.includes('--desktop-only')) setDesktopOnly(true)

  // Every command except watch (which owns its own SIGINT/SIGTERM exit-0 contract, armed
  // inside watch() itself) gets this shared safety net: an unhandled Ctrl+C mid-check/
  // layout/blame/etc. must still tear down the Chrome tree, not orphan it (live-confirmed
  // to leak the whole tree without this). blame composes with it: its own per-walk handler
  // defers once it sees more than one SIGINT listener registered, cleaning up its
  // worktrees first and leaving the shutdown+exit to this one.
  if (cmd !== 'watch') {
    // terminal: also latches connect.ts against relaunches — the in-flight command's next
    // withPage would otherwise see launched===null (Chrome just killed) and spawn a fresh
    // Chrome that process.exit(130) abandons (observed on Linux CI).
    const onSignal = () => { void shutdownChrome({ terminal: true }).finally(() => process.exit(130)) }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  }

  // blame takes --root/--page flags, not a positional <url> — handled up front, before the
  // rest of main() assumes argv[3] is a URL.
  if (cmd === 'blame') {
    const f = flags(process.argv.slice(3))
    if (!f.root) { console.error(`blame requires --root\n\n${USAGE}`); return 2 }
    if (!f.page) { console.error(`blame requires --page\n\n${USAGE}`); return 2 }
    if (f['max-commits'] !== undefined && Number.isNaN(Number(f['max-commits']))) {
      console.error(`--max-commits must be a number, got '${f['max-commits']}'`)
      return 2
    }
    if (f.port !== undefined && Number.isNaN(Number(f.port))) {
      console.error(`--port must be a number, got '${f.port}'`)
      return 2
    }
    let viewport: { width: number; height: number } | undefined
    if (f.viewport !== undefined) {
      try { viewport = parseViewport(f.viewport) }
      catch (err) { console.error((err as Error).message); return 2 }
    }
    const { output, dirty } = await blame(f.root, f.page, {
      selector: f.selector,
      maxCommits: f['max-commits'] ? Number(f['max-commits']) : undefined,
      viewport,
      port: f.port ? Number(f.port) : undefined,
    })
    if (dirty) process.exitCode = 1
    console.log(output)
    return Number(process.exitCode ?? 0)
  }

  const url = process.argv[3]
  const f = flags(process.argv.slice(4))
  if (!cmd || !url) { console.error(USAGE); return 2 }
  if (!['layout', 'inspect', 'explain', 'check', 'snapshot', 'diff', 'verify', 'stability', 'fix', 'watch', 'baseline'].includes(cmd)) {
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
  if (stateFlags.length && !['layout', 'inspect', 'explain', 'check', 'verify', 'fix', 'baseline'].includes(cmd)) {
    console.error(`--${stateFlags[0]} is only valid for layout/inspect/explain/check/verify/fix/baseline, not ${cmd} — forced-state snapshots invite stale-state confusion.`)
    return 2
  }
  const interact: InteractSteps = { click: f.click, scrollTo: f['scroll-to'] }
  if (hasInteractSteps(interact) && !['layout', 'inspect', 'explain', 'check', 'verify', 'fix', 'baseline'].includes(cmd)) {
    console.error(`--click/--scroll-to are only valid for layout/inspect/explain/check/verify/fix/baseline, not ${cmd} — interacted-state snapshots invite stale-state confusion.`)
    return 2
  }
  if (cmd === 'fix' && f.viewports !== undefined) {
    console.error(`--viewports is not valid for fix — apply writes files once per run; pass --viewport (singular) or re-run per viewport.`)
    return 2
  }
  if (f.baseline !== undefined && !['check', 'verify'].includes(cmd)) {
    console.error(`--baseline is only valid for check/verify, not ${cmd}.`)
    return 2
  }
  if (f['update-baseline'] !== undefined && f.baseline === undefined) {
    console.error(`--update-baseline requires --baseline FILE.`)
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
  for (const name of ['depth', 'port', 'at-time', 'duration', 'threshold', 'interval']) {
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
  if (stateFlags.length && viewports && !['check', 'verify', 'baseline'].includes(cmd)) {
    console.error(`--${stateFlags[0]} is not supported together with --viewports yet.`)
    return 2
  }
  if (hasInteractSteps(interact) && viewports && !['check', 'verify', 'baseline'].includes(cmd)) {
    console.error(`--click/--scroll-to is not supported together with --viewports yet.`)
    return 2
  }
  const opts = { port: f.port ? Number(f.port) : undefined, viewport, captureAnimations: needsAnimationCapture(animate) }

  if (cmd === 'watch') {
    if (f.viewports !== undefined) {
      console.error(`--viewports is not valid for watch — it holds one page open; pass --viewport (singular).`)
      return 2
    }
    // Below ~50ms the poll tick outraces its own CDP round-trip (readSignature + the
    // reachable() fetch on every tick) — a busy-loop hammering the page instead of a
    // watch interval. An explicit 0 is the sharpest case: `f.interval ? ... : undefined`
    // would otherwise pass it through as a literal 0 (the string '0' is truthy), not the
    // 500ms default.
    if (f.interval !== undefined && Number(f.interval) < 50) {
      console.error(`--interval must be >= 50 (ms), got '${f.interval}'`)
      return 2
    }
    return await watch(url, { port: opts.port, viewport, interval: f.interval !== undefined ? Number(f.interval) : undefined })
  }

  if (cmd === 'baseline') {
    const file = f.file ?? '.csstruth-baseline'
    const states: PseudoStates = { hover: f.hover, focus: f.focus, active: f.active }
    const capture = async (client: any) => {
      await runInteractSteps(client, interact, { skipSettleWait: needsAnimationCapture(animate) })
      await settleAnimations(client, animate)
      await forcePseudoStates(client, states)
      const cap = async () => checkInvariants(buildTree(await extract(client)))
      const { violations, persistenceFiltered } = await checkWithPersistence(layoutNeverSettled(client), cap)
      assertNoInteractNavigation(client)
      return { violations, persistenceFiltered }
    }
    // Field #6 fix: baseline ALWAYS runs as a matrix now, defaulting to DEFAULT_SWEEP —
    // matching verify's own default so the README quickstart (`baseline <url>` then
    // `verify <url> --baseline`, neither passing --viewports) actually pairs up. --viewport
    // (singular) acts as a one-entry sweep, same convention as verify's own --viewport.
    const vps = viewports ?? parseViewportList(f.viewport ?? DEFAULT_SWEEP)
    const results = await forEachViewport(url, vps, async (client, vp) => {
      const { violations, persistenceFiltered } = await capture(client)
      return { keys: violations.map((v) => baselineKey(vp.label, v)), persistenceFiltered }
    }, opts)
    const keys = results.flatMap((r) => r.result.keys)
    // Same note check/verify give for a filtered capture — otherwise a baseline pinned from
    // a never-settling page reads identically to a normal one.
    const persistenceNote = results.some((r) => r.result.persistenceFiltered)
      ? '\nnote: page never settled — reporting only violations stable across two captures' : ''
    writeBaselineFile(file, keys)
    const n = new Set(keys).size
    console.log(`baseline written: ${file} (${n} violation${n === 1 ? '' : 's'})${persistenceNote}`)
    return 0
  }

  if (cmd === 'fix') {
    const root = f.root!
    const apply = f.apply !== undefined
    const states: PseudoStates = { hover: f.hover, focus: f.focus, active: f.active }
    const capture = async (client: any) => {
      await runInteractSteps(client, interact, { skipSettleWait: needsAnimationCapture(animate) })
      await settleAnimations(client, animate)
      await forcePseudoStates(client, states)
      return checkInvariants(buildTree(await extract(client)))
    }

    const { violations: beforeViolations, outcomes } = await withPage(url, async (client) => {
      const violations = await capture(client)
      const toFix = f.selector ? violations.filter((v) => v.selector.includes(f.selector as string)) : violations
      const outcomes = await buildFixes(client, url, toFix, root)
      return { violations, outcomes }
    }, opts)

    console.log(renderFixes(outcomes))
    if (!apply) return 0

    if (!outcomes.some((o) => o.kind === 'patch')) {
      console.log('\nno patches applied')
      return 0
    }
    for (const msg of applyFixes(outcomes)) console.log(msg)

    const afterViolations = await withPage(url, capture, opts)
    const beforeKeys = new Set(beforeViolations.map((v) => `${v.rule} ${v.selector}`))
    const newViolations = afterViolations.filter((v) => !beforeKeys.has(`${v.rule} ${v.selector}`))
    console.log(`\nbefore: ${beforeViolations.length} violations → after: ${afterViolations.length} violations`)
    if (newViolations.length) {
      console.log('NEW violations introduced:')
      for (const v of newViolations) console.log(`  ${v.rule}: ${v.message}`)
    }
    if (!(afterViolations.length < beforeViolations.length && newViolations.length === 0)) process.exitCode = 1
    return Number(process.exitCode ?? 0)
  }

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
    // Missing FILE throws loadBaselineFile's resolved-path error, caught by main()'s
    // top-level .catch() (contract 3) — same as loadSnapshot's existing propagation.
    const baseline = f.baseline !== undefined ? loadBaselineFile(f.baseline) : undefined
    // --viewport (singular) acts as a one-entry sweep; --viewports wins when both are given
    const { output, dirty, baselineSummary } = await verifyMatrix(url, viewports ?? parseViewportList(f.viewport ?? DEFAULT_SWEEP), {
      port: opts.port,
      states: stateFlags.length ? states : undefined,
      interact: hasInteractSteps(interact) ? interact : undefined,
      animate: needsAnimationCapture(animate) ? animate : undefined,
      name: f.name,
      dir: f.dir,
      baseline,
    })
    let out = output
    if (f['update-baseline'] !== undefined && baselineSummary) {
      out += `\n${applyBaselineUpdate(f.baseline!, baselineSummary)}`
    }
    if (dirty) process.exitCode = 1
    console.log(out)
    return Number(process.exitCode ?? 0)
  }

  if (viewports && ['check', 'snapshot', 'diff'].includes(cmd)) {
    const mopts = { port: opts.port }
    if (cmd === 'check') {
      const states: PseudoStates = { hover: f.hover, focus: f.focus, active: f.active }
      const baseline = f.baseline !== undefined ? loadBaselineFile(f.baseline) : undefined
      const { output, dirty, baselineSummary } = await checkMatrix(url, viewports, { ...mopts, states, interact, animate, baseline })
      let out = output
      if (f['update-baseline'] !== undefined && baselineSummary) {
        out += `\n${applyBaselineUpdate(f.baseline!, baselineSummary)}`
      }
      if (dirty) process.exitCode = 1
      console.log(out)
      return Number(process.exitCode ?? 0)
    }
    if (cmd === 'snapshot') console.log(await snapshotMatrix(url, viewports, f.name, f.dir, { ...mopts, settled: animate.settled }))
    else console.log(await diffMatrix(url, viewports, f.name, f.dir, { ...mopts, settled: animate.settled }))
    return Number(process.exitCode ?? 0)
  }

  const states: PseudoStates = { hover: f.hover, focus: f.focus, active: f.active }
  // Missing FILE throws loadBaselineFile's resolved-path error before Chrome even
  // launches — same top-level .catch() as verify/checkMatrix above (contract 3).
  const baseline = cmd === 'check' && f.baseline !== undefined ? loadBaselineFile(f.baseline) : undefined
  let baselineDelta: BaselineDelta | undefined
  const output = await withPage(url, async (client) => {
    await runInteractSteps(client, interact, { skipSettleWait: needsAnimationCapture(animate) })
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
        const capture = async () => checkInvariants(buildTree(await extract(client)))
        const { violations, persistenceFiltered } = await checkWithPersistence(layoutNeverSettled(client), capture)
        // Field #6: without --baseline, byte-identical to today.
        const delta = baseline ? diffBaseline(baseline, undefined, violations) : undefined
        baselineDelta = delta
        const toRender = delta ? delta.newViolations : violations
        const baselineNote = delta ? renderBaselineNote(delta) : ''
        // Loud safety net (field #6 follow-up): this path is always single-page (never a
        // matrix), so a baseline captured as a labeled matrix can never match here.
        const shapeWarning = baseline ? baselineShapeWarning(baseline, undefined) : ''
        if ((delta ? delta.newViolations.length : violations.length) > 0) process.exitCode = 1
        result = (shapeWarning ? `${shapeWarning}\n` : '') + (await renderViolations(client, toRender)) + (baselineNote ? `\n${baselineNote}` : '') +
          (persistenceFiltered ? '\nnote: page never settled — reporting only violations stable across two captures' : '')
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
    // A click's delayed redirect can land during the switch's capture above, after
    // runInteractSteps already returned clean — check again now (see interact.ts).
    assertNoInteractNavigation(client)
    if (interactWasUnsettled(client)) result += '\nnote: page had not settled after interactions'
    return result + animateNote(client)
  }, opts)

  let out = output
  if (cmd === 'check' && f['update-baseline'] !== undefined && baselineDelta) {
    out += `\n${applyBaselineUpdate(f.baseline!, { added: baselineDelta.addedKeys, removed: baselineDelta.resolvedKeys, allCurrent: baselineDelta.currentKeys })}`
  }
  console.log(out)
  return Number(process.exitCode ?? 0)
}

main()
  .then((code) => { process.exitCode = code })
  .catch((err) => {
    // 'shutting down' is a signal handler's terminal latch rejecting in-flight work —
    // the handler exits 130/0 on its own; a raw stderr line here would be noise.
    if (err.message !== 'shutting down') { console.error(err.message); process.exitCode = 2 }
  })
  .finally(() => shutdownChrome())
