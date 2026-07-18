#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { DEFAULT_SWEEP, forEachViewport, layoutNeverSettled, pageWasBusy, parseViewport, parseViewportList, shutdownChrome, withPage } from './core/connect.js'
import { extract } from './core/extract.js'
import { buildTree, findNode, renderTree } from './core/tree.js'
import { checkInvariants, checkWithPersistence, renderViolations } from './core/invariants.js'
import { applyBaselineUpdate, baselineKey, baselineShapeWarning, diffBaseline, loadBaselineFile, renderBaselineNote, writeBaselineFile } from './core/baseline.js'
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

const server = new McpServer({ name: 'csstruth', version: '0.1.0' })

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const url = z.string().describe('Page URL (usually your dev server)')
const port = z.number().optional().describe('Chrome debugging port (default: 9222 or auto-launched headless)')
const viewport = z.string().optional().describe('Emulated viewport size as WxH, e.g. 1280x800 (default: 1280x800)')
const viewports = z.string().optional().describe('Comma-separated WxH list, e.g. "600x800,1280x800" — runs once per viewport, prefixing each output line with [WxH] (check/snapshot/diff only; overrides viewport when given)')
// see the layout consequences of interaction states without a mouse — layout/inspect/explain/check only,
// not snapshot/diff (forced-state snapshots invite stale-state confusion)
const hover = z.string().optional().describe('Force :hover on this selector before reading the page')
const focus = z.string().optional().describe('Force :focus on this selector before reading the page')
const active = z.string().optional().describe('Force :active on this selector before reading the page')
// interaction pre-steps — layout/inspect/explain/check/verify only, not snapshot/diff (same
// stale-state reasoning as hover/focus/active). Order: scrollTo, then click(s) in array
// order, then a settle wait, then hover/focus/active, then capture.
const click = z.array(z.string()).optional().describe('Real trusted click(s) on these selectors, in order, before reading the page. Each target is first scrolled into view (centered) and the scroll is left where it lands. Runs after scrollTo and before hover/focus/active. Aborts if a click navigates to a new page.')
const scrollTo = z.string().optional().describe('Scroll to this selector (scrollIntoView) or pixel Y before reading the page. Runs before click(s).')
// --settled/--at-time — layout/inspect/explain/check/verify get both; snapshot/diff get
// settled ONLY (a specific animation frame isn't a deterministic snapshot). Runs after
// interact steps and before hover/focus/active.
const settled = z.boolean().optional().describe('Fast-forward every CSS transition/animation to its end state before reading the page. A perpetual animation (e.g. a spinner) can\'t end, so it\'s pinned to its start (t=0) for determinism, with a note. Recommended when the page has animations, for a deterministic read. Mutually exclusive with atTime.')
const atTime = z.number().optional().describe('Seek every animation to this many ms (instead of its end), clamped to each animation\'s own full duration (delay + duration x iterations). Mutually exclusive with settled.')

// snapshot/diff/stability don't support some of the params above — declared here as
// optional (not omitted) so a schema-driven agent can see the param exists and read why
// it's refused, instead of it silently vanishing (the old behavior: these tools never
// declared them, so the zod shape just dropped anything unknown). The handlers below
// throw the CLI's exact rejection wording for the same case.
const rejectedStr = (why: string) => z.string().optional().describe(`NOT supported here — ${why} Declared so you can see it exists; passing it throws.`)
const rejectedArr = (why: string) => z.array(z.string()).optional().describe(`NOT supported here — ${why} Declared so you can see it exists; passing it throws.`)
const rejectedBool = (why: string) => z.boolean().optional().describe(`NOT supported here — ${why} Declared so you can see it exists; passing it throws.`)
const rejectedNum = (why: string) => z.number().optional().describe(`NOT supported here — ${why} Declared so you can see it exists; passing it throws.`)

