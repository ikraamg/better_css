import { explain } from './explain.js'
import { selectorOf, walk, type Box, type BuiltTree, type LayoutNode } from './tree.js'

export interface Violation {
  rule: 'viewport-overflow' | 'parent-bleed' | 'zero-size' | 'text-clip' | 'overlap' | 'tap-target'
  selector: string
  message: string
  backendNodeId: number
  // structured scalar amount for rules whose message leads with a single px value
  // (viewport-overflow, parent-bleed, text-clip) — grouping reads this instead of
  // regex-scraping the message, which a px-looking class name (e.g. w-[300px]) can poison
  px?: number
  // the offending element's parent, set where a parent is known (parent-bleed at minimum) —
  // grouping uses this to detect a group spanning distinct parents
  parentSelector?: string
  // Field #4: the violating instance's own position, set only when `selector` (a generic
  // tag+classes string with no id) matches more than one element in the whole tree — an
  // id-bearing selector is already unambiguous. renderViolations appends this as display-only
  // disambiguation so a generic class selector points at THE element, not A element (check
  // and inspect were independently picking different same-selector instances).
  x?: number
  y?: number
}

const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary'])

// Field #2: the sr-only accessibility pattern (screen-reader-only: clipped to ~1px on
// purpose, e.g. Tailwind's `.sr-only` behind a `peer` toggle) reads as visible to
// buildCtx.visible() (opacity/visibility only) — it's a deliberate non-visual element,
// not a bug. Signature: absolutely positioned, clamped to <=2px in both dimensions,
// clipped via overflow, and opts into either the `clip` rect or `clip-path` recipe (the
// two competing sr-only CSS techniques across Tailwind versions).
function isSrOnly(n: LayoutNode): boolean {
  if (n.styles['position'] !== 'absolute') return false
  if (n.box.w > 2 || n.box.h > 2) return false
  const clips = (v: string | undefined) => v === 'hidden' || v === 'clip'
  if (!clips(n.styles['overflow-x']) || !clips(n.styles['overflow-y'])) return false
  const clip = n.styles['clip'] ?? ''
  const clipPath = n.styles['clip-path'] ?? 'none'
  return (clip !== '' && clip !== 'auto') || (clipPath !== '' && clipPath !== 'none')
}

// Field #2: "measure the label's box as the effective tap target, not the input's" — for
// an interactive <input>, resolves its associated <label> via `for=` (document-order id
// scan) or a wrapping <label> ancestor. One walk builds both lookups; no new CDP calls.
function buildLabelIndex(tree: BuiltTree): { forId: Map<string, LayoutNode>; wrapping: WeakMap<LayoutNode, LayoutNode> } {
  const forId = new Map<string, LayoutNode>()
  const wrapping = new WeakMap<LayoutNode, LayoutNode>()
  walk(tree.root, (n, parent) => {
    if (n.tag === 'label' && n.attrs['for']) forId.set(n.attrs['for'], n)
    if (parent) {
      const ancestorLabel = parent.tag === 'label' ? parent : wrapping.get(parent)
      if (ancestorLabel) wrapping.set(n, ancestorLabel)
    }
  })
  return { forId, wrapping }
}

// Returns the label AND whether it's a wrapping ancestor: the two need different
// measurement. A for= label is its own separate element with a real box; a wrapping
// <label> around a block child renders an ANONYMOUS block box that balloons to the
// container's full width (an inline label wrapping a block), so its box is not the
// visible tap target — the tapTargets caller measures the visible descendants instead.
function labelFor(n: LayoutNode, index: ReturnType<typeof buildLabelIndex>): { label: LayoutNode; wrapping: boolean } | undefined {
  const byId = n.attrs['id'] ? index.forId.get(n.attrs['id']) : undefined
  if (byId) return { label: byId, wrapping: false }
  const wrap = index.wrapping.get(n)
  return wrap ? { label: wrap, wrapping: true } : undefined
}

// The effective visible tap target inside a wrapping label: the union bounding box of
// its visible, non-sr-only descendant boxes. Null when nothing visible lives inside
// (the whole control is non-visual — treated like a bare sr-only input, exempt).
function wrappingTargetBox(label: LayoutNode, ctx: Ctx): Box | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  walk(label, (d) => {
    if (d === label || ctx.ignored(d) || !ctx.visible(d) || isSrOnly(d)) return
    if (d.box.w <= 0 || d.box.h <= 0) return
    minX = Math.min(minX, d.box.x); minY = Math.min(minY, d.box.y)
    maxX = Math.max(maxX, d.box.x + d.box.w); maxY = Math.max(maxY, d.box.y + d.box.h)
  })
  return maxX < minX ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

