import { afterAll, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { extract } from '../src/core/extract.js'
import { buildTree, renderTree } from '../src/core/tree.js'
import { saveSnapshot, loadSnapshot, diffTrees, renderDiff } from '../src/core/snapshot.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

const render = (path: string) =>
  withPage(`${srv.url}${path}`, async (c) => renderTree(buildTree(await extract(c))))

test('save/load round-trips', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bettercss-test-'))
  const text = await render('/diff/before.html')
  const file = saveSnapshot(text, 'before', dir)
  expect(file).toBe(join(dir, 'before.tree'))
  expect(loadSnapshot('before', dir)).toBe(text)
})

test('diff reports moved, resized nothing falsely, and disappeared', async () => {
  const before = await render('/diff/before.html')
  const after = await render('/diff/after.html')
  const entries = diffTrees(before, after)
  const moved = entries.find((e) => e.kind === 'moved' && e.key.includes('nav'))!
  expect(moved.detail).toContain('-8') // nav x shifted left by 8
  expect(entries.find((e) => e.kind === 'disappeared' && e.key.includes('footer'))).toBeTruthy()
  expect(entries.filter((e) => e.kind === 'resized')).toHaveLength(0)
})

test('identical trees diff empty', async () => {
  const a = await render('/diff/before.html')
  expect(diffTrees(a, a)).toEqual([])
  expect(renderDiff([])).toBe('(no layout changes)')
})
