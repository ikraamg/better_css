import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { explain, renderExplanation } from '../src/core/explain.js'

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
  // declared 300px but computed 240px → layout constraint note
  expect(e.layoutNote).toContain('grid')
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

test('unknown selector throws with suggestions', async () => {
  await expect(withPage(`${srv.url}/cascade/index.html`, (c) => explain(c, '.sidbar', 'width')))
    .rejects.toThrow(/No element matches '\.sidbar'/)
})