interface Ctx {
  ignored(n: LayoutNode): boolean
  visible(n: LayoutNode): boolean
  // true when any ancestor (not self) clips/scrolls horizontally or vertically —
  // scrollable means reachable, clipped means managed (carousel); only zeroSize's
  // off-screen branch consults this, the zero-dimension branch is unaffected
  offscreenManaged(n: LayoutNode): boolean
}

function buildCtx(tree: BuiltTree): Ctx {
  const ignoredSet = new WeakSet<LayoutNode>()
  const opacityHidden = new WeakSet<LayoutNode>()
  // svg descendants are exempt from every invariant (their layout is SVG-internal,
  // not CSS box flow) — the svg element itself stays a normal participant
  const svgDescendant = new WeakSet<LayoutNode>()
  const offscreenManaged = new WeakSet<LayoutNode>()
  walk(tree.root, (n, parent) => {
    if ('data-csstruth-ignore' in n.attrs || (parent && ignoredSet.has(parent))) ignoredSet.add(n)
    if (parseFloat(n.styles['opacity'] ?? '1') <= 0 || (parent && opacityHidden.has(parent))) opacityHidden.add(n)
    if (parent && (parent.tag === 'svg' || svgDescendant.has(parent))) svgDescendant.add(n)
    if (parent) {
      const parentClips = CLIPS_X.has(parent.styles['overflow-x'] ?? '') || CLIPS_X.has(parent.styles['overflow-y'] ?? '')
      if (parentClips || offscreenManaged.has(parent)) offscreenManaged.add(n)
    }
  })
  return {
    ignored: (n) => ignoredSet.has(n) || svgDescendant.has(n),
    // visibility inherits in computed style; opacity does not, so propagate it down ourselves
    visible: (n) => n.styles['visibility'] !== 'hidden' && !opacityHidden.has(n),
    offscreenManaged: (n) => offscreenManaged.has(n),
  }
}

function report(
  out: Violation[], n: LayoutNode, rule: Violation['rule'], message: string, warning: string,
  extra?: { px?: number; parentSelector?: string },
): void {
  out.push({ rule, selector: selectorOf(n), message, backendNodeId: n.backendNodeId, ...extra })
  n.warnings.push(warning)
}

function viewportOverflow(tree: BuiltTree, out: Violation[], ctx: Ctx): void {
  const over = tree.contentWidth - tree.viewport.width
  if (over <= 0) return
  // culprit: deepest visible node extending furthest past the viewport edge
  let culprit: LayoutNode | null = null
  walk(tree.root, (n) => {
    if (ctx.ignored(n) || !ctx.visible(n)) return
    if (n.box.x + n.box.w > tree.viewport.width) {
      if (!culprit || n.box.x + n.box.w >= culprit.box.x + culprit.box.w) culprit = n
    }
  })
  const c = culprit as LayoutNode | null // TS can't see assignment inside the walk closure
  if (!c) return // only ignored/hidden elements overflow -> suppressed
  report(out, c, 'viewport-overflow',
    `page overflows viewport horizontally by ${over}px; widest element is ${selectorOf(c)} (right edge ${c.box.x + c.box.w}px > ${tree.viewport.width}px)`,
    `H-OVERFLOW:+${over}px`, { px: over })
}

const CLIPS_X = new Set(['auto', 'scroll', 'hidden', 'clip'])

// bleed boundary is a node's padding box, per spec
function padBoxOf(n: LayoutNode): { left: number; right: number } {
  return {
    left: n.box.x + Math.round(parseFloat(n.styles['border-left-width'] ?? '0')),
    right: n.box.x + n.box.w - Math.round(parseFloat(n.styles['border-right-width'] ?? '0')),
  }
}

// `ancestors` is root..direct-parent (nearest last). A child only visibly bleeds past
// its direct parent up to the nearest clipping ancestor above it (or the parent itself,
// same as before) — an ancestor further up (e.g. body { overflow-x: hidden }) that never
// actually clips this child must not suppress a real bleed.
function checkBleed(n: LayoutNode, ancestors: LayoutNode[], out: Violation[]): void {
  const parent = ancestors[ancestors.length - 1]
  const padBox = padBoxOf(parent)
  let clip: LayoutNode | null = null
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (CLIPS_X.has(ancestors[i].styles['overflow-x'] ?? '')) { clip = ancestors[i]; break }
  }
  let visRight = n.box.x + n.box.w
  let visLeft = n.box.x
  if (clip) {
    // heuristic ceiling: a positioned/transformed descendant whose containing block sits
    // above `clip` can still visibly escape it — this clamp intentionally ignores that case
    const clipBox = padBoxOf(clip)
    visRight = Math.min(visRight, clipBox.right)
    visLeft = Math.max(visLeft, clipBox.left)
  }
  const over = Math.max(visRight - padBox.right, padBox.left - visLeft)
  if (over > 1) {
    report(out, n, 'parent-bleed',
      `${selectorOf(n)} bleeds ${over}px outside ${selectorOf(parent)} (child ${n.box.w}px wide, parent ${parent.box.w}px)`,
      `BLEED:+${over}px`, { px: over, parentSelector: selectorOf(parent) })
  }
}

