import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { extract } from '../src/core/extract.js'
import { buildTree, renderTree } from '../src/core/tree.js'
import { checkInvariants, renderViolations } from '../src/core/invariants.js'

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

// Field #3 regression guard: under true mobile emulation Chrome inflates the LAYOUT
// viewport to content width, so sourcing the overflow denominator from it makes
// contentWidth - viewport read 0 and viewport-overflow silently never fire at mobile
// widths. The mobile-overflow fixture's culprit is an absolutely-positioned wide
// element — parent-bleed structurally skips absolute/fixed children, so this overflow
// can ONLY be caught by viewport-overflow (no incidental parent-bleed coverage). The
// denominator must come from the VISUAL viewport (stays clamped to 375).
test('viewport-overflow still fires at mobile widths when the overflow is not a direct-parent bleed', async () => {
  const { violations } = await withPage(`${srv.url}/mobile-overflow/index.html`, async (c) => {
    return { violations: checkInvariants(buildTree(await extract(c))) }
  }, { viewport: { width: 375, height: 800 } })
  const v = violations.find((v) => v.rule === 'viewport-overflow')
  expect(v?.selector).toBe('div.escapee')
  // proof the coverage isn't leaking through parent-bleed: the absolute escapee is not
  // flagged as a bleed (positioned children escape their parent on purpose)
  expect(violations.some((v) => v.rule === 'parent-bleed' && v.selector === 'div.escapee')).toBe(false)
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

// Field NEXT-1c: parent-bleed exempts deliberately-displaced children (matching overlap's
// intent), but NOT a bare position:relative with no offset — that still bleeds for real.
test('parent-bleed: deliberately displaced children (negative margin, transform, positioned+offset) are exempt', async () => {
  const { violations } = await violationsFor('/displaced/index.html')
  const bleeds = violations.filter((v) => v.rule === 'parent-bleed')
  for (const sel of ['div.pull', 'div.shifted', 'div.xformed']) {
    expect(bleeds.some((v) => v.selector === sel)).toBe(false)
  }
})

test('parent-bleed: a bare position:relative child (no offset) that overflows is still flagged', async () => {
  const { violations } = await violationsFor('/displaced/index.html')
  const bleeds = violations.filter((v) => v.rule === 'parent-bleed')
  expect(bleeds.some((v) => v.selector === 'div.bare-rel')).toBe(true)
})

// A non-translating transform (translateZ(0), a compositing hack) does not move the box —
// exempting it would silently drop a real overflow, so it stays flagged.
test('parent-bleed: a non-translating transform does not exempt a real overflow', async () => {
  const { violations } = await violationsFor('/displaced/index.html')
  const bleeds = violations.filter((v) => v.rule === 'parent-bleed')
  expect(bleeds.some((v) => v.selector === 'div.gpu')).toBe(true)
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

test('parent-bleed: suspect line resolves via backendNodeId when the selector is unescapable', async () => {
  const text = await withPage(`${srv.url}/tailwindish/index.html`, async (c) => {
    const tree = buildTree(await extract(c))
    return renderViolations(c, checkInvariants(tree))
  })
  expect(text).toContain('parent-bleed')
  expect(text).toMatch(/suspect: width: 300px/)
})