const STALE_STATE = 'forced/interacted-state captures invite stale-state confusion; use layout/inspect/explain/check/verify.'
const NOT_A_SNAPSHOT = 'a snapshot must be a deterministic capture, not one pinned to a specific animation frame; use settled instead.'
const STABILITY_SCOPE = 'it observes one natural page load (no animation seeking, no viewport matrix).'

// Throws the CLI's exact wording (cli.ts's stateFlags/hasInteractSteps checks) for one
// consistent error surface across both front ends.
function rejectStateAndInteract(
  tool: string, args: { hover?: string; focus?: string; active?: string; click?: string[]; scrollTo?: string },
): void {
  const stateFlag = (['hover', 'focus', 'active'] as const).find((k) => args[k] !== undefined)
  if (stateFlag) throw new Error(`--${stateFlag} is only valid for layout/inspect/explain/check/verify, not ${tool} — forced-state snapshots invite stale-state confusion.`)
  if ((args.click?.length ?? 0) > 0 || args.scrollTo !== undefined) {
    throw new Error(`--click/--scroll-to are only valid for layout/inspect/explain/check/verify, not ${tool} — interacted-state snapshots invite stale-state confusion.`)
  }
}

function page(
  u: string,
  opts: { port?: number; viewport?: string; states?: PseudoStates; interact?: InteractSteps; animate?: AnimateOpts },
  fn: (client: any) => Promise<string>,
) {
  // Cheap pre-Chrome rejection, mirroring the CLI's upfront check (cli.ts validates
  // before withPage too) — settleAnimations already throws this at its shared choke
  // point as a backstop, but only after a full page load, wasting it on a request that
  // was always going to fail.
  if (opts.animate?.settled && opts.animate?.atTime !== undefined) {
    throw new Error('settled and atTime are mutually exclusive — pick one.')
  }
  return withPage(u, async (client) => {
    await runInteractSteps(client, opts.interact ?? {}, { skipSettleWait: needsAnimationCapture(opts.animate ?? {}) })
    await settleAnimations(client, opts.animate ?? {})
    if (opts.states) await forcePseudoStates(client, opts.states)
    let out = await fn(client)
    // A click's delayed redirect can land during fn's capture, after runInteractSteps
    // already returned clean — check again now (see interact.ts).
    assertNoInteractNavigation(client)
    if (pageWasBusy(client)) out += '\nnote: page was still loading at the 10s cap; results may be early'
    if (interactWasUnsettled(client)) out += '\nnote: page had not settled after interactions'
    return text(out + animateNote(client))
  }, {
    port: opts.port, viewport: opts.viewport ? parseViewport(opts.viewport) : undefined,
    captureAnimations: needsAnimationCapture(opts.animate ?? {}),
  })
}

server.tool('layout', 'Compact deterministic layout tree of the rendered page: positions, sizes, layout modes, inline ⚠ warnings. THE ground-truth view — read this before and after CSS changes. Budgeted to 400 lines by default (auto-truncated to the deepest depth that fits, with a note); pass depth to see the full tree from the root, or selector to scope to a subtree. Pass scrollTo/click to interact with the page first (order: scrollTo, then click(s), then settle), then settled/atTime to fast-forward or seek animations, then hover/focus/active to see the layout consequences of interaction states without a mouse.',
  { url, port, viewport, selector: z.string().optional().describe('Scope to this element'), depth: z.number().optional().describe('Max tree depth (disables the default 400-line budget)'), hover, focus, active, click, scrollTo, settled, atTime },
  ({ url: u, port: p, viewport: v, selector, depth, hover: h, focus: fo, active: a, click: cl, scrollTo: st, settled: se, atTime: at }) => page(u, { port: p, viewport: v, states: { hover: h, focus: fo, active: a }, interact: { click: cl, scrollTo: st }, animate: { settled: se, atTime: at } }, async (client) => {
    const tree = buildTree(await extract(client))
    checkInvariants(tree)
    const from = selector ? findNode(tree, selector) : undefined
    if (selector && !from) return `No element matching '${selector}' in the layout tree. Run layout without a selector to see what exists.`
    return renderTree(tree, { depth, from, budget: depth === undefined ? 400 : undefined })
  }))

