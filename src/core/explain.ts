import { originalPosition, parseSourceMap, type SourceMap } from './sourcemap.js'

export interface CascadeEntry {
  value: string
  selector: string
  specificity: string
  important: boolean
  file: string
  line: number
  status: 'winner' | 'overridden'
  reason: string | null
  via?: string // set when the value comes from a shorthand, e.g. 'margin: 4px 8px'
}

export interface Explanation {
  selector: string
  property: string
  computed: string
  declaredWinner: string | null
  layoutNote: string | null
  entries: CascadeEntry[]
}

interface SheetInfo { sourceURL: string; startLine: number; sourceMapURL: string | null }

// NOTE: CSS.enable only backfills styleSheetAdded on the disabled→enabled
// transition, so the map must be cached per client — a second collectSheets
// on the same connection would otherwise come back empty.
const sheetCache = new WeakMap<object, Map<string, SheetInfo>>()

// keyed by resolved absolute map URL, so identical sourceMappingURLs across
// sheets (or repeat explain() calls) fetch/parse once
// NOTE: transient fetch failures cache null for the process lifetime (mirrors sheetCache)
const mapCache = new Map<string, SourceMap | null>()

async function loadMap(sheetURL: string, mapURL: string): Promise<SourceMap | null> {
  const abs = new URL(mapURL, sheetURL).href
  if (!mapCache.has(abs)) {
    try {
      let json: string
      if (abs.startsWith('data:')) {
        const comma = abs.indexOf(',')
        const data = abs.slice(comma + 1)
        json = abs.slice(0, comma).includes('base64') ? Buffer.from(data, 'base64').toString() : decodeURIComponent(data)
      } else {
        json = await (await fetch(abs)).text()
      }
      mapCache.set(abs, parseSourceMap(json))
    } catch { mapCache.set(abs, null) }
  }
  return mapCache.get(abs)!
}

async function collectSheets(client: any): Promise<Map<string, SheetInfo>> {
  const cached = sheetCache.get(client)
  if (cached) return cached
  const sheets = new Map<string, SheetInfo>()
  sheetCache.set(client, sheets)
  client.CSS.styleSheetAdded(({ header }: any) => {
    sheets.set(header.styleSheetId, {
      sourceURL: header.sourceURL || '<style>',
      startLine: header.startLine,
      sourceMapURL: header.sourceMapURL || null,
    })
  })
  await client.DOM.enable()
  // NOTE: chrome-remote-interface delivers events on a domain in order over one
  // connection, so styleSheetAdded for pre-existing sheets has already fired by
  // the time CSS.enable's response arrives — verified empirically (8/8 runs),
  // no drain sleep needed.
  await client.CSS.enable()
  return sheets
}

export async function resolveNode(client: any, selector: string): Promise<number> {
  const { root } = await client.DOM.getDocument({ depth: -1 })
  const { nodeId } = await client.DOM.querySelector({ nodeId: root.nodeId, selector }).catch(() => ({ nodeId: 0 }))
  if (nodeId) return nodeId
  // suggestions: all class/id selectors present on the page
  const { result } = await client.Runtime.evaluate({
    expression: `[...new Set([...document.querySelectorAll('[class],[id]')].flatMap(e =>
      [...e.classList].map(c => '.' + c).concat(e.id ? ['#' + e.id] : [])))].slice(0, 20).join(' ')`,
    returnByValue: true,
  })
  throw new Error(`No element matches '${selector}'. Selectors on this page include: ${result.value}`)
}

// backendNodeIds survive selectors that DOM.querySelector can't parse (Tailwind's
// arbitrary-value classes and variant colons aren't valid CSS token syntax).
// pushNodesByBackendIdsToFrontend requires DOM.getDocument to have been called on
// the session first — verified empirically, it otherwise throws "Document needs to
// be requested first". A nodeId of 0 means the backend node no longer exists.
async function resolveBackendNode(client: any, backendNodeId: number): Promise<number> {
  await client.DOM.getDocument({ depth: -1 })
  const { nodeIds } = await client.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [backendNodeId] })
  if (!nodeIds[0]) throw new Error(`backendNodeId ${backendNodeId} no longer exists in the document (stale)`)
  return nodeIds[0]
}

const spec = (s: any) => (s?.specificity ? `(${s.specificity.a},${s.specificity.b},${s.specificity.c})` : '(?)')
const specRank = (s: any) => (s?.specificity ? s.specificity.a * 1e6 + s.specificity.b * 1e3 + s.specificity.c : 0)

const PX_LENGTH = /^-?[\d.]+px$/
const GEOMETRY_PROPERTY = /^(width|height|inset|margin|padding)(-|$)/

// declared !== computed is common for non-geometry properties purely from serialization
// (color: red -> rgb(255, 0, 0)); a "layout constraints override" note is only true —
// and only useful — for actual box-model properties.
function layoutRelevant(property: string, declared: string, computed: string): boolean {
  const bothPxLengths = PX_LENGTH.test(declared.trim()) && PX_LENGTH.test(computed.trim())
  return bothPxLengths || GEOMETRY_PROPERTY.test(property)
}