function parentBleed(tree: BuiltTree, out: Violation[], ctx: Ctx): void {
  const ancestors: LayoutNode[] = []
  const visit = (n: LayoutNode) => {
    const parent = ancestors[ancestors.length - 1]
    if (parent && !ctx.ignored(n) && ctx.visible(n)) {
      const pos = n.styles['position']
      if (pos !== 'absolute' && pos !== 'fixed') checkBleed(n, ancestors, out) // positioned children escape on purpose
    }
    ancestors.push(n)
    for (const c of n.children) visit(c)
    ancestors.pop()
  }
  visit(tree.root)
}

function zeroSize(tree: BuiltTree, out: Violation[], ctx: Ctx): void {
  walk(tree.root, (n) => {
    if (ctx.ignored(n) || !ctx.visible(n) || !INTERACTIVE.has(n.tag)) return
    if (n.box.w === 0 || n.box.h === 0) {
      report(out, n, 'zero-size', `interactive ${selectorOf(n)} has zero size (${n.box.w}x${n.box.h})`, 'ZERO-SIZE')
    } else if (!ctx.offscreenManaged(n) &&
               (n.box.x + n.box.w < 0 || n.box.y + n.box.h < 0 ||
                n.box.x > Math.max(tree.viewport.width, tree.contentWidth))) {
      report(out, n, 'zero-size', `interactive ${selectorOf(n)} is entirely off-screen at (${n.box.x},${n.box.y})`, 'OFF-SCREEN')
    }
  })
}

function textClip(tree: BuiltTree, out: Violation[], ctx: Ctx): void {
  walk(tree.root, (n) => {
    if (ctx.ignored(n) || !ctx.visible(n) || n.textBoxes.length === 0 || isSrOnly(n)) return
    const clips = ['hidden', 'clip'].includes(n.styles['overflow-x'] ?? '')
    if (!clips || n.styles['text-overflow'] === 'ellipsis') return
    // browsers clip at the padding-box edge, same boundary parentBleed uses
    const borderRight = Math.round(parseFloat(n.styles['border-right-width'] ?? '0'))
    const innerRight = n.box.x + n.box.w - borderRight
    const textRight = Math.max(...n.textBoxes.map((b) => b.x + b.w))
    if (textRight > innerRight + 1) {
      const snippet = (n.text ?? '').slice(0, 12)
      report(out, n, 'text-clip',
        `text "${snippet}…" clipped in ${selectorOf(n)}: text extends to ${textRight}px, container inner edge at ${innerRight}px, no text-overflow opt-in`,
        `CLIP:"${snippet}…"`, { px: textRight - innerRight })
    }
  })
}

// layering opt-in: any non-static position (z-index or not — position alone says "I know
// what I'm doing"), or transformed, or negative margin
const layered = (n: LayoutNode) =>
  (n.styles['position'] ?? 'static') !== 'static' ||
  (n.styles['transform'] ?? 'none') !== 'none' ||
  ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'].some((m) => parseFloat(n.styles[m] ?? '0') < 0)

function isEmptyOfContent(n: LayoutNode): boolean {
  return !n.text && n.textBoxes.length === 0 && n.children.length === 0
}

// Field #5: an overlap where one side is a fully empty box (no text, no children) almost
// fully covering a side that DOES have real content is the empty-async-placeholder
// signature (a container stacked over already-rendered content while its own data hasn't
// arrived yet), not a genuine authoring accident — suppressed. Two MUTUALLY empty boxes
// (e.g. a real grid-cell collision, fixtures/overlap's cell-a/cell-b case) stay flagged:
// with nothing rendered on either side there's no "real content" being hidden behind the
// empty one, so it can't be told apart from an accident.
function isPlaceholderOverlap(a: LayoutNode, b: LayoutNode, ix: number, iy: number): boolean {
  const aEmpty = isEmptyOfContent(a)
  const bEmpty = isEmptyOfContent(b)
  if (aEmpty === bEmpty) return false // both empty (ambiguous) or both filled (not a placeholder)
  const empty = aEmpty ? a : b
  const full = aEmpty ? b : a
  const emptyArea = empty.box.w * empty.box.h
  if (emptyArea === 0 || emptyArea > full.box.w * full.box.h) return false
  return (ix * iy) / emptyArea >= 0.95
}

