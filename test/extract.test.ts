import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { extract, STYLE_WHITELIST } from '../src/core/extract.js'

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