export async function explain(
  client: any,
  target: string | { backendNodeId: number },
  property: string,
  context?: string,
): Promise<Explanation> {
  const sheets = await collectSheets(client)
  const nodeId = typeof target === 'string' ? await resolveNode(client, target) : await resolveBackendNode(client, target.backendNodeId)
  // display-only: reuse the caller's display string when given one (e.g. renderViolations
  // already computed selectorOf(n)); a bare backendNodeId is a fine fallback otherwise.
  const selector = typeof target === 'string' ? target : (context ?? `[backendNodeId ${target.backendNodeId}]`)

  const { computedStyle } = await client.CSS.getComputedStyleForNode({ nodeId })
  const computed = computedStyle.find((p: any) => p.name === property)?.value ?? '(none)'

  const { matchedCSSRules = [], inline } = await client.CSS.getMatchedStylesForNode({ nodeId })
    .then((r: any) => ({ matchedCSSRules: r.matchedCSSRules, inline: r.inlineStyle }))

  type Raw = CascadeEntry & { order: number; rank: number; col: number; sheetInfo?: SheetInfo }
  const raws: Raw[] = []

  matchedCSSRules.forEach((m: any, order: number) => {
    if (m.rule.origin !== 'regular') return // skip user-agent rules
    // Within one rule the LAST declaration wins (common fallback pattern:
    // width: 90%; width: calc(100% - 20px)) — hence .at(-1), not find().
    let decl = m.rule.style.cssProperties.filter((p: any) => p.name === property && !p.disabled && p.text).at(-1)
    let via: string | undefined
    if (!decl) {
      // Longhand derived from a shorthand: CDP lists it as a bare {name, value}
      // entry (no .text/.range). Attribute it to its shorthand declaration —
      // the shorthand's longhandProperties links them exactly; fall back to the
      // longest name-prefix match for payloads without that field.
      const derived = m.rule.style.cssProperties.find((p: any) => p.name === property && !p.text)
      if (!derived) return
      const withText = m.rule.style.cssProperties.filter((p: any) => p.text && !p.disabled)
      // Last matching shorthand wins here too (border: ...; border-color: ...).
      // The fallback's ascending stable sort puts longest-then-latest at the end.
      const shorthand = withText.filter((p: any) => p.longhandProperties?.some((l: any) => l.name === property)).at(-1)
        ?? withText.filter((p: any) => property.startsWith(p.name))
          .sort((a: any, b: any) => a.name.length - b.name.length).at(-1)
      if (!shorthand) return
      via = `${shorthand.name}: ${shorthand.value.replace(/\s*!important/, '')}`
      decl = { ...derived, important: shorthand.important, range: shorthand.range }
    }
    const matched = m.rule.selectorList.selectors[m.matchingSelectors[0]]
    const info = sheets.get(m.rule.styleSheetId)
    const range = decl.range ?? m.rule.style.range
    raws.push({
      value: decl.value.replace(/\s*!important/, ''),
      selector: matched?.text ?? m.rule.selectorList.text,
      specificity: spec(matched),
      important: Boolean(decl.important),
      file: info?.sourceURL ?? '(unknown)',
      line: (info?.startLine ?? 0) + (range?.startLine ?? 0) + 1,
      status: 'overridden',
      reason: null,
      via,
      order,
      rank: specRank(matched),
      col: range?.startColumn ?? 0,
      sheetInfo: info,
    })
  })

  if (inline?.cssProperties?.some((p: any) => p.name === property && p.text)) {
    const decl = inline.cssProperties.find((p: any) => p.name === property)
    raws.push({
      value: decl.value, selector: '(inline style)', specificity: '(inline)',
      important: Boolean(decl.important), file: '(inline)', line: 0,
      status: 'overridden', reason: null, order: Number.MAX_SAFE_INTEGER, rank: Number.MAX_SAFE_INTEGER,
      col: 0,
    })
  }

  // resolve file:line through each declaration's source map, when it has one;
  // sheets without a map (or a broken one) silently keep their generated position
  for (const r of raws) {
    const info = r.sheetInfo
    if (!info?.sourceMapURL) continue
    const map = await loadMap(info.sourceURL, info.sourceMapURL)
    const genLine = r.line - 1 - info.startLine // r.line already folds in startLine + 1
    const orig = map && originalPosition(map, genLine, r.col)
    if (orig) { r.file = orig.source; r.line = orig.line }
  }

  // cascade: important first, then specificity, then source order (later wins)
  raws.sort((a, b) =>
    Number(b.important) - Number(a.important) || b.rank - a.rank || b.order - a.order)

  const entries = raws.map((r, i) => {
    const { order: _o, rank: _r, col: _c, sheetInfo: _s, ...entry } = r
    if (i === 0) return { ...entry, status: 'winner' as const }
    const w = raws[0]
    const reason = w.important && !r.important ? 'lost: !important beats it'
      : w.rank !== r.rank ? `lost: lower specificity ${r.specificity} vs ${w.specificity}`
      : 'lost: earlier in source order'
    return { ...entry, status: 'overridden' as const, reason }
  })

  const declaredWinner = entries[0]?.value ?? null
  const layoutNote = declaredWinner !== null && declaredWinner !== computed && layoutRelevant(property, declaredWinner, computed)
    ? `computed ${computed} differs from declared ${declaredWinner} — layout constraints override (parent grid/flex track sizing, min/max, or stretch)`
    : null

  return { selector, property, computed, declaredWinner, layoutNote, entries }
}

export function renderExplanation(e: Explanation): string {
  const lines = [`${e.selector} ${e.property} = ${e.computed}`]
  for (const x of e.entries) {
    const mark = x.status === 'winner' ? '✓' : '✗'
    const src = x.file === '(inline)' ? '(inline style)' : `${x.file.split('/').pop()}:${x.line}`
    const note = x.status === 'winner' ? (e.layoutNote ? ` — ${e.layoutNote}` : '') : ` — ${x.reason}`
    const via = x.via ? ` (via ${x.via})` : ''
    lines.push(`  ${mark} ${e.property}: ${x.value}${x.important ? ' !important' : ''}${via}   ${src} (${x.selector} ${x.specificity})${note}`)
  }
  if (e.entries.length === 0) lines.push(`  (no author rule sets ${e.property}; value is inherited or the default)`)
  return lines.join('\n')
}