function overlap(tree: BuiltTree, out: Violation[], ctx: Ctx): void {
  // collect visible nodes with ancestry chains
  const entries: Array<{ n: LayoutNode; chain: Set<LayoutNode> }> = []
  const chainStack: LayoutNode[] = []
  const collect = (n: LayoutNode) => {
    chainStack.push(n)
    if (!ctx.ignored(n) && ctx.visible(n) && n.box.w > 0 && n.box.h > 0) {
      entries.push({ n, chain: new Set(chainStack) })
    }
    for (const c of n.children) collect(c)
    chainStack.pop()
  }
  collect(tree.root)

  // ponytail: O(n²) pair scan; spatial index if page size ever makes this slow
  const reported = new Set<number>()
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j]
      // pre-order collection + i<j means an ancestor always precedes its descendant, so only a can be b's ancestor
      if (b.chain.has(a.n)) continue
      if (reported.has(b.n.backendNodeId)) continue // one report per element
      const ix = Math.min(a.n.box.x + a.n.box.w, b.n.box.x + b.n.box.w) - Math.max(a.n.box.x, b.n.box.x)
      const iy = Math.min(a.n.box.y + a.n.box.h, b.n.box.y + b.n.box.h) - Math.max(a.n.box.y, b.n.box.y)
      if (ix <= 4 || iy <= 4) continue // touching edges is not overlap
      if (isPlaceholderOverlap(a.n, b.n, ix, iy)) continue // empty async placeholder (field #5)
      // opt-in check on either element or its ancestors below the common ancestor
      const common = [...a.chain].filter((x) => b.chain.has(x))
      const commonSet = new Set(common)
      const optedIn = (e: { chain: Set<LayoutNode> }) =>
        [...e.chain].some((x) => !commonSet.has(x) && layered(x))
      if (optedIn(a) || optedIn(b)) continue
      report(out, b.n, 'overlap',
        `${selectorOf(b.n)} overlaps ${selectorOf(a.n)} by ${ix}x${iy}px with no layering opt-in (position+z-index, transform, or negative margin)`,
        `OVERLAP:${selectorOf(a.n)}`)
      reported.add(b.n.backendNodeId)
      j = entries.length // one report per outer element is enough signal
    }
  }
}

function tapTargets(tree: BuiltTree, out: Violation[], ctx: Ctx): void {
  const labels = buildLabelIndex(tree)
  walk(tree.root, (n) => {
    if (ctx.ignored(n) || !ctx.visible(n) || !INTERACTIVE.has(n.tag)) return
    // Field #2: an <input> with an associated <label> is measured by the LABEL's tap
    // target — the real control (Tailwind `peer` switches size a sr-only input at ~1px
    // and style the label as the visible control). A for= label is its own element,
    // measured directly; a WRAPPING label's own box is an anonymous block that balloons
    // to container width, so its visible descendants are measured instead. A target
    // that's still <24px is a genuine bug, flagged — not a blanket exemption. Only a
    // bare sr-only input (no label, or a wrapping label with nothing visible) is exempt.
    let box = n.box
    if (n.tag === 'input') {
      const found = labelFor(n, labels)
      if (found) {
        const eff = found.wrapping ? wrappingTargetBox(found.label, ctx) : found.label.box
        if (!eff) return // wrapping label with no visible target — non-visual, exempt
        box = eff
      } else if (isSrOnly(n)) return
    } else if (isSrOnly(n)) return
    if (box.w > 0 && box.h > 0 && (box.w < 24 || box.h < 24)) {
      report(out, n, 'tap-target', `interactive ${selectorOf(n)} is ${box.w}x${box.h}px — below the 24px minimum tap target`, `TAP:${box.w}x${box.h}`)
    }
  })
}

const CHECKS: Array<(tree: BuiltTree, out: Violation[], ctx: Ctx) => void> = [
  viewportOverflow, parentBleed, zeroSize, textClip, overlap, tapTargets,
]

export function checkInvariants(tree: BuiltTree): Violation[] {
  const out: Violation[] = []
  const ctx = buildCtx(tree)
  for (const check of CHECKS) check(tree, out, ctx)
  annotateInstancePositions(tree, out)
  return out
}

