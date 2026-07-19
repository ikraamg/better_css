import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { extract } from '../src/core/extract.js'
import { buildTree, renderTree, selectorOf, walk, findNode, type LayoutNode } from '../src/core/tree.js'

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

test('from option scopes rendering to a subtree and suppresses page flags', async () => {
  const tree = await withPage(`${srv.url}/basic/index.html`, async (c) => buildTree(await extract(c)))
  let main: LayoutNode | undefined
  walk(tree.root, (n) => { if (selectorOf(n) === 'main') main = n })
  const text = renderTree(tree, { from: main! })
  expect(text.split('\n')[0].startsWith('main (0,64')).toBe(true)
  expect(text).not.toContain('header#top')
  expect(text).not.toContain('⚠H-OVERFLOW')
})

test('flags horizontal overflow on the root line', async () => {
  const text = await render('/overflow-h/index.html')
  // .wide is 1400px in a 1280px viewport → content overflows by 120px
  expect(text.split('\n')[0].endsWith('⚠H-OVERFLOW:+120px')).toBe(true)
})

test('depth option truncates', async () => {
  const full = await render('/basic/index.html')
  const shallow = await withPage(`${srv.url}/basic/index.html`, async (c) =>
    renderTree(buildTree(await extract(c)), { depth: 1 }))
  expect(shallow.split('\n').length).toBeLessThan(full.split('\n').length)
  expect(shallow).toContain('…')
})

test('budget truncates a deep tree to fit and appends one note line', async () => {
  const full = await render('/deep/index.html')
  expect(full.split('\n').length).toBeGreaterThan(400)
  const budgeted = await withPage(`${srv.url}/deep/index.html`, async (c) =>
    renderTree(buildTree(await extract(c)), { budget: 400 }))
  const lines = budgeted.split('\n')
  expect(lines.length).toBeLessThanOrEqual(400)
  expect(lines[lines.length - 1])
    .toMatch(/^… truncated to depth \d+ \(\d+ elements total\) — pass depth or selector to expand$/)
})

test('explicit depth wins over budget — no truncation note', async () => {
  const text = await withPage(`${srv.url}/deep/index.html`, async (c) =>
    renderTree(buildTree(await extract(c)), { depth: 2, budget: 1 }))
  expect(text).not.toContain('truncated to depth')
  expect(text.split('\n').length).toBe(4)
})

test('basic fixture renders byte-identical with and without the default budget', async () => {
  const withoutBudget = await render('/basic/index.html')
  const withBudget = await withPage(`${srv.url}/basic/index.html`, async (c) =>
    renderTree(buildTree(await extract(c)), { budget: 400 }))
  expect(withBudget).toBe(withoutBudget)
})

// findNode scopes layout/inspect by selector. It must behave like a simple compound
// selector (tag + #id + class SUBSET), matching the intuition inspect/explain already give —
// not only the exact rendered selectorOf string.
test('findNode: bare tag, class subset, and single class/#id/exact all resolve', async () => {
  const tree = await withPage(`${srv.url}/findnode/index.html`, async (c) => buildTree(await extract(c)))
  // bare tag, even when the element carries an id or classes (selectorOf would be header#top / nav.a.b.c)
  expect(findNode(tree, 'header')?.tag).toBe('header')
  expect(findNode(tree, 'nav')?.tag).toBe('nav')
  // class subset of an element with more (and >3) classes — selectorOf truncates to .card.featured.wide
  expect(findNode(tree, 'section.card.featured')?.classes).toContain('tall')
  expect(findNode(tree, 'nav.a.b')?.tag).toBe('nav')
  // unchanged behaviors: single class, #id, exact selectorOf
  expect(findNode(tree, '.card')?.tag).toBe('section')
  expect(findNode(tree, '#top')?.tag).toBe('header')
  expect(findNode(tree, 'section.card.featured.wide')?.tag).toBe('section')
  // dotted/#-bearing Tailwind arbitrary values can't be tokenized by the compound parser —
  // they must still resolve via the raw-class fallback (regression guard)
  expect(findNode(tree, '.gap-[0.5rem]')?.tag).toBe('div')
  expect(findNode(tree, '.bg-[#fff]')?.tag).toBe('div')
  // a genuinely absent selector still misses
  expect(findNode(tree, 'article')).toBeUndefined()
})
