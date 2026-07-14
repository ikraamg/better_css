import { explain } from './explain.js'
import { selectorOf, walk, type BuiltTree, type LayoutNode } from './tree.js'

export interface Violation {
  rule: 'viewport-overflow' | 'parent-bleed' | 'zero-size' | 'text-clip' | 'overlap' | 'tap-target'
  selector: string
  message: string
  backendNodeId: number
}

const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary'])

interface Ctx {
  ignored(n: LayoutNode): boolean
  visible(n: LayoutNode): boolean
}

function buildCtx(tree: BuiltTree): Ctx {
  const ignoredSet = new WeakSet<LayoutNode>()
  const opacityHidden = new WeakSet<LayoutNode>()
  walk(tree.root, (n, parent) => {
    if ('data-bettercss-ignore' in n.attrs || (parent && ignoredSet.has(parent))) ignoredSet.add(n)
    if (parseFloat(n.styles['opacity'] ?? '1') <= 0 || (parent && opacityHidden.has(parent))) opacityHidden.add(n)
  })
  return {
    ignored: (n) => ignoredSet.has(n),
    // visibility inherits in computed style; opacity does not, so propagate it down ourselves
    visible: (n) => n.styles['visibility'] !== 'hidden' && !opacityHidden.has(n),
  }
}

function report(out: Violation[], n: LayoutNode, rule: Violation['rule'], message: string, warning: string): void {
  out.push({ rule, selector: selectorOf(n), message, backendNodeId: n.backendNodeId })
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
    `H-OVERFLOW:+${over}px`)
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
    const clipBox = padBoxOf(clip)
    visRight = Math.min(visRight, clipBox.right)
    visLeft = Math.max(visLeft, clipBox.left)
  }
  const over = Math.max(visRight - padBox.right, padBox.left - visLeft)
  if (over > 1) {
    report(out, n, 'parent-bleed',
      `${selectorOf(n)} bleeds ${over}px outside ${selectorOf(parent)} (child ${n.box.w}px wide, parent ${parent.box.w}px)`,
      `BLEED:+${over}px`)
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
    } else if (n.box.x + n.box.w < 0 || n.box.y + n.box.h < 0 ||
               n.box.x > Math.max(tree.viewport.width, tree.contentWidth)) {
      report(out, n, 'zero-size', `interactive ${selectorOf(n)} is entirely off-screen at (${n.box.x},${n.box.y})`, 'OFF-SCREEN')
    }
  })
}

function textClip(tree: BuiltTree, out: Violation[], ctx: Ctx): void {
  walk(tree.root, (n) => {
    if (ctx.ignored(n) || !ctx.visible(n) || n.textBoxes.length === 0) return
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
        `CLIP:"${snippet}…"`)
    }
  })
}

// layering opt-in: positioned with explicit z-index, or transformed
const layered = (n: LayoutNode) =>
  ((n.styles['position'] ?? 'static') !== 'static' && (n.styles['z-index'] ?? 'auto') !== 'auto') ||
  (n.styles['transform'] ?? 'none') !== 'none' ||
  ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'].some((m) => parseFloat(n.styles[m] ?? '0') < 0)

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
  walk(tree.root, (n) => {
    if (ctx.ignored(n) || !ctx.visible(n) || !INTERACTIVE.has(n.tag)) return
    if (n.box.w > 0 && n.box.h > 0 && (n.box.w < 24 || n.box.h < 24)) {
      report(out, n, 'tap-target', `interactive ${selectorOf(n)} is ${n.box.w}x${n.box.h}px — below the 24px minimum tap target`, `TAP:${n.box.w}x${n.box.h}`)
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
  return out
}

// Violations whose root cause is usually a width the author declared but the
// browser overrode — worth naming the source rule for.
const SUSPECT_RULES = new Set<Violation['rule']>(['viewport-overflow', 'parent-bleed', 'text-clip'])

// Rules whose message leads with a single scalar px amount; WxH-style messages
// (tap-target "16x16px", overlap "10x8px") would misparse into a bogus range.
const SCALAR_RULES = new Set<Violation['rule']>(['viewport-overflow', 'parent-bleed', 'text-clip'])

function groupSuffix(group: Violation[]): string {
  if (group.length < 2) return ''
  if (!SCALAR_RULES.has(group[0].rule)) return ` (×${group.length} similar)`
  const pxs = group.map((v) => v.message.match(/(\d+)px/)?.[1]).filter((x): x is string => x !== undefined).map(Number)
  const range = pxs.length ? `${Math.min(...pxs)}–${Math.max(...pxs)}px` : `${group.length} elements`
  // ponytail: differing messages ≈ differing parents; parse the parent out of the message if this ever over-counts
  const differ = group.some((v) => v.message !== group[0].message)
  return ` (×${group.length}, ${range}${differ ? ` across ${group.length} parents` : ''})`
}

// Renders violations for CLI/MCP output, appending a `suspect:` line naming the
// winning width declaration (file:line) for rules where that's usually the cause.
// Identical violations (same rule + selector, e.g. every card in a carousel) collapse
// into one line — the raw Violation[] from checkInvariants stays ungrouped.
export async function renderViolations(client: any, violations: Violation[]): Promise<string> {
  if (!violations.length) return 'no violations'
  const groups = new Map<string, Violation[]>()
  for (const v of violations) {
    const key = `${v.rule} ${v.selector}`
    const group = groups.get(key)
    if (group) group.push(v)
    else groups.set(key, [v])
  }
  const lines: string[] = []
  for (const group of groups.values()) {
    const first = group[0]
    lines.push(`${first.rule}: ${first.message}${groupSuffix(group)}`)
    if (SUSPECT_RULES.has(first.rule)) {
      const e = await explain(client, { backendNodeId: first.backendNodeId }, 'width', first.selector).catch(() => null)
      const w = e?.entries.find((x) => x.status === 'winner')
      if (w) lines.push(`  suspect: width: ${w.value} @ ${w.file.split('/').pop()}:${w.line}`)
    }
  }
  return lines.join('\n')
}
