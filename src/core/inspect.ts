import { explain, renderExplanation, resolveNode } from './explain.js'

const NON_DEFAULTS = `((sel) => {
  const el = document.querySelector(sel)
  const probe = document.createElement(el.tagName)
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const cs = getComputedStyle(el), ds = getComputedStyle(probe)
  const out = {}
  for (const p of cs) {
    if (p === 'display') { out[p] = cs.getPropertyValue(p); continue }
    if (cs.getPropertyValue(p) !== ds.getPropertyValue(p)) out[p] = cs.getPropertyValue(p)
  }
  probe.remove()
  return out
})`

function stackingReason(styles: Record<string, string>): string | null {
  if (styles['position'] !== 'static' && styles['z-index'] !== 'auto') return 'position + z-index'
  if (styles['transform'] && styles['transform'] !== 'none') return 'transform'
  if (parseFloat(styles['opacity'] ?? '1') < 1) return 'opacity < 1'
  if (styles['isolation'] === 'isolate') return 'isolation: isolate'
  if (styles['filter'] && styles['filter'] !== 'none') return 'filter'
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
    expression: `${NON_DEFAULTS}(${JSON.stringify(selector)})`, returnByValue: true,
  })
  const styles: Record<string, string> = result.value ?? {}

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

  const reason = stackingReason(styles)
  const lines = [
    `${tag}${idAttr}${clsAttr}  ${Math.round(model.width)}x${Math.round(model.height)}`,
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
