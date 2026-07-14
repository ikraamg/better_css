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

function parentBleed(tree: BuiltTree, out: Violation[], ctx: Ctx): void {
  walk(tree.root, (n, parent) => {
    if (!parent || ctx.ignored(n) || !ctx.visible(n)) return
    const pos = n.styles['position']
    if (pos === 'absolute' || pos === 'fixed') return // positioned children escape on purpose
    const scrolls = ['auto', 'scroll', 'hidden', 'clip'].includes(parent.styles['overflow-x'] ?? '')
    if (scrolls) return // parent manages its own overflow
    // bleed boundary is the parent's padding box, per spec
    const padBox = {
      left: parent.box.x + Math.round(parseFloat(parent.styles['border-left-width'] ?? '0')),
      right: parent.box.x + parent.box.w - Math.round(parseFloat(parent.styles['border-right-width'] ?? '0')),
    }
    const overRight = n.box.x + n.box.w - padBox.right
    const overLeft = padBox.left - n.box.x
    const over = Math.max(overRight, overLeft)
    if (over > 1) {
      report(out, n, 'parent-bleed',
        `${selectorOf(n)} bleeds ${over}px outside ${selectorOf(parent)} (child ${n.box.w}px wide, parent ${parent.box.w}px)`,
        `BLEED:+${over}px`)
    }
  })
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
    const padRight = Math.round(parseFloat(n.styles['padding-right'] ?? '0'))
    const innerRight = n.box.x + n.box.w - padRight
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
  ['margin-top', 'margin-left'].some((m) => parseFloat(n.styles[m] ?? '0') < 0)

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
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j]
      if (a.chain.has(b.n) || b.chain.has(a.n)) continue // ancestor/descendant
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
      j = entries.length // one report per element is enough signal
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
