import { selectorOf, walk, type BuiltTree, type LayoutNode } from './tree.js'

export interface Violation {
  rule: 'viewport-overflow' | 'parent-bleed' | 'zero-size' | 'text-clip' | 'overlap' | 'tap-target'
  selector: string
  message: string
  backendNodeId: number
}

const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary'])

const ignored = (n: LayoutNode) => 'data-bettercss-ignore' in n.attrs
const visible = (n: LayoutNode) =>
  n.styles['visibility'] !== 'hidden' && parseFloat(n.styles['opacity'] ?? '1') > 0

function report(out: Violation[], n: LayoutNode, rule: Violation['rule'], message: string, warning: string): void {
  out.push({ rule, selector: selectorOf(n), message, backendNodeId: n.backendNodeId })
  n.warnings.push(warning)
}

function viewportOverflow(tree: BuiltTree, out: Violation[]): void {
  const over = tree.contentWidth - tree.viewport.width
  if (over <= 0) return
  // culprit: deepest visible node extending furthest past the viewport edge
  let culprit: LayoutNode | null = null
  walk(tree.root, (n) => {
    if (ignored(n) || !visible(n)) return
    if (n.box.x + n.box.w > tree.viewport.width) {
      if (!culprit || n.box.x + n.box.w >= culprit.box.x + culprit.box.w) culprit = n
    }
  })
  const c = culprit ?? tree.root
  report(out, c, 'viewport-overflow',
    `page overflows viewport horizontally by ${over}px; widest element is ${selectorOf(c)} (right edge ${c.box.x + c.box.w}px > ${tree.viewport.width}px)`,
    `H-OVERFLOW:+${over}px`)
}

function parentBleed(tree: BuiltTree, out: Violation[]): void {
  walk(tree.root, (n, parent) => {
    if (!parent || ignored(n) || !visible(n)) return
    const pos = n.styles['position']
    if (pos === 'absolute' || pos === 'fixed') return // positioned children escape on purpose
    const scrolls = ['auto', 'scroll', 'hidden', 'clip'].includes(parent.styles['overflow-x'] ?? '')
    if (scrolls) return // parent manages its own overflow
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

function zeroSize(tree: BuiltTree, out: Violation[]): void {
  walk(tree.root, (n) => {
    if (ignored(n) || !visible(n) || !INTERACTIVE.has(n.tag)) return
    if (n.box.w === 0 || n.box.h === 0) {
      report(out, n, 'zero-size', `interactive ${selectorOf(n)} has zero size (${n.box.w}x${n.box.h})`, 'ZERO-SIZE')
    } else if (n.box.x + n.box.w < 0 || n.box.y + n.box.h < 0 ||
               n.box.x > Math.max(tree.viewport.width, tree.contentWidth)) {
      report(out, n, 'zero-size', `interactive ${selectorOf(n)} is entirely off-screen at (${n.box.x},${n.box.y})`, 'OFF-SCREEN')
    }
  })
}

const CHECKS: Array<(tree: BuiltTree, out: Violation[]) => void> = [viewportOverflow, parentBleed, zeroSize]

export function checkInvariants(tree: BuiltTree): Violation[] {
  const out: Violation[] = []
  for (const check of CHECKS) check(tree, out)
  return out
}