server.tool('inspect', 'Deep-dive ONE element: box model, every non-default computed style, stacking context, and why it has its width/height. Pass scrollTo/click to interact with the page first (order: scrollTo, then click(s), then settle), then settled/atTime to fast-forward or seek animations, then hover/focus/active to see the layout consequences of interaction states without a mouse.',
  { url, port, viewport, selector: z.string().describe('CSS selector of the element'), hover, focus, active, click, scrollTo, settled, atTime },
  ({ url: u, port: p, viewport: v, selector, hover: h, focus: fo, active: a, click: cl, scrollTo: st, settled: se, atTime: at }) => page(u, { port: p, viewport: v, states: { hover: h, focus: fo, active: a }, interact: { click: cl, scrollTo: st }, animate: { settled: se, atTime: at } }, (client) => inspect(client, selector)))

server.tool('explain', 'Trace one CSS property to its source: which rule wins (file:line, source-mapped), which rules lost and why (specificity/order/importance), and whether layout constraints override the declared value. Pass scrollTo/click to interact with the page first (order: scrollTo, then click(s), then settle), then settled/atTime to fast-forward or seek animations, then hover/focus/active to see the layout consequences of interaction states without a mouse.',
  { url, port, viewport, selector: z.string(), property: z.string().describe("e.g. 'width'"), hover, focus, active, click, scrollTo, settled, atTime },
  ({ url: u, port: p, viewport: v, selector, property, hover: h, focus: fo, active: a, click: cl, scrollTo: st, settled: se, atTime: at }) => page(u, { port: p, viewport: v, states: { hover: h, focus: fo, active: a }, interact: { click: cl, scrollTo: st }, animate: { settled: se, atTime: at } }, async (client) =>
    renderExplanation(await explain(client, selector, property))))

const baselineParam = z.string().optional().describe("Path to a baseline file (written by the baseline tool). Violations whose (viewport?, rule, selector) key is already IN the file collapse to a 'baseline: N accepted violations unchanged' line; only NEW violations are itemized and drive the verdict, RESOLVED ones (in the file, no longer present) are itemized as 'resolved: <rule> <selector>' — the delta decides, not the raw count. The viewport is only part of the key when viewports was given to the baseline tool too — pair capture and comparison the same way. Missing file throws.")
const updateBaselineParam = z.boolean().optional().describe('Rewrite the baseline file to the current violation set after this call (adopting intentional changes) — appends what was added/removed. Requires baseline.')

