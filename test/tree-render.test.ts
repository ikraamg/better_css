import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { extract } from '../src/core/extract.js'
import { buildTree, renderTree } from '../src/core/tree.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

async function render(path: string) {
  return withPage(`${srv.url}${path}`, async (c) => renderTree(buildTree(await extract(c))))
}

test('renders geometry, layout mode, and nonzero padding', async () => {
  const text = await render('/basic/index.html')
  expect(text).toContain('body (0,0 1280x')
  expect(text).toContain('header#top (0,0 1280x64) flex row gap:16 pad:12,24')
  // Browser truth: computed grid-template-columns resolves the 1fr track to its used
  // pixel value (main is 1280px wide, sidebar col is 240px, so 1fr -> 1040px).
  expect(text).toContain('  main (0,64 1280x400) grid cols:240,1040')
  expect(text).toContain('    aside.sidebar (0,64 240x400)')
  expect(text).toContain('    section.content (240,64 1040x400) pad:32')
})

test('output is deterministic across two extractions', async () => {
  const a = await render('/basic/index.html')
  const b = await render('/basic/index.html')
  expect(a).toBe(b)
})

test('collapses repeated siblings, keeps deviants separate', async () => {
  const text = await render('/collapse/index.html')
  expect(text).toMatch(/div\.card ×\d+ \(~380x220\)/)
  // Browser truth: grid-template-columns is repeat(3, 380px) -> 3 columns per row, so
  // the grid wraps after 3 cards. The 4th div (.tall) is the first item of row 2:
  // col0 x = padding(20) = 20; row1 y = padding(20) + row0 height(220) + gap(20) = 260.
  expect(text).toContain('div.card.tall (20,260 380x222)')
  // collapsed run count: 3 identical before deviant, 2 after → ×3 and ×2
  expect(text).toMatch(/div\.card ×3/)
  expect(text).toMatch(/div\.card ×2/)
})

test('depth option truncates', async () => {
  const full = await render('/basic/index.html')
  const shallow = await withPage(`${srv.url}/basic/index.html`, async (c) =>
    renderTree(buildTree(await extract(c)), { depth: 1 }))
  expect(shallow.split('\n').length).toBeLessThan(full.split('\n').length)
  expect(shallow).toContain('…')
})
