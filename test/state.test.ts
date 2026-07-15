import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { forcePseudoStates } from '../src/core/state.js'
import { explain } from '../src/core/explain.js'
import { extract } from '../src/core/extract.js'
import { buildTree, findNode } from '../src/core/tree.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

test('forcing hover changes the box width CDP reports for that element', async () => {
  const width = await withPage(`${srv.url}/hover/index.html`, async (c) => {
    await forcePseudoStates(c, { hover: '.cta' })
    const tree = buildTree(await extract(c))
    return findNode(tree, '.cta')!.box.w
  })
  expect(width).toBe(400)
})

test('without forcing, the element stays at its natural width', async () => {
  const width = await withPage(`${srv.url}/hover/index.html`, async (c) => {
    const tree = buildTree(await extract(c))
    return findNode(tree, '.cta')!.box.w
  })
  expect(width).toBe(200)
})

test('the same selector forced for two states applies both from one CDP call', async () => {
  const box = await withPage(`${srv.url}/hover/index.html`, async (c) => {
    await forcePseudoStates(c, { hover: '.cta', focus: '.cta' })
    const tree = buildTree(await extract(c))
    return findNode(tree, '.cta')!.box
  })
  expect(box.w).toBe(400) // :hover
  expect(box.h).toBe(60) // :focus min-height
})

test('explain sees the :hover rule as the cascade winner once forced', async () => {
  const e = await withPage(`${srv.url}/hover/index.html`, async (c) => {
    await forcePseudoStates(c, { hover: '.cta' })
    return explain(c, '.cta', 'width')
  })
  const winner = e.entries.find((x) => x.status === 'winner')!
  expect(winner.value).toBe('400px')
  expect(winner.selector).toContain(':hover')
  expect(winner.file).toContain('main.css')
})

test('unknown selector reuses resolveNode\'s suggestions error', async () => {
  await expect(withPage(`${srv.url}/hover/index.html`, (c) => forcePseudoStates(c, { hover: '.nope' })))
    .rejects.toThrow(/No element matches '\.nope'/)
})

test('no state flags given is a no-op', async () => {
  await expect(withPage(`${srv.url}/hover/index.html`, (c) => forcePseudoStates(c, {}))).resolves.toBeUndefined()
})