server.tool('check', 'Run layout invariants (overflow, bleed, clipped text, unintended overlap, zero-size/tiny interactive elements). Violations are ALWAYS bugs — fix them. Pass scrollTo/click to interact with the page first (order: scrollTo, then click(s), then settle), then settled/atTime to fast-forward or seek animations, then hover/focus/active to see the layout consequences of interaction states without a mouse — combinable with viewports, re-running scrollTo/click(s)/settled/state fresh inside each one. Pass baseline to report only NEW/RESOLVED violations against a file written by the baseline tool, instead of an all-or-nothing list — the fix for a page that is not, and may never be, fully clean.',
  { url, port, viewport, viewports, hover, focus, active, click, scrollTo, settled, atTime, baseline: baselineParam, updateBaseline: updateBaselineParam },
  ({ url: u, port: p, viewport: v, viewports: vs, hover: h, focus: fo, active: a, click: cl, scrollTo: st, settled: se, atTime: at, baseline, updateBaseline }) => {
    const baselineSet = baseline !== undefined ? loadBaselineFile(baseline) : undefined
    if (vs) {
      return checkMatrix(u, parseViewportList(vs), { port: p, states: { hover: h, focus: fo, active: a }, interact: { click: cl, scrollTo: st }, animate: { settled: se, atTime: at }, baseline: baselineSet }).then((r) => {
        let out = r.output
        if (updateBaseline && r.baselineSummary) out += `\n${applyBaselineUpdate(baseline!, r.baselineSummary)}`
        return text(out)
      })
    }
    return page(u, { port: p, viewport: v, states: { hover: h, focus: fo, active: a }, interact: { click: cl, scrollTo: st }, animate: { settled: se, atTime: at } }, async (client) => {
      const capture = async () => checkInvariants(buildTree(await extract(client)))
      const { violations, persistenceFiltered } = await checkWithPersistence(layoutNeverSettled(client), capture)
      const delta = baselineSet ? diffBaseline(baselineSet, undefined, violations) : undefined
      const toRender = delta ? delta.newViolations : violations
      const baselineNote = delta ? renderBaselineNote(delta) : ''
      // Loud safety net (field #6 follow-up): this path is always single-page (never a
      // matrix), so a baseline captured as a labeled matrix can never match here.
      const shapeWarning = baselineSet ? baselineShapeWarning(baselineSet, undefined) : ''
      let out = (shapeWarning ? `${shapeWarning}\n` : '') + (await renderViolations(client, toRender)) + (baselineNote ? `\n${baselineNote}` : '') +
        (persistenceFiltered ? '\nnote: page never settled — reporting only violations stable across two captures' : '')
      if (updateBaseline && delta) out += `\n${applyBaselineUpdate(baseline!, { added: delta.addedKeys, removed: delta.resolvedKeys, allCurrent: delta.currentKeys })}`
      return out
    })
  })

server.tool('fix', 'Propose (default) or APPLY mechanical patches for fixable violations (text-clip, tap-target, viewport-overflow/parent-bleed with a fixed px width) — everything else reports "no mechanical fix for <rule> — see suspect". DRY-RUN unless apply=true: prints one unified-diff-style hunk per fixable violation (file:line, -/+ lines) and writes nothing. apply=true EDITS FILES ON DISK, confined to root (path traversal from a suspect stylesheet URL is rejected — resolved and verified to stay inside root); each patch is guarded by a stale-source check (refuses a patch whose expected declaration text has drifted from where it was last seen, tolerating small line shifts — other patches in the same call still apply). After applying, automatically re-runs check and reports "before: N violations -> after: M violations" plus any NEW violations the patch introduced (regression honesty) — isError is set unless the fix strictly improved things (M < N and no new violations). When NOTHING was fixable, apply=true returns "no patches applied" with no error and no re-check (nothing attempted is not failure). selector limits which violations are attempted (substring match against the rendered selector). Inline <style>/style= suspects are never patchable — refused, with the page:line to hand-edit instead. Pass scrollTo/click/settled/atTime/hover/focus/active exactly as for check. viewports (matrix) is NOT supported — apply writes once per call; pass viewport (singular) or call fix again per viewport.',
  {
    url, port, viewport,
    root: z.string().describe('Local directory that stylesheet URLs are resolved against, and — with apply=true — written into. Writes outside this directory are refused.'),
    apply: z.boolean().optional().describe('Write the proposed patches to disk. Default false: dry-run, prints patches only, writes nothing.'),
    selector: z.string().optional().describe('Only attempt to fix violations whose rendered selector contains this'),
    hover, focus, active, click, scrollTo, settled, atTime,
    viewports: rejectedStr('apply writes files once per call; pass viewport (singular) or call fix again per viewport.'),
  },
  ({ url: u, port: p, viewport: v, root, apply, selector, hover: h, focus: fo, active: a, click: cl, scrollTo: st, settled: se, atTime: at, viewports: vs }) => {
    if (vs !== undefined) throw new Error(`viewports is not valid for fix — apply writes files once per call; pass viewport (singular) or call fix again per viewport.`)
    const states: PseudoStates = { hover: h, focus: fo, active: a }
    const interact: InteractSteps = { click: cl, scrollTo: st }
    const animate: AnimateOpts = { settled: se, atTime: at }
    const pageOpts = { port: p, viewport: v ? parseViewport(v) : undefined, captureAnimations: needsAnimationCapture(animate) }
    const capture = async (client: any) => {
      await runInteractSteps(client, interact, { skipSettleWait: needsAnimationCapture(animate) })
      await settleAnimations(client, animate)
      await forcePseudoStates(client, states)
      return checkInvariants(buildTree(await extract(client)))
    }
    return (async () => {
      const { violations: beforeViolations, outcomes } = await withPage(u, async (client) => {
        const violations = await capture(client)
        const toFix = selector ? violations.filter((vi) => vi.selector.includes(selector)) : violations
        const fixOutcomes = await buildFixes(client, u, toFix, root)
        return { violations, outcomes: fixOutcomes }
      }, pageOpts)

      let out = renderFixes(outcomes)
      if (!apply) return text(out)
      if (!outcomes.some((o) => o.kind === 'patch')) return text(`${out}\n\nno patches applied`)

      const skipped = applyFixes(outcomes)
      if (skipped.length) out += `\n${skipped.join('\n')}`
      const afterViolations = await withPage(u, capture, pageOpts)
      const beforeKeys = new Set(beforeViolations.map((vi) => `${vi.rule} ${vi.selector}`))
      const newViolations = afterViolations.filter((vi) => !beforeKeys.has(`${vi.rule} ${vi.selector}`))
      out += `\n\nbefore: ${beforeViolations.length} violations → after: ${afterViolations.length} violations`
      if (newViolations.length) out += `\nNEW violations introduced:\n${newViolations.map((vi) => `  ${vi.rule}: ${vi.message}`).join('\n')}`
      const ok = afterViolations.length < beforeViolations.length && newViolations.length === 0
      return { content: [{ type: 'text' as const, text: out }], isError: !ok }
    })()
  })

