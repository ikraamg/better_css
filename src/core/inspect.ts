import { explain, renderExplanation, resolveNode, escapeCssSelector } from './explain.js'

const PROBE = `((sel, escSel) => {
  // Field #4: check and inspect independently pick "a" matching element for a generic
  // selector — querySelectorAll here (not just querySelector) lets inspect say when its
  // first match isn't the only one, instead of silently describing a possibly different
  // instance than the one the user actually meant. Raw first, then the escaped fallback so a
  // Tailwind selector (querySelector-invalid) still resolves — mirrors resolveNode.
  let matches
  try { matches = [...document.querySelectorAll(sel)] }
  catch { matches = [...document.querySelectorAll(escSel)] }
  const el = matches[0]
  const probe = document.createElement(el.tagName)
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const cs = getComputedStyle(el), ds = getComputedStyle(probe)
  const diff = {}
  // Geometry is covered authoritatively by the box-model line and the embedded
  // width/height explanations; the display:none probe resolves these to auto,
  // so diffing them only produces used-value noise ("width: 1040px" with no
  // author rule). The non-default list is for styling.
  const GEOM = /^(min-|max-)?(width|height|inline-size|block-size)$/
  for (const p of cs) {
    if (GEOM.test(p)) continue
    if (p === 'display') { diff[p] = cs.getPropertyValue(p); continue }
    if (cs.getPropertyValue(p) !== ds.getPropertyValue(p)) diff[p] = cs.getPropertyValue(p)
  }
  probe.remove()
  // real computed values (not the diff) for stacking-context detection —
  // defaulted properties are absent from the diff, which is not the same as 'static'/'auto'
  const actual = {}
  for (const p of ['position', 'z-index', 'transform', 'opacity', 'isolation', 'filter'])
    actual[p] = cs.getPropertyValue(p)
  const others = matches.slice(1, 4).map((e) => {
    const r = e.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) }
  })
  return { diff, actual, matchCount: matches.length, others }
})`

function stackingReason(s: Record<string, string>): string | null {
  if (s['position'] !== 'static' && s['z-index'] !== 'auto') return 'position + z-index'
  if (s['transform'] !== 'none') return 'transform'
  if (parseFloat(s['opacity']) < 1) return 'opacity < 1'
  if (s['isolation'] === 'isolate') return 'isolation: isolate'
  if (s['filter'] !== 'none') return 'filter'
  return null
}

const side = (q: number[], i: number[]) => [
  Math.round(i[1] - q[1]), Math.round(q[2] - i[2]),   // top, right
  Math.round(q[5] - i[5]), Math.round(i[0] - q[0]),   // bottom, left
]

// DOM.describeNode's `attributes` is a flat [name, value, name, value, ...]
// array — walk it in pairs rather than `indexOf('id')`, which would
// false-positive on a class *value* that happens to be literally "id".
function attr(attributes: string[] | undefined, name: string): string | undefined {
  if (!attributes) return undefined
  for (let i = 0; i < attributes.length; i += 2) {
    if (attributes[i] === name) return attributes[i + 1]
  }
  return undefined
}

export async function inspect(client: any, selector: string): Promise<string> {
  const nodeId = await resolveNode(client, selector)

  const { result } = await client.Runtime.evaluate({
    expression: `${PROBE}(${JSON.stringify(selector)}, ${JSON.stringify(escapeCssSelector(selector))})`, returnByValue: true,
  })
  const styles: Record<string, string> = result.value?.diff ?? {}
  const actual: Record<string, string> = result.value?.actual ?? {}
  const matchCount: number = result.value?.matchCount ?? 1
  const others: Array<{ w: number; h: number; x: number; y: number }> = result.value?.others ?? []

  const { model } = await client.DOM.getBoxModel({ nodeId })
  const [pt, pr, pb, pl] = side(model.padding, model.content)
  const [bt, br, bb, bl] = side(model.border, model.padding)
  const [mt, mr, mb, ml] = side(model.margin, model.border)

  const desc = await client.DOM.describeNode({ nodeId })
  const tag = desc.node.localName
  const id = attr(desc.node.attributes, 'id')
  const cls = attr(desc.node.attributes, 'class')
  const idAttr = id ? '#' + id : ''
  const clsAttr = cls ? '.' + cls.trim().split(/\s+/).join('.') : ''

  const reason = stackingReason(actual)
  // Field #4: "3 matches; showing #1 — others: 674x72 at (24,310), …" — capped at 3
  // others, so the user knows siblings exist before mis-diagnosing a size discrepancy
  // (this is the exact bug: check and inspect independently landing on different
  // same-selector instances) as something else.
  const multiMatch = matchCount > 1
    ? ` (${matchCount} matches; showing #1 — others: ${others.map((o) => `${o.w}x${o.h} at (${o.x},${o.y})`).join(', ')})`
    : ''
  const lines = [
    `${tag}${idAttr}${clsAttr}  ${Math.round(model.width)}x${Math.round(model.height)} (border-box)${multiMatch}`,
    `  padding: ${pt} ${pr} ${pb} ${pl} | border: ${bt} ${br} ${bb} ${bl} | margin: ${mt} ${mr} ${mb} ${ml}`,
    `  stacking context: ${reason ? `yes (${reason})` : 'no'}`,
    '',
    '  non-default styles:',
    ...Object.entries(styles).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `    ${k}: ${v}`),
    '',
  ]
  for (const prop of ['width', 'height'] as const) {
    lines.push(renderExplanation(await explain(client, selector, prop)).split('\n').map((l) => '  ' + l).join('\n'))
  }
  return lines.join('\n')
}
