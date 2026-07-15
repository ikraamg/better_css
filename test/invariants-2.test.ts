import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { extract } from '../src/core/extract.js'
import { buildTree } from '../src/core/tree.js'
import { checkInvariants } from '../src/core/invariants.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

async function violationsFor(path: string) {
  return withPage(`${srv.url}${path}`, async (c) => checkInvariants(buildTree(await extract(c))))
}

test('text-clip: flags hidden overflow without ellipsis opt-in only', async () => {
  const vs = (await violationsFor('/clip/index.html')).filter((v) => v.rule === 'text-clip')
  expect(vs).toHaveLength(1)
  expect(vs[0].selector).toBe('div.clip')
  expect(vs[0].message).toContain('clipped')
})

test('overlap: any non-static position is a layering opt-in, even without z-index', async () => {
  const vs = (await violationsFor('/overlap/index.html')).filter((v) => v.rule === 'overlap')
  // .oops is position:absolute with no z-index — under the old semantics this was
  // flagged; position alone is now read as "I know what I'm doing"
  expect(vs.some((v) => v.message.includes('div.oops'))).toBe(false)
  // .modal/.under stay exempt too (unchanged behavior, still positioned)
  expect(vs.some((v) => v.message.includes('div.modal') || v.message.includes('div.under'))).toBe(false)
})

test('overlap: two static grid items explicitly placed in the same cell is a genuine accident', async () => {
  const vs = (await violationsFor('/overlap/index.html')).filter((v) => v.rule === 'overlap')
  const hit = vs.find((v) => v.selector === 'div.cell-b')
  expect(hit).toBeDefined()
  expect(hit!.message).toContain('div.cell-a')
})

test('overlap: an element overlapping two in-flow siblings is reported once (dedup)', async () => {
  const vs = (await violationsFor('/overlap/index.html')).filter((v) => v.rule === 'overlap')
  expect(vs.filter((v) => v.selector === 'div.dedup-c')).toHaveLength(1)
  // dedup-a and dedup-b are adjacent, not overlapping — no violation between them
  expect(vs.some((v) => v.selector === 'div.dedup-b')).toBe(false)
})

test('overlap: svg descendants are exempt — deliberately overlapping paths are not flagged', async () => {
  const vs = (await violationsFor('/svg/index.html')).filter((v) => v.rule === 'overlap')
  expect(vs).toEqual([])
})

test('tap-target: the svg element itself still participates — a tiny <a> wrapping an svg is still a candidate', async () => {
  const vs = (await violationsFor('/svg/index.html')).filter((v) => v.rule === 'tap-target')
  expect(vs.some((v) => v.selector === 'a')).toBe(true)
})

test('tap-target: flags sub-24px interactive elements', async () => {
  const vs = (await violationsFor('/tap/index.html')).filter((v) => v.rule === 'tap-target')
  expect(vs).toHaveLength(1)
  expect(vs[0].selector).toBe('a')
  expect(vs[0].message).toContain('16x16')
})