server.tool('snapshot', 'Lock the current layout as a named .tree snapshot for later diffing. Do this when the page looks CORRECT. Pass settled (recommended for animated pages, for a deterministic snapshot). atTime is NOT supported here — a specific animation frame pinned by hand is not a reproducible baseline; use layout/check with atTime to inspect mid-animation states instead.',
  {
    url, port, viewport, viewports, name: z.string(), dir: z.string().optional().describe("Snapshot dir (default .csstruth relative to the MCP server's working directory — pass an absolute path when the server isn't launched from your project root)"), settled,
    hover: rejectedStr(STALE_STATE), focus: rejectedStr(STALE_STATE), active: rejectedStr(STALE_STATE),
    click: rejectedArr(STALE_STATE), scrollTo: rejectedStr(STALE_STATE), atTime: rejectedNum(NOT_A_SNAPSHOT),
  },
  ({ url: u, port: p, viewport: v, viewports: vs, name, dir, settled: se, hover: h, focus: fo, active: a, click: cl, scrollTo: st, atTime: at }) => {
    rejectStateAndInteract('snapshot', { hover: h, focus: fo, active: a, click: cl, scrollTo: st })
    if (at !== undefined) throw new Error(`--at-time is not valid for snapshot — ${NOT_A_SNAPSHOT}`)
    return vs
      ? snapshotMatrix(u, parseViewportList(vs), name, dir, { port: p, settled: se }).then((s) => text(s))
      : page(u, { port: p, viewport: v, animate: { settled: se } }, async (client) => {
        const tree = buildTree(await extract(client))
        checkInvariants(tree)
        return `saved ${saveSnapshot(renderTree(tree), name, dir)}`
      })
  })

