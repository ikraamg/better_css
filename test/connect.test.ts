import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

test('concurrent withPage calls launch at most one Chrome', async () => {
  await shutdownChrome() // fresh state so both calls race the launch path
  const dirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith('bettercss-')).length
  const before = dirs()
  const [a, b] = await Promise.all([
    withPage(`${srv.url}/basic/index.html`, async (c) =>
      (await c.Runtime.evaluate({ expression: '1+1' })).result.value),
    withPage(`${srv.url}/basic/index.html`, async (c) =>
      (await c.Runtime.evaluate({ expression: '2+2' })).result.value),
  ])
  expect(a).toBe(2)
  expect(b).toBe(4)
  // One temp user-data dir per launch; 0 if an external Chrome on 9222 was attached.
  expect(dirs() - before).toBeLessThanOrEqual(1)
})

test('unreachable Chrome on explicit bad port gives actionable error', async () => {
  await expect(withPage(`${srv.url}/basic/index.html`, async () => {}, { port: 59999 }))
    .rejects.toThrow(/remote-debugging-port/)
})

test('navigating to a dead server rejects instead of reporting the neterror page', async () => {
  // nothing listens on port 1 (a reserved, always-refused TCP port)
  await expect(withPage('http://127.0.0.1:1/', async () => {}))
    .rejects.toThrow(/Failed to load/)
})

// MUST BE LAST in this file: the terminal latch is process-permanent by design (a
// terminal shutdown means the process is exiting) and vitest isolates test files into
// their own workers, so poisoning the rest of THIS file is the only blast radius.
//
// The bug this pins (observed on 2-core Linux CI, never reproducible on macOS): a signal
// handler's `await shutdownChrome()` kills Chrome A and sets launched=null; an in-flight
// walk/loop step's next withPage → resolvePort then LAUNCHES Chrome B, which the
// handler's process.exit() abandons — a real orphan surviving the leak poll. The latch
// makes any launch attempt after a terminal shutdown reject instead.
test('after a terminal shutdown, withPage refuses to launch a new Chrome', async () => {
  // ensure a Chrome exists so the shutdown actually kills one (mirrors the CI sequence)
  await withPage(`${srv.url}/basic/index.html`, async () => {})
  await shutdownChrome({ terminal: true })
  await expect(withPage(`${srv.url}/basic/index.html`, async () => {}))
    .rejects.toThrow('shutting down')
})