// Field #4: stamps (x,y) onto a violation only when its generic selector (selectorOf —
// tag + up to 3 classes, id included when present) matches more than one element in the
// WHOLE tree, not just among the violations. An id-bearing selector is already unique, so
// it's left alone. renderViolations decides whether to actually print the position.
function annotateInstancePositions(tree: BuiltTree, out: Violation[]): void {
  if (!out.length) return
  const counts = new Map<string, number>()
  const byBackendId = new Map<number, LayoutNode>()
  walk(tree.root, (n) => {
    counts.set(selectorOf(n), (counts.get(selectorOf(n)) ?? 0) + 1)
    byBackendId.set(n.backendNodeId, n)
  })
  for (const v of out) {
    if ((counts.get(v.selector) ?? 0) > 1) {
      const n = byBackendId.get(v.backendNodeId)
      if (n) { v.x = n.box.x; v.y = n.box.y }
    }
  }
}

// Identity key for the persistence filter below (field #1) — rule + full selector.
// Two captures 400ms apart describe the SAME DOM, so a selector staying stable across
// both is exactly the signal that tells a persisted violation from a mid-render phantom.
export function violationKey(v: Violation): string {
  return `${v.rule} ${v.selector}`
}

// Field #1 persistence filter: when the post-navigation settle cap was hit (the page
// never stabilized — connect.ts's layoutNeverSettled), one capture can still land
// mid-render. Re-capturing ~400ms later and keeping only violations present in BOTH
// tells a persisted bug (survives) apart from a mid-render phantom (doesn't) — cheaper
// and more honest than blocking on a longer settle. `neverSettled` decouples this from
// connect.ts directly, so the caller (check/verify's capture loop) supplies the fact.
export async function checkWithPersistence(
  neverSettled: boolean, capture: () => Promise<Violation[]>,
): Promise<{ violations: Violation[]; persistenceFiltered: boolean }> {
  const first = await capture()
  if (!neverSettled) return { violations: first, persistenceFiltered: false }
  await new Promise((r) => setTimeout(r, 400))
  const secondKeys = new Set((await capture()).map(violationKey))
  return { violations: first.filter((v) => secondKeys.has(violationKey(v))), persistenceFiltered: true }
}

// Violations whose root cause is usually a width the author declared but the
// browser overrode — worth naming the source rule for.
const SUSPECT_RULES = new Set<Violation['rule']>(['viewport-overflow', 'parent-bleed', 'text-clip'])

function groupSuffix(group: Violation[]): string {
  if (group.length < 2) return ''
  if (!group.every((v) => v.px !== undefined)) return ` (×${group.length} similar)`
  const pxs = group.map((v) => v.px as number)
  const range = `${Math.min(...pxs)}–${Math.max(...pxs)}px`
  const distinctParents = new Set(group.map((v) => v.parentSelector).filter((p): p is string => p !== undefined))
  return ` (×${group.length}, ${range}${distinctParents.size >= 2 ? ` across ${distinctParents.size} parents` : ''})`
}

// Renders violations for CLI/MCP output, appending a `suspect:` line naming the
// winning width declaration (file:line) for rules where that's usually the cause.
// Identical violations (same rule + selector, e.g. every card in a carousel) collapse
// into one line — the raw Violation[] from checkInvariants stays ungrouped.
export async function renderViolations(client: any, violations: Violation[]): Promise<string> {
  if (!violations.length) return 'no violations'
  const groups = new Map<string, Violation[]>()
  for (const v of violations) {
    // group by tag + classes, not the #id — three id-distinct instances of the same
    // pattern (e.g. per-row vote buttons) are one signal, not three; the displayed
    // line still shows the first violation's full selector (with its id)
    const key = `${v.rule} ${v.selector.replace(/#[^.]+/, '')}`
    const group = groups.get(key)
    if (group) group.push(v)
    else groups.set(key, [v])
  }
  const lines: string[] = []
  for (const group of groups.values()) {
    const first = group[0]
    // Field #4: display-only — appended after grouping, never mutates v.message or the
    // group key, and stays absent whenever the selector is unambiguous (the common case).
    // When N instances of the same selector violate, this is the FIRST instance's (x,y)
    // (group[0]) — enough to point at a concrete element; the ×N count says there are more.
    const pos = first.x !== undefined && first.y !== undefined ? ` (at ${first.x},${first.y})` : ''
    lines.push(`${first.rule}: ${first.message}${groupSuffix(group)}${pos}`)
    if (SUSPECT_RULES.has(first.rule)) {
      const e = await explain(client, { backendNodeId: first.backendNodeId }, 'width', first.selector).catch(() => null)
      const w = e?.entries.find((x) => x.status === 'winner')
      if (w) lines.push(`  suspect: width: ${w.value} @ ${w.file.split('/').pop()}:${w.line}`)
    }
  }
  return lines.join('\n')
}
