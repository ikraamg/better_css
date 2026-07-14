import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

test('opens page and evaluates against it', async () => {
  const title = await withPage(`${srv.url}/basic/index.html`, async (client) => {
    const { result } = await client.Runtime.evaluate({ expression: 'document.querySelector("h1").textContent' })
    return result.value
  })
  expect(title).toBe('Hello')
})

test('viewport defaults to 1280x800', async () => {
  const w = await withPage(`${srv.url}/basic/index.html`, async (client) => {
    const { result } = await client.Runtime.evaluate({ expression: 'window.innerWidth' })
    return result.value
  })
  expect(w).toBe(1280)
})

test('unreachable Chrome on explicit bad port gives actionable error', async () => {
  await expect(withPage(`${srv.url}/basic/index.html`, async () => {}, { port: 59999 }))
    .rejects.toThrow(/remote-debugging-port/)
})