server.tool('diff', 'Structural diff of the current layout vs a named snapshot: what moved/resized/appeared/disappeared, in px. Run after every CSS change to see its actual effect. Pass settled (recommended for animated pages, matching how the snapshot was likely taken). atTime is NOT supported here — a specific animation frame pinned by hand is not a reproducible baseline; use layout/check with atTime to inspect mid-animation states instead.',
  {
    url, port, viewport, viewports, name: z.string(), dir: z.string().optional().describe("Snapshot dir (default .csstruth relative to the MCP server's working directory — pass an absolute path when the server isn't launched from your project root)"), settled,
    hover: rejectedStr(STALE_STATE), focus: rejectedStr(STALE_STATE), active: rejectedStr(STALE_STATE),
    click: rejectedArr(STALE_STATE), scrollTo: rejectedStr(STALE_STATE), atTime: rejectedNum(NOT_A_SNAPSHOT),
  },
  ({ url: u, port: p, viewport: v, viewports: vs, name, dir, settled: se, hover: h, focus: fo, active: a, click: cl, scrollTo: st, atTime: at }) => {
    rejectStateAndInteract('diff', { hover: h, focus: fo, active: a, click: cl, scrollTo: st })
    if (at !== undefined) throw new Error(`--at-time is not valid for diff — ${NOT_A_SNAPSHOT}`)
    return vs
      ? diffMatrix(u, parseViewportList(vs), name, dir, { port: p, settled: se }).then((s) => text(s))
      : page(u, { port: p, viewport: v, animate: { settled: se } }, async (client) => {
        const tree = buildTree(await extract(client))
        checkInvariants(tree)
        return renderDiff(diffTrees(loadSnapshot(name, dir), renderTree(tree)))
      })
  })

server.tool('verify', `Composite one-shot "is this page correct": runs layout invariants and, if a name is given, also diffs a locked snapshot — across a viewport sweep, in a single call. FIRST line of the output is always VERDICT: PASS or VERDICT: FAIL (violations + layout changes), so you can branch on line 1 without parsing details. Defaults to the ${DEFAULT_SWEEP} sweep when viewports is omitted — verify always runs as a matrix, even with one viewport, so snapshot files are always named <name>@WxH (never plain <name>.tree). Pass scrollTo/click to interact with the page first (order: scrollTo, then click(s), then settle), then settled/atTime to fast-forward or seek animations, then hover/focus/active to see the layout consequences of interaction states without a mouse. settled is RECOMMENDED whenever the page has animations — the default behavior is unchanged (no seeking) otherwise. IMPORTANT: states, interact steps, and atTime affect the invariant check only — the snapshot diff always compares the resting (unforced, un-interacted, not-pinned-to-a-frame) layout, applying settled if given (since diffing a forced/interacted layout against a resting snapshot would always report a change); this costs a second page load per viewport when states/interact are combined with name. A missing per-viewport snapshot is reported as a note, not a failure (snapshot only the viewports you care about). Pass baseline (a file written by the baseline tool, itself captured with the SAME viewports) to turn the verdict into a delta: "PASS (R resolved, N new, B baseline)" when nothing new broke, exit-worthy only on N > 0 — the fix for adopting verify as a CI gate on a page that isn't fully clean yet.`,
  {
    url, port, viewports, hover, focus, active, click, scrollTo, settled, atTime, name: z.string().optional(), dir: z.string().optional().describe("Snapshot dir (default .csstruth relative to the MCP server's working directory — pass an absolute path when the server isn't launched from your project root)"),
    baseline: baselineParam, updateBaseline: updateBaselineParam,
  },
  ({ url: u, port: p, viewports: vs, hover: h, focus: fo, active: a, click: cl, scrollTo: st, settled: se, atTime: at, name, dir, baseline, updateBaseline }) => {
    const hasStates = h !== undefined || fo !== undefined || a !== undefined
    const interact: InteractSteps = { click: cl, scrollTo: st }
    const animate: AnimateOpts = { settled: se, atTime: at }
    const baselineSet = baseline !== undefined ? loadBaselineFile(baseline) : undefined
    return verifyMatrix(u, parseViewportList(vs ?? DEFAULT_SWEEP), {
      port: p, states: hasStates ? { hover: h, focus: fo, active: a } : undefined,
      interact: hasInteractSteps(interact) ? interact : undefined,
      animate: needsAnimationCapture(animate) ? animate : undefined, name, dir, baseline: baselineSet,
    }).then((r) => {
      let out = r.output
      if (updateBaseline && r.baselineSummary) out += `\n${applyBaselineUpdate(baseline!, r.baselineSummary)}`
      return text(out)
    })
  })

