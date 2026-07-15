import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { explain, renderExplanation } from '../src/core/explain.js'
import { extract } from '../src/core/extract.js'
import { buildTree, walk } from '../src/core/tree.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

test('traces winner with file:line, losers with reasons', async () => {
  const e = await withPage(`${srv.url}/cascade/index.html`, (c) => explain(c, '.sidebar', 'width'))
  expect(e.computed).toBe('240px')
  const winner = e.entries.find((x) => x.status === 'winner')!
  expect(winner.value).toBe('300px')
  expect(winner.file).toContain('sidebar.css')
  expect(winner.line).toBe(1)
  const loser = e.entries.find((x) => x.status === 'overridden')!
  expect(loser.value).toBe('100%')
  expect(loser.file).toContain('reset.css')
  expect(loser.reason).toContain('specificity')
  // declared 300px but computed 240px → the real constraint is .grid > div's
  // own max-width: 240px (case b), not grid track sizing itself
  expect(e.layoutNote).toContain('max-width: 240px')
  expect(e.layoutNote).toMatch(/main\.css:\d+/)
})

test('renderExplanation produces the ✓/✗ block', async () => {
  const e = await withPage(`${srv.url}/cascade/index.html`, (c) => explain(c, '.sidebar', 'width'))
  const text = renderExplanation(e)
  expect(text).toContain('.sidebar width = 240px')
  expect(text).toMatch(/✓ width: 300px\s+.*sidebar\.css:1/)
  expect(text).toMatch(/✗ width: 100%\s+.*reset\.css:1/)
})

test('shorthand-derived longhand traces to the shorthand declaration', async () => {
  const e = await withPage(`${srv.url}/cascade/index.html`, (c) => explain(c, '.sidebar', 'margin-top'))
  const winner = e.entries.find((x) => x.status === 'winner')!
  expect(winner.value).toBe('4px')
  expect(winner.file).toContain('sidebar.css')
  expect(winner.line).toBe(2)
  expect(winner.via).toContain('margin:')
  expect(renderExplanation(e)).toContain('margin-top: 4px (via margin: 4px 8px)')
})

test('last duplicate declaration within a rule wins', async () => {
  const e = await withPage(`${srv.url}/cascade/index.html`, (c) => explain(c, '.other', 'width'))
  const winner = e.entries.find((x) => x.status === 'winner')!
  expect(winner.value).toBe('222px')
  expect(e.layoutNote).toBeNull() // computed matches the real winner
})

test('via cites the last shorthand declared in the rule', async () => {
  const e = await withPage(`${srv.url}/cascade/index.html`, (c) => explain(c, '.sidebar', 'border-top-color'))
  const winner = e.entries.find((x) => x.status === 'winner')!
  expect(winner.via).toContain('border-color')
})

test('second explain on the same client still resolves file:line', async () => {
  const second = await withPage(`${srv.url}/cascade/index.html`, async (c) => {
    await explain(c, '.sidebar', 'width')
    return explain(c, '.sidebar', 'width')
  })
  const winner = second.entries.find((x) => x.status === 'winner')!
  expect(winner.file).toContain('sidebar.css')
  expect(winner.line).toBe(1)
})

test('color properties never get a layout-constraints note (serialization mismatch, not layout)', async () => {
  // declared 'blue' (via border-color) vs computed 'rgb(0, 0, 255)' — same color,
  // different serialization. Not a layout constraint.
  const e = await withPage(`${srv.url}/cascade/index.html`, (c) => explain(c, '.sidebar', 'border-top-color'))
  expect(e.declaredWinner).toBe('blue')
  expect(e.computed).toBe('rgb(0, 0, 255)')
  expect(e.layoutNote).toBeNull()
})

test('layoutNote names the flex-basis constraint from a flex shorthand', async () => {
  const e = await withPage(`${srv.url}/cascade/index.html`, (c) => explain(c, '.flexchild', 'width'))
  expect(e.declaredWinner).toBe('300px')
  expect(e.computed).toBe('200px')
  expect(e.layoutNote).toContain('flex-basis: 200px')
  expect(e.layoutNote).toContain('via flex: 0 0 200px')
  expect(e.layoutNote).toMatch(/main\.css:\d+/)
})

test('flex-grow sizing is never attributed to flex-basis', async () => {
  // flex: 1 1 200px in a 1000px row — grow, not the 200px basis, sets the size
  const e = await withPage(`${srv.url}/cascade/index.html`, (c) => explain(c, '.growchild', 'width'))
  expect(e.declaredWinner).toBe('300px')
  expect(e.computed).toBe('1000px')
  expect(e.layoutNote).not.toContain('flex-basis')
})

test('competing max-width rules — the note names the cascade winner', async () => {
  // .clamped { max-width: 300px } loses to the later .clamped { max-width: 240px }
  const e = await withPage(`${srv.url}/cascade/index.html`, (c) => explain(c, '.clamped', 'width'))
  expect(e.declaredWinner).toBe('400px')
  expect(e.computed).toBe('240px')
  expect(e.layoutNote).toContain('max-width: 240px')
  expect(e.layoutNote).toContain('main.css:10')
})

test('column-flex parent: width is not governed by flex-basis — the max-width clamp is named', async () => {
  // flex-basis sizes the MAIN axis; in a column container that's height, so the
  // 200px basis is irrelevant to width — max-width: 200px is the true constraint
  const e = await withPage(`${srv.url}/cascade/index.html`, (c) => explain(c, '.colchild', 'width'))
  expect(e.declaredWinner).toBe('300px')
  expect(e.computed).toBe('200px')
  expect(e.layoutNote).not.toContain('flex-basis')
  expect(e.layoutNote).toContain('max-width: 200px')
  expect(e.layoutNote).toContain('main.css:12')
})

test('unknown selector throws with suggestions', async () => {
  await expect(withPage(`${srv.url}/cascade/index.html`, (c) => explain(c, '.sidbar', 'width')))
    .rejects.toThrow(/No element matches '\.sidbar'/)
})

test('explain resolves a node by backendNodeId, bypassing selector escaping entirely', async () => {
  const winner = await withPage(`${srv.url}/tailwindish/index.html`, async (c) => {
    const tree = buildTree(await extract(c))
    let target: any
    walk(tree.root, (n) => { if (n.classes.some((cl) => cl.startsWith('w-[')) && !target) target = n })
    const e = await explain(c, { backendNodeId: target.backendNodeId }, 'width')
    return e.entries.find((x) => x.status === 'winner')
  })
  expect(winner?.value).toBe('300px')
  expect(winner?.file).toContain('tailwindish')
})

test('a stale backendNodeId throws a clear error', async () => {
  await expect(withPage(`${srv.url}/tailwindish/index.html`, (c) => explain(c, { backendNodeId: 999999999 }, 'width')))
    .rejects.toThrow(/backendNodeId/)
})
