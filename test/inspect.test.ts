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