server.tool('baseline', 'Capture the CURRENT violation set (after the same persistence filter check/verify use) and write it to a file: sorted, human-readable, diff-friendly, one line per violation, keyed (viewport?, rule, selector) — px excluded (it drifts run to run). The viewport is only part of the key when viewports is given here — pair with check/verify\'s baseline param by matching viewports (or leaving it off) on both sides, and the SAME hover/focus/active/click/scrollTo/settled/atTime, so the key set lines up. This is field #6\'s CI unblocker: run this once against a page that has known-benign violations, then check/verify --baseline reports only NEW/RESOLVED violations instead of an all-or-nothing PASS/FAIL.',
  {
    url, port, viewport, viewports,
    file: z.string().optional().describe("Baseline file path (default .csstruth-baseline, relative to the MCP server's working directory — pass an absolute path when the server isn't launched from your project root)"),
    hover, focus, active, click, scrollTo, settled, atTime,
  },
  ({ url: u, port: p, viewport: v, viewports: vs, file, hover: h, focus: fo, active: a, click: cl, scrollTo: st, settled: se, atTime: at }) => {
    const path = file ?? '.csstruth-baseline'
    const states: PseudoStates = { hover: h, focus: fo, active: a }
    const interact: InteractSteps = { click: cl, scrollTo: st }
    const animate: AnimateOpts = { settled: se, atTime: at }
    const capture = async (client: any) => {
      await runInteractSteps(client, interact, { skipSettleWait: needsAnimationCapture(animate) })
      await settleAnimations(client, animate)
      await forcePseudoStates(client, states)
      const cap = async () => checkInvariants(buildTree(await extract(client)))
      const { violations, persistenceFiltered } = await checkWithPersistence(layoutNeverSettled(client), cap)
      assertNoInteractNavigation(client)
      return { violations, persistenceFiltered }
    }
    const pageOpts = { port: p, viewport: v ? parseViewport(v) : undefined, captureAnimations: needsAnimationCapture(animate) }
    return (async () => {
      const results = vs
        ? (await forEachViewport(u, parseViewportList(vs), async (client, vp) => {
          const { violations, persistenceFiltered } = await capture(client)
          return { keys: violations.map((vi) => baselineKey(vp.label, vi)), persistenceFiltered }
        }, pageOpts)).map((r) => r.result)
        : [await withPage(u, async (client) => {
          const { violations, persistenceFiltered } = await capture(client)
          return { keys: violations.map((vi) => baselineKey(undefined, vi)), persistenceFiltered }
        }, pageOpts)]
      const keys = results.flatMap((r) => r.keys)
      // Same note check/verify give for a filtered capture — otherwise a baseline pinned
      // from a never-settling page reads identically to a normal one.
      const persistenceNote = results.some((r) => r.persistenceFiltered)
        ? '\nnote: page never settled — reporting only violations stable across two captures' : ''
      writeBaselineFile(path, keys)
      const n = new Set(keys).size
      return text(`baseline written: ${path} (${n} violation${n === 1 ? '' : 's'})${persistenceNote}`)
    })()
  })

