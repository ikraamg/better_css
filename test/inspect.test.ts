import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { inspect } from '../src/core/inspect.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

test('reports box model, non-default styles, and size explanation', async () => {
  const text = await withPage(`${srv.url}/basic/index.html`, (c) => inspect(c, '.content'))
  expect(text).toContain('section.content')
  expect(text).toContain('padding: 32')          // box model side
  expect(text).toContain('✓ height: 400px')      // authored height traced in explain section
  expect(text).not.toContain('cursor:')          // default styles excluded
  expect(text).toContain('width = 1040px')       // explain summary embedded
  expect(text).toContain('stacking context: no') // static element, no stacking context
})

test('reports stacking context reason when present', async () => {
  const text = await withPage(`${srv.url}/overlap/index.html`, (c) => inspect(c, '.modal'))
  expect(text).toMatch(/stacking context: yes \(position \+ z-index\)/)
})

test('absolute position without z-index is not a stacking context', async () => {
  const text = await withPage(`${srv.url}/overlap/index.html`, (c) => inspect(c, '.oops'))
  expect(text).toContain('stacking context: no')
})

// Field #4: /tap/index.html has two bare <a> elements — inspecting the generic
// selector 'a' must say so, instead of silently describing whichever one
// document.querySelector happened to pick first (the exact "check and inspect disagree"
// field bug).
test('multi-match note: selector matching N>1 elements names the count and the others', async () => {
  const text = await withPage(`${srv.url}/tap/index.html`, (c) => inspect(c, 'a'))
  const firstLine = text.split('\n')[0]
  expect(firstLine).toContain('2 matches; showing #1')
  expect(firstLine).toMatch(/others: \d+x\d+ at \(\d+,\d+\)/)
})

test('multi-match note: absent when the selector matches exactly one element', async () => {
  const text = await withPage(`${srv.url}/basic/index.html`, (c) => inspect(c, '.content'))
  expect(text.split('\n')[0]).not.toContain('matches')
})
