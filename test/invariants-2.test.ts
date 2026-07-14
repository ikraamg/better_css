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

test('overlap: flags un-layered overlap, allows z-indexed modal', async () => {
  const vs = (await violationsFor('/overlap/index.html')).filter((v) => v.rule === 'overlap')
  expect(vs).toHaveLength(1)
  expect(vs[0].message).toContain('div.oops')
  expect(vs[0].message).toContain('header')
})

test('tap-target: flags sub-24px interactive elements', async () => {
  const vs = (await violationsFor('/tap/index.html')).filter((v) => v.rule === 'tap-target')
  expect(vs).toHaveLength(1)
  expect(vs[0].selector).toBe('a')
  expect(vs[0].message).toContain('16x16')
})
