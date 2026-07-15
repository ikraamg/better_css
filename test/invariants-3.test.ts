import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { extract } from '../src/core/extract.js'
import { buildTree } from '../src/core/tree.js'
import { checkInvariants, renderViolations } from '../src/core/invariants.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

async function violationsFor(path: string) {
  return withPage(`${srv.url}${path}`, async (c) => checkInvariants(buildTree(await extract(c))))
}

test('parent-bleed: cards clipped by an ancestor above the direct parent are not flagged (carousel)', async () => {
  const violations = await violationsFor('/carousel/index.html')
  const cardBleeds = violations.filter((v) => v.rule === 'parent-bleed' && v.selector === 'div.card')
  expect(cardBleeds).toEqual([])
})

test('parent-bleed: a page-level overflow-x:hidden ancestor does not suppress a real bleed', async () => {
  const violations = await violationsFor('/carousel/index.html')
  const itemBleeds = violations.filter((v) => v.rule === 'parent-bleed' && v.selector === 'div.wide-item')
  expect(itemBleeds).toHaveLength(3)
  const msgs = itemBleeds.map((v) => v.message).join(' | ')
  expect(msgs).toContain('120px') // 300 - 180
  expect(msgs).toContain('110px') // 300 - 190
  expect(msgs).toContain('100px') // 300 - 200
})

test('renderViolations: groups repeats sharing (rule, selector) into one line with count and px range', async () => {
  const text = await withPage(`${srv.url}/carousel/index.html`, async (c) => {
    const tree = buildTree(await extract(c))
    return renderViolations(c, checkInvariants(tree))
  })
  const lines = text.split('\n').filter((l) => l.includes('div.wide-item'))
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('×3')
  expect(lines[0]).toContain('100')
  expect(lines[0]).toContain('120')
  // the group spans three distinct parents — the line must not imply a single one
  expect(lines[0]).toContain('across 3 parents')
})

test('renderViolations: dimension-style messages group with a count, no fabricated px range', async () => {
  const text = await withPage(`${srv.url}/carousel/index.html`, async (c) => {
    const tree = buildTree(await extract(c))
    return renderViolations(c, checkInvariants(tree))
  })
  const lines = text.split('\n').filter((l) => l.startsWith('tap-target') && l.includes('a.icon'))
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('×3')
  // /(\d+)px/ against "is 16x16px" would fabricate a 16–16px "range" — must not appear
  expect(lines[0]).not.toContain('16–16px')
})

test('renderViolations: a px-looking class name does not poison the range (structured px, not message regex)', async () => {
  const text = await withPage(`${srv.url}/carousel/index.html`, async (c) => {
    const tree = buildTree(await extract(c))
    return renderViolations(c, checkInvariants(tree))
  })
  // selector renders as div.w-[300px] — its class contains "300px" ahead of the real
  // bleed amount in the message, which a message-regex scan would grab instead
  const lines = text.split('\n').filter((l) => l.startsWith('parent-bleed') && l.includes('div.w-[300px]'))
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('×2')
  expect(lines[0]).toContain('130')
  expect(lines[0]).toContain('150')
  expect(lines[0]).not.toContain('300–300px')
})

test('renderViolations: same-parent children with different bleed amounts get no across-parents qualifier', async () => {
  const text = await withPage(`${srv.url}/carousel/index.html`, async (c) => {
    const tree = buildTree(await extract(c))
    return renderViolations(c, checkInvariants(tree))
  })
  const lines = text.split('\n').filter((l) => l.startsWith('parent-bleed') && l.includes('div.leak'))
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('×2')
  expect(lines[0]).not.toContain('across')
})
