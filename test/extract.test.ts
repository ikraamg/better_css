import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
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