server.tool('stability', 'Load-time layout-shift report (Cumulative Layout Shift): waits `duration` ms (default 3000) past load, then reports every shift — timing, the moved element\'s selector, its before/after box, and its score — plus any img/video shift source missing width/height attributes (the #1 CLS cause). First line is always STABILITY: <score> (threshold <t>). Score is the raw sum over the observation window; the CWV metric uses session windows — multi-burst pages may score higher here. TIMING-DEPENDENT: this is an OBSERVATION, not a deterministic snapshot — local dev servers under-report; throttle CPU/network to reproduce production shifts. No interact/state/settled params (out of scope) or viewports (single viewport only).',
  {
    url, port, viewport, duration: z.number().optional().describe('Milliseconds to observe past load before collecting shifts (default 3000)'), threshold: z.number().optional().describe('Score above which this is reported as unstable (default 0.1, the Core Web Vitals "good" boundary)'),
    hover: rejectedStr(STALE_STATE), focus: rejectedStr(STALE_STATE), active: rejectedStr(STALE_STATE),
    click: rejectedArr(STALE_STATE), scrollTo: rejectedStr(STALE_STATE),
    settled: rejectedBool(STABILITY_SCOPE), atTime: rejectedNum(STABILITY_SCOPE), viewports: rejectedStr(STABILITY_SCOPE),
  },
  ({ url: u, port: p, viewport: v, duration, threshold, hover: h, focus: fo, active: a, click: cl, scrollTo: st, settled: se, atTime: at, viewports: vs }) => {
    rejectStateAndInteract('stability', { hover: h, focus: fo, active: a, click: cl, scrollTo: st })
    for (const [flag, val] of [['settled', se], ['at-time', at], ['viewports', vs]] as const) {
      if (val !== undefined) throw new Error(`--${flag} is not valid for stability — ${STABILITY_SCOPE}`)
    }
    return measureStability(u, { port: p, viewport: v ? parseViewport(v) : undefined, duration, threshold }).then((r) => text(renderStability(r)))
  })

server.tool('blame', 'Which commit broke the layout. Scope v1: STATIC roots only — each historical version is served from a temp `git worktree add --detach` checkout with the built-in static server (no dev-server/build-step support yet). Determines the CURRENT bad state (violations at HEAD\'s working tree for `page`, optionally scoped to `selector`\'s subtree); if clean, returns "nothing to blame — page is clean". Otherwise walks HEAD\'s ancestors backwards (linear, newest→oldest, capped at maxCommits, default 25 — linear beats bisect because layout states can flicker) until it finds the first GOOD commit; the culprit is the BAD commit right after it. Returns `broken by <sha> "<subject>" (<date>, <author>)`, the layout delta between the good and bad commits (moved/resized/appeared/disappeared, in px), and the violations introduced. If every commit within the cap is still bad: "still broken N commits back — raise maxCommits" — unless the walk reached the end of history first (fewer commits exist than the cap), in which case it returns "the page was never good in this history" instead. The user\'s HEAD/index/working tree are never touched — all checkouts are detached worktrees in a scratch temp dir, removed and pruned afterward.',
  {
    root: z.string().describe('Local git repo directory (or a subdirectory of one) containing the page — git finds the repo root'),
    page: z.string().describe('Page path relative to root, e.g. index.html'),
    selector: z.string().optional().describe("Scope violations to this selector's subtree (substring match, same convention as fix's selector)"),
    maxCommits: z.number().optional().describe('How many ancestor commits to walk back before giving up (default 25)'),
    viewport, port,
  },
  ({ root, page, selector, maxCommits, viewport: v, port: p }) =>
    blame(root, page, { selector, maxCommits, viewport: v ? parseViewport(v) : undefined, port: p }).then((r) => text(r.output)))

// Every session launches its own headless Chrome + temp profile (src/core/connect.ts);
// without this, exiting the MCP session leaks both. Cover both ways a session ends:
// the host killing us directly, and the client ending our stdio.
async function shutdown(): Promise<void> {
  // terminal: latches connect.ts against relaunches — an in-flight tool call's next
  // withPage would otherwise relaunch Chrome behind this kill and process.exit(0)
  // would abandon it.
  await shutdownChrome({ terminal: true })
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

const transport = new StdioServerTransport()
transport.onclose = shutdown
await server.connect(transport)
