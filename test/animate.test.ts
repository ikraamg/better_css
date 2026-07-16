import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { animateNote, needsAnimationCapture, settleAnimations } from '../src/core/animate.js'
import { extract } from '../src/core/extract.js'
import { buildTree, findNode } from '../src/core/tree.js'
import { checkInvariants } from '../src/core/invariants.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

test('needsAnimationCapture is true for settled or at-time, false otherwise', () => {
  expect(needsAnimationCapture({})).toBe(false)
  expect(needsAnimationCapture({ settled: true })).toBe(true)
  expect(needsAnimationCapture({ atTime: 0 })).toBe(true)
})

// (a) check --settled -> parent-bleed exactly 100px (child settles to 400px inside a 300px parent)
test('settled seeks the transition to its end, surfacing the exact parent-bleed', async () => {
  const violations = await withPage(`${srv.url}/animated/index.html`, async (c) => {
    await settleAnimations(c, { settled: true })
    return checkInvariants(buildTree(await extract(c)))
  }, { captureAnimations: true })
  const bleed = violations.find((v) => v.rule === 'parent-bleed')
  expect(bleed?.message).toContain('bleeds 100px outside div.parent')
})

// (b) layout --settled shows the element at 400px, and two settled runs are byte-identical
test('settled shows the transitioned element at its final 400px width', async () => {
  const width = await withPage(`${srv.url}/animated/index.html`, async (c) => {
    await settleAnimations(c, { settled: true })
    const tree = buildTree(await extract(c))
    return findNode(tree, '#target')!.box.w
  }, { captureAnimations: true })
  expect(width).toBe(400)
})

test('two --settled runs are byte-identical (determinism)', async () => {
  const render = async () => withPage(`${srv.url}/animated/index.html`, async (c) => {
    await settleAnimations(c, { settled: true })
    return buildTree(await extract(c))
  }, { captureAnimations: true })
  const a = JSON.stringify(await render())
  const b = JSON.stringify(await render())
  expect(a).toBe(b)
})

// (c) --at-time 0 shows the pre-transition 200px width
test('--at-time 0 shows the element at its starting 200px width', async () => {
  const width = await withPage(`${srv.url}/animated/index.html`, async (c) => {
    await settleAnimations(c, { atTime: 0 })
    const tree = buildTree(await extract(c))
    return findNode(tree, '#target')!.box.w
  }, { captureAnimations: true })
  expect(width).toBe(200)
})

// (d) the infinite spinner produces the pinned-to-start note under --settled
test('an infinite spinner is pinned to its start and noted, under --settled', async () => {
  const note = await withPage(`${srv.url}/animated/index.html`, async (c) => {
    await settleAnimations(c, { settled: true })
    return animateNote(c)
  }, { captureAnimations: true })
  expect(note).toContain('note: 1 infinite animation pinned to its start (t=0) for determinism')
})

// --at-time must clamp to the FULL active duration (delay + duration * iterations), not one
// iteration — #pulse runs 2 iterations of 1s, so t=1500 is mid-second-iteration (200px), while
// a one-iteration clamp snaps to t=1000 (the second iteration's 100px restart value).
test('--at-time reaches past the first iteration of a multi-iteration animation', async () => {
  const width = await withPage(`${srv.url}/animated/index.html`, async (c) => {
    await settleAnimations(c, { atTime: 1500 })
    const tree = buildTree(await extract(c))
    return findNode(tree, '#pulse')!.box.w
  }, { captureAnimations: true })
  expect(width).toBe(200)
})

test('settled and atTime together are rejected loudly', async () => {
  await expect(withPage(`${srv.url}/animated/index.html`, (c) =>
    settleAnimations(c, { settled: true, atTime: 0 }), { captureAnimations: true }))
    .rejects.toThrow(/mutually exclusive/)
})

test('without --settled/--at-time, the animation domain is never armed (no note, no seek)', async () => {
  const note = await withPage(`${srv.url}/animated/index.html`, async (c) => {
    await settleAnimations(c, {})
    return animateNote(c)
  })
  expect(note).toBe('')
})
