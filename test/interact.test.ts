import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { assertNoInteractNavigation, interactSawNavigation, runInteractSteps } from '../src/core/interact.js'
import { extract } from '../src/core/extract.js'
import { buildTree, findNode } from '../src/core/tree.js'
import { checkInvariants } from '../src/core/invariants.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

test('click dispatches a real click event that opens the menu', async () => {
  const box = await withPage(`${srv.url}/interactive/index.html`, async (c) => {
    await runInteractSteps(c, { click: ['#menu-btn'] })
    const tree = buildTree(await extract(c))
    return findNode(tree, '#menu')?.box
  })
  expect(box).toEqual({ x: 0, y: 32, w: 400, h: 100 })
})

test('numeric scroll-to actually scrolls and fires a real scroll event (past-400 handler reveals the back-to-top link)', async () => {
  const violations = await withPage(`${srv.url}/interactive/index.html`, async (c) => {
    await runInteractSteps(c, { scrollTo: '500' })
    return checkInvariants(buildTree(await extract(c)))
  })
  expect(violations.map((v) => v.rule)).toContain('tap-target')
})

test('selector scroll-to (scrollIntoView) also fires the real scroll handler', async () => {
  const violations = await withPage(`${srv.url}/interactive/index.html`, async (c) => {
    await runInteractSteps(c, { scrollTo: '#section' })
    return checkInvariants(buildTree(await extract(c)))
  })
  expect(violations.map((v) => v.rule)).toContain('tap-target')
})

test('order: scrollTo runs before clicks — clicking the scroll-revealed #top-link only works because scrollTo already ran', async () => {
  // #top-link is display:none (no box model, unclickable) until scrolled past y=400;
  // this only resolves if scrollTo genuinely ran before the click, not after or in parallel.
  await expect(withPage(`${srv.url}/interactive/index.html`, (c) =>
    runInteractSteps(c, { scrollTo: '500', click: ['#top-link'] })))
    .resolves.toBeUndefined()
})

test('two clicks on the same selector run in order (open, then close)', async () => {
  const box = await withPage(`${srv.url}/interactive/index.html`, async (c) => {
    await runInteractSteps(c, { click: ['#menu-btn', '#menu-btn'] })
    const tree = buildTree(await extract(c))
    return findNode(tree, '#menu')
  })
  expect(box).toBeUndefined() // closed again -> display:none -> absent from the tree
})

test('click on a selector matching nothing reuses resolveNode\'s suggestions error', async () => {
  await expect(withPage(`${srv.url}/interactive/index.html`, (c) => runInteractSteps(c, { click: ['.nope'] })))
    .rejects.toThrow(/No element matches '\.nope'/)
})

test('a click that causes a real navigation aborts with a clear error', async () => {
  await expect(withPage(`${srv.url}/interactive/index.html`, (c) => runInteractSteps(c, { click: ['#away-link'] })))
    .rejects.toThrow(/--click caused a navigation to .*\/interactive\/other\.html — interact steps are for same-page UI/)
})

test('a delayed (setTimeout) redirect landing during settle aborts with the same clear error, not silence', async () => {
  await expect(withPage(`${srv.url}/interactive/index.html`, (c) => runInteractSteps(c, { click: ['#late-nav'] })))
    .rejects.toThrow(/--click caused a navigation to .*\/interactive\/other\.html — interact steps are for same-page UI/)
})

test('settle waits out a transform transition, so the capture sees the final position', async () => {
  const x = await withPage(`${srv.url}/interactive/index.html`, async (c) => {
    await runInteractSteps(c, { click: ['#anim-box'] })
    const { result } = await c.Runtime.evaluate({
      expression: 'document.getElementById("anim-box").getBoundingClientRect().x',
      returnByValue: true,
    })
    return result.value
  })
  expect(Math.round(x)).toBe(200)
})

test('a click that only changes the URL hash does NOT trigger the navigation guard', async () => {
  await expect(withPage(`${srv.url}/interactive/index.html`, (c) => runInteractSteps(c, { click: ['#hash-link'] })))
    .resolves.toBeUndefined()
})

test('no click/scrollTo given is a no-op', async () => {
  await expect(withPage(`${srv.url}/interactive/index.html`, (c) => runInteractSteps(c, {}))).resolves.toBeUndefined()
})

test('a delayed redirect with NO layout churn returns clean from runInteractSteps (settle exits instantly, well before the redirect fires) but is still recorded once it lands, for the caller\'s post-capture check to catch', async () => {
  await withPage(`${srv.url}/interactive/index.html`, async (c) => {
    // #silent-late-nav's setTimeout fires 500ms after the click — no CSS churn at all,
    // so waitForSettle's two-identical-frame check passes on its very first poll and
    // runInteractSteps returns tens of ms after the click, long before the redirect.
    await expect(runInteractSteps(c, { click: ['#silent-late-nav'] })).resolves.toBeUndefined()
    expect(interactSawNavigation(c)).toBeNull()

    // This is a real setTimeout in the page, not a simulated one — wait past it (this
    // mirrors what would happen during a caller's own capture work, or simply the time
    // between return and whenever the caller gets around to checking).
    await new Promise((resolve) => setTimeout(resolve, 700))
    await c.Runtime.evaluate({ expression: '1' }).catch(() => {}) // flush the queued frameNavigated

    expect(interactSawNavigation(c)).toMatch(/\/interactive\/other\.html$/)
    expect(() => assertNoInteractNavigation(c))
      .toThrow(/--click caused a navigation to .*\/interactive\/other\.html — interact steps are for same-page UI/)
  })
}, 10_000)
