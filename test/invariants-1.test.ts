import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { extract } from '../src/core/extract.js'
import { buildTree, renderTree } from '../src/core/tree.js'
import { checkInvariants } from '../src/core/invariants.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

async function violationsFor(path: string) {
  return withPage(`${srv.url}${path}`, async (c) => {
    const tree = buildTree(await extract(c))
    return { violations: checkInvariants(tree), tree }
  })
}

test('viewport-overflow: names the culprit and the amount', async () => {
  const { violations, tree } = await violationsFor('/overflow-h/index.html')
  const v = violations.find((v) => v.rule === 'viewport-overflow')!
  expect(v.selector).toBe('div.wide')
  expect(v.message).toContain('120px') // 1400 - 1280
  expect(renderTree(tree)).toContain('⚠H-OVERFLOW')
})

test('parent-bleed: flags static child exceeding parent, not scroll containers', async () => {
  const { violations, tree } = await violationsFor('/bleed/index.html')
  const bleeds = violations.filter((v) => v.rule === 'parent-bleed')
  // borderless parent + bordered parent; the ignored wrapper's child is skipped
  expect(bleeds).toHaveLength(2)
  expect(bleeds[0].selector).toBe('div.child')
  expect(bleeds[0].message).toContain('100px') // 300 - 200
  expect(bleeds[1].message).toContain('104px') // right edge 302 - padding-box right 198
  expect(renderTree(tree)).toContain('⚠BLEED:+100px')
})

test('zero-size: flags invisible interactive element, honors ignore attr', async () => {
  const { violations, tree } = await violationsFor('/zero-size/index.html')
  const zeros = violations.filter((v) => v.rule === 'zero-size')
  // the opacity:0-wrapped button and the ignored button are both skipped
  expect(zeros).toHaveLength(1)
  expect(zeros[0].selector).toBe('button')
  expect(renderTree(tree)).toContain('⚠ZERO-SIZE')
  // page overflow comes only from an ignored element -> suppressed, no body fallback
  expect(violations.filter((v) => v.rule === 'viewport-overflow')).toEqual([])
})

test('clean page has no violations', async () => {
  const { violations } = await violationsFor('/basic/index.html')
  expect(violations).toEqual([])
})
