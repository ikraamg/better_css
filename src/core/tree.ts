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
