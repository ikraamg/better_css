import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome, setDesktopOnly } from '../src/core/connect.js'
import { boundsScale, extract, normalizeBounds, STYLE_WHITELIST } from '../src/core/extract.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

test('captures snapshot with layout bounds and whitelisted styles', async () => {
  const raw = await withPage(`${srv.url}/basic/index.html`, extract)
  expect(raw.viewport).toEqual({ width: 1280, height: 800 })
  expect(raw.documents.length).toBeGreaterThan(0)
  const doc = raw.documents[0]
  // BODY exists in the node table
  const names = doc.nodes.nodeName.map((i: number) => raw.strings[i])
  expect(names).toContain('BODY')
  // layout table is aligned: every layout row has 4-number bounds
  expect(doc.layout.nodeIndex.length).toBe(doc.layout.bounds.length)
  expect(doc.layout.bounds[0]).toHaveLength(4)
  // whitelisted styles resolve through the string table
  const headerRow = doc.layout.nodeIndex.findIndex((ni: number) =>
    raw.strings[doc.nodes.nodeName[ni]] === 'HEADER')
  const styleOf = (row: number, prop: string) => {
    const idx = doc.layout.styles[row][STYLE_ORDER(prop)]
    return raw.strings[idx]
  }
  // display of header must be 'flex' (see fixture CSS)
  expect(styleOf(headerRow, 'display')).toBe('flex')
})

// helper mirroring extract.ts whitelist ordering
function STYLE_ORDER(prop: string): number {
  return (STYLE_WHITELIST as readonly string[]).indexOf(prop)
}

// Field #3, contract 2 (THE known unknown, resolved in 313f924): mobile emulation now
// runs at deviceScaleFactor 2, so a static page's element must report the IDENTICAL
// CSS-px size whether captured under the old squeezed-desktop emulation (DPR 1) or the
// new true-mobile emulation (DPR 2) — normalizeBounds must divide DOMSnapshot's
// device-px bounds back to CSS px regardless of DPR. responsive/index.html's div.fixed
// is a fixed 720x50px box, independent of viewport width — a clean bounds pin.
function divBounds(raw: { documents: any[]; strings: string[] }): number[] {
  const doc = raw.documents[0]
  const row = doc.layout.nodeIndex.findIndex((ni: number) => raw.strings[doc.nodes.nodeName[ni]] === 'DIV')
  return doc.layout.bounds[row]
}

test('static-page geometry is unchanged by mobile emulation alone (bounds stay CSS px at DPR 2)', async () => {
  const url = `${srv.url}/responsive/index.html`
  const viewport = { width: 375, height: 800 }

  let desktop
  setDesktopOnly(true)
  try { desktop = await withPage(url, extract, { viewport }) } finally { setDesktopOnly(false) }
  const mobile = await withPage(url, extract, { viewport })

  expect(divBounds(desktop)).toEqual([0, 0, 720, 50])
  expect(divBounds(mobile)).toEqual(divBounds(desktop))
})

// Field #3, RED test (b): a page that never opted into <meta name=viewport> renders
// GENUINELY differently under true mobile emulation than under the old squeeze — this
// is real, correct browser truth (the classic "forgot the viewport tag" mobile bug),
// not a bounds-normalization bug. mobile-viewport/index.html deliberately has no
// viewport meta tag, unlike every other fixture.
test('a fixture without <meta name=viewport> renders at the real mobile fallback width, not the squeezed-desktop width', async () => {
  const url = `${srv.url}/mobile-viewport/index.html`
  const viewport = { width: 375, height: 800 }

  let desktop
  setDesktopOnly(true)
  try { desktop = await withPage(url, extract, { viewport }) } finally { setDesktopOnly(false) }
  const mobile = await withPage(url, extract, { viewport })

  // old squeeze: a desktop window forced to 375 CSS px, no viewport-meta involved
  expect(desktop.viewport.width).toBe(375)
  // true mobile without a viewport meta tag: Chrome's real "desktop site" fallback
  // (~980px), NOT the requested 375 — the exact behavior the old squeeze never exercised
  expect(mobile.viewport.width).toBeGreaterThan(900)
})

// Device-pixel normalization seam (Chrome builds that report DOMSnapshot bounds in
// device px — observed live on Chrome 150/Retina). The live proof is the entire rest of
// the suite (every pinned CSS-px value); these pin the calibration + division math.
test('boundsScale derives the snapshot scale from the layoutViewport/cssLayoutViewport ratio', () => {
  expect(boundsScale({ cssLayoutViewport: { clientWidth: 1280 }, layoutViewport: { clientWidth: 2560 } })).toBe(2)
  expect(boundsScale({ cssLayoutViewport: { clientWidth: 1280 }, layoutViewport: { clientWidth: 1280 } })).toBe(1)
  // defensive: a metrics payload missing either field must never divide by 0/undefined
  expect(boundsScale({ cssLayoutViewport: { clientWidth: 0 }, layoutViewport: { clientWidth: 2560 } })).toBe(1)
  expect(boundsScale({})).toBe(1)
})

test('normalizeBounds divides all bounds by the scale, and is a byte-level no-op at scale 1', () => {
  const docs = () => [
    { layout: { bounds: [[0, 0, 2560, 1600], [128, 256, 512, 64]] } },
    { layout: { bounds: [[10, 20, 30, 40]] } }, // second document (iframe) normalized too
  ]
  const scaled = docs()
  normalizeBounds(scaled, 2)
  expect(scaled[0].layout.bounds).toEqual([[0, 0, 1280, 800], [64, 128, 256, 32]])
  expect(scaled[1].layout.bounds).toEqual([[5, 10, 15, 20]])

  const untouched = docs()
  normalizeBounds(untouched, 1)
  expect(untouched).toEqual(docs())
})
