import { STYLE_WHITELIST, type RawSnapshot } from './extract.js'

export interface Box { x: number; y: number; w: number; h: number }

export interface LayoutNode {
  tag: string
  id: string | null
  classes: string[]
  box: Box
  styles: Record<string, string>
  backendNodeId: number
  attrs: Record<string, string>
  text: string | null
  textBoxes: Box[]
  children: LayoutNode[]
  warnings: string[]
}

export interface BuiltTree {
  root: LayoutNode
  viewport: { width: number; height: number }
  contentWidth: number
  contentHeight: number
}

export function buildTree(raw: RawSnapshot): BuiltTree {
  const doc = raw.documents[0]
  const s = (i: number) => (i >= 0 ? raw.strings[i] : '')
  const { nodes, layout } = doc

  // layout row per DOM node index
  const layoutRow = new Map<number, number>()
  layout.nodeIndex.forEach((ni: number, row: number) => layoutRow.set(ni, row))

  const byIndex = new Map<number, LayoutNode>()
  let body: LayoutNode | null = null

  const count = nodes.parentIndex.length
  for (let i = 0; i < count; i++) {
    const row = layoutRow.get(i)
    const type = nodes.nodeType[i]
    const name = s(nodes.nodeName[i]).toLowerCase()

    // nearest ancestor that became a LayoutNode
    let parent: LayoutNode | null = null
    for (let p = nodes.parentIndex[i]; p >= 0; p = nodes.parentIndex[p]) {
      const found = byIndex.get(p)
      if (found) { parent = found; break }
    }

    if (type === 3 && row !== undefined && parent) {
      // text node: fold into parent
      const [x, y, w, h] = layout.bounds[row]
      const value = s(nodes.nodeValue[i]).trim()
      if (value) {
        parent.text = parent.text ? `${parent.text} ${value}` : value
        parent.textBoxes.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) })
      }
      continue
    }

    if (type !== 1 || row === undefined) continue // element nodes with layout only

    const attrs: Record<string, string> = {}
    const attrPairs: number[] = nodes.attributes[i] ?? []
    for (let a = 0; a < attrPairs.length; a += 2) attrs[s(attrPairs[a])] = s(attrPairs[a + 1])

    const styles: Record<string, string> = {}
    layout.styles[row].forEach((si: number, k: number) => { styles[STYLE_WHITELIST[k]] = s(si) })

    const [x, y, w, h] = layout.bounds[row]
    const node: LayoutNode = {
      tag: name,
      id: attrs['id'] ?? null,
      classes: (attrs['class'] ?? '').split(/\s+/).filter(Boolean),
      box: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) },
      styles,
      backendNodeId: nodes.backendNodeId[i],
      attrs,
      text: null,
      textBoxes: [],
      children: [],
      warnings: [],
    }
    byIndex.set(i, node)
    if (name === 'body') body = node
    else if (parent) parent.children.push(node)
  }

  if (!body) throw new Error('No <body> found in snapshot')
  return { root: body, viewport: raw.viewport, contentWidth: raw.contentWidth, contentHeight: raw.contentHeight }
}

export function walk(node: LayoutNode, fn: (n: LayoutNode, parent: LayoutNode | null) => void, parent: LayoutNode | null = null): void {
  fn(node, parent)
  for (const c of node.children) walk(c, fn, node)
}

export function selectorOf(n: LayoutNode): string {
  return n.tag + (n.id ? `#${n.id}` : '') + n.classes.slice(0, 3).map((c) => `.${c}`).join('')
}

// First-match lookup by rendered selector, #id, or .class — shared by the CLI's
// and MCP's layout-scoping (--selector / selector param).
export function findNode(tree: BuiltTree, selector: string): LayoutNode | undefined {
  let found: LayoutNode | undefined
  walk(tree.root, (n) => {
    if (found) return
    if (selectorOf(n) === selector || n.id === selector.replace('#', '') ||
        n.classes.includes(selector.replace('.', ''))) found = n
  })
  return found
}

const px = (v: string) => String(Math.round(parseFloat(v)) || 0)

function fourSide(styles: Record<string, string>, prefix: string): string | null {
  const [t, r, b, l] = ['top', 'right', 'bottom', 'left'].map((s) => px(styles[`${prefix}-${s}`] ?? '0'))
  if (t === '0' && r === '0' && b === '0' && l === '0') return null
  if (t === b && l === r) return t === l ? t : `${t},${l}`
  return `${t},${r},${b},${l}`
}

function layoutDesc(n: LayoutNode): string {
  const parts: string[] = []
  const d = n.styles['display'] ?? ''
  if (d.includes('flex')) {
    parts.push(`flex ${(n.styles['flex-direction'] ?? 'row').startsWith('column') ? 'column' : 'row'}`)
    const gap = px((n.styles['gap'] ?? '0').split(' ')[0])
    if (gap !== '0') parts.push(`gap:${gap}`)
  } else if (d.includes('grid')) {
    const cols = (n.styles['grid-template-columns'] ?? 'none')
      .split(' ').map((c) => (c.endsWith('px') ? px(c) : c)).join(',')
    parts.push(cols === 'none' ? 'grid' : `grid cols:${cols}`)
    const gap = px((n.styles['gap'] ?? '0').split(' ')[0])
    if (gap !== '0') parts.push(`gap:${gap}`)
  }
  const pad = fourSide(n.styles, 'padding')
  if (pad) parts.push(`pad:${pad}`)
  const pos = n.styles['position']
  if (pos && pos !== 'static') parts.push(pos + (n.styles['z-index'] !== 'auto' ? ` z:${n.styles['z-index']}` : ''))
  return parts.length ? ' ' + parts.join(' ') : ''
}

function sameShape(a: LayoutNode, b: LayoutNode): boolean {
  return selectorOf(a) === selectorOf(b) &&
    Math.abs(a.box.w - b.box.w) <= 2 && Math.abs(a.box.h - b.box.h) <= 2 &&
    a.warnings.length === 0 && b.warnings.length === 0
}

function renderNode(n: LayoutNode, depth: number, maxDepth: number, out: string[]): void {
  const indent = '  '.repeat(depth)
  const warn = n.warnings.map((w) => ` ⚠${w}`).join('')
  out.push(`${indent}${selectorOf(n)} (${n.box.x},${n.box.y} ${n.box.w}x${n.box.h})${layoutDesc(n)}${warn}`)
  if (depth >= maxDepth) {
    if (n.children.length) out.push(`${indent}  … ${n.children.length} children`)
    return
  }
  // collapse runs of same-shaped siblings
  for (let i = 0; i < n.children.length; ) {
    let j = i + 1
    while (j < n.children.length && sameShape(n.children[i], n.children[j])) j++
    const run = j - i
    if (run >= 2) {
      const c = n.children[i]
      out.push(`${'  '.repeat(depth + 1)}${selectorOf(c)} ×${run} (~${c.box.w}x${c.box.h})`)
    } else {
      renderNode(n.children[i], depth + 1, maxDepth, out)
    }
    i = j
  }
}

export function renderTree(tree: BuiltTree, opts: { depth?: number; from?: LayoutNode } = {}): string {
  const root = opts.from ?? tree.root
  const out: string[] = []
  renderNode(root, 0, opts.depth ?? Infinity, out)
  if (root === tree.root && tree.contentWidth > tree.viewport.width) {
    out[0] += ` ⚠H-OVERFLOW:+${tree.contentWidth - tree.viewport.width}px`
  }
  return out.join('\n')
}
