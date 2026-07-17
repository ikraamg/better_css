import { withPage } from './connect.js'

export interface Shift {
  atMs: number
  selector: string
  from: { x: number; y: number }
  to: { x: number; y: number }
  score: number
}

export interface StabilityResult {
  score: number
  threshold: number
  shifts: Shift[]
  suspects: string[]
}

export interface StabilityOpts {
  duration?: number
  threshold?: number
  port?: number
  viewport?: { width: number; height: number }
}

const DEFAULT_DURATION_MS = 3000
const DEFAULT_THRESHOLD = 0.1

// Installed via Page.addScriptToEvaluateOnNewDocument (fires before ANY page script, on
// every new document — verified empirically: a shift in the first 100ms is still caught),
// so the buffered PerformanceObserver is armed before the page's own scripts can run.
// `buffered: true` also backfills any layout-shift entries that fired between navigation
// start and observer construction. entry.sources (LayoutShiftAttribution[]) carry live
// element refs (.node); stashing the raw entries themselves in a page global keeps those
// refs alive as ordinary strong references until collection reads them below — they don't
// get detached since the fixture's shift only ever INSERTS content, never removes it.
const INSTALL_SCRIPT = `(function () {
  window.__csstruthShifts = [];
  try {
    var po = new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) { window.__csstruthShifts.push(entry); });
    });
    po.observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}
})();`

// In-page selectorOf equivalent (tag + #id + up to 3 classes) — mirrors tree.ts's
// selectorOf exactly, so stability's output reads like the rest of the tool family.
// Elements here are live DOM node refs from entry.sources, not LayoutNodes built from a
// DOMSnapshot, so this has to be its own small copy rather than a shared import: it runs
// inside Runtime.evaluate's page-context string, not in this Node process.
const COLLECT_SCRIPT = `(function () {
  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return '(unattributed)'
    var cls = (typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter(Boolean).slice(0, 3)
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls.map(function (c) { return '.' + c }).join('')
  }
  var allSources = []
  var shifts = (window.__csstruthShifts || []).map(function (entry) {
    var src = entry.sources && entry.sources[0]
    ;(entry.sources || []).forEach(function (s) { if (s.node) allSources.push(s.node) })
    return {
      atMs: Math.round(entry.startTime),
      score: entry.value,
      selector: src && src.node ? selectorOf(src.node) : '(unattributed)',
      from: src ? { x: Math.round(src.previousRect.x), y: Math.round(src.previousRect.y) } : { x: 0, y: 0 },
      to: src ? { x: Math.round(src.currentRect.x), y: Math.round(src.currentRect.y) } : { x: 0, y: 0 },
    }
  })
  // Suspects come from actual shift SOURCES (contract: "img/video sources without both
  // width+height attributes"), not every img/video on the page — an unsized image that
  // never moved isn't implicated in this report. Deduped across entries by node identity.
  var seen = new Set()
  var suspects = []
  allSources.forEach(function (el) {
    if (seen.has(el)) return
    seen.add(el)
    var tag = el.tagName && el.tagName.toLowerCase()
    if ((tag === 'img' || tag === 'video') && !(el.hasAttribute('width') && el.hasAttribute('height'))) {
      suspects.push(selectorOf(el))
    }
  })
  return { shifts: shifts, suspects: suspects }
})()`

// This is an OBSERVATION, not a deterministic snapshot: score depends on real wall-clock
// timing (setTimeout drift, main-thread contention). Local dev servers under-report —
// throttle CPU/network to reproduce production shifts. Only the fixture's element
// ATTRIBUTION is asserted in tests, never an exact score.
export async function measureStability(url: string, opts: StabilityOpts = {}): Promise<StabilityResult> {
  const duration = opts.duration ?? DEFAULT_DURATION_MS
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD

  const raw = await withPage(url, async (client: any) => {
    // "duration past load": withPage's navigate() already waits for the load event (plus a
    // short network-idle settle), so this wait — measured from when fn() is entered — starts
    // at-or-after load, never before it.
    await new Promise((resolve) => setTimeout(resolve, duration))
    const { result } = await client.Runtime.evaluate({ expression: COLLECT_SCRIPT, returnByValue: true })
    return result.value as { shifts: Shift[]; suspects: string[] }
  }, {
    port: opts.port,
    viewport: opts.viewport,
    beforeNavigate: (client: any) => client.Page.addScriptToEvaluateOnNewDocument({ source: INSTALL_SCRIPT }),
  })

  const score = raw.shifts.reduce((sum, s) => sum + s.score, 0)
  return {
    score,
    threshold,
    shifts: raw.shifts,
    suspects: raw.suspects.map((selector) => `suspect: ${selector} has no intrinsic size attributes`),
  }
}

// Trims float noise (e.g. 0.12500000000000003) without hiding real precision — 3 decimals
// is well below CLS's practically meaningful resolution.
const fmt = (n: number): string => String(Math.round(n * 1000) / 1000)

export function renderStability(r: StabilityResult): string {
  const lines = [`STABILITY: ${fmt(r.score)} (threshold ${r.threshold})`]
  for (const s of r.shifts) {
    lines.push(`[+${s.atMs}] ${s.selector} moved (${s.from.x},${s.from.y})→(${s.to.x},${s.to.y}) score ${fmt(s.score)}`)
  }
  lines.push(...r.suspects)
  return lines.join('\n')
}
