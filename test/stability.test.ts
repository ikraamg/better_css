import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { shutdownChrome } from '../src/core/connect.js'
import { measureStability, renderStability } from '../src/core/stability.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

// (a) shifty fixture: img.photo (no width/height attrs) sits below where a 200px-tall
// unsized block is inserted after 300ms — deterministic push, comfortably > 0.1 at a
// 400x800 viewport (impact_fraction 0.5 * distance_fraction 0.25 = 0.125).
test('stability on the shifty fixture reports the shift, its timing bucket, and the suspect', async () => {
  const result = await measureStability(`${srv.url}/shifty/index.html`, { viewport: { width: 400, height: 800 } })
  const output = renderStability(result)

  expect(output.split('\n')[0]).toMatch(/^STABILITY: 0\.\d+/)
  expect(result.score).toBeGreaterThan(0.1)

  // attribution: the pushed-down content's selector, with a +300-ish timing bucket
  expect(output).toMatch(/\[\+[2-4]\d\d\] img\.photo moved \(0,0\)→\(0,200\) score 0\.\d+/)

  // suspect: the same unsized img
  expect(output).toContain('suspect: img.photo has no intrinsic size attributes')
}, 20_000)

test('stability on the shifty fixture exceeds the default threshold', async () => {
  const result = await measureStability(`${srv.url}/shifty/index.html`, { viewport: { width: 400, height: 800 } })
  expect(result.score).toBeGreaterThan(result.threshold)
}, 20_000)

// (b) fluid fixture has no async DOM changes — no layout-shift entries at all.
test('stability on the fluid fixture reports zero score (no shifts)', async () => {
  const result = await measureStability(`${srv.url}/fluid/index.html`, { duration: 500 })
  expect(result.score).toBe(0)
  expect(result.shifts).toEqual([])
  expect(result.suspects).toEqual([])
  expect(renderStability(result)).toBe('STABILITY: 0 (threshold 0.1)')
}, 20_000)

test('--threshold overrides the default 0.1 boundary', async () => {
  const result = await measureStability(`${srv.url}/shifty/index.html`, {
    viewport: { width: 400, height: 800 },
    threshold: 0.5,
  })
  expect(result.score).toBeLessThan(result.threshold)
  expect(renderStability(result)).toContain('(threshold 0.5)')
}, 20_000)
