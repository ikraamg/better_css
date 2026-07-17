import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { abandonedProfilePids, shutdownChrome, stragglerPids, withPage } from '../src/core/connect.js'

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
  const dirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith('csstruth-')).length
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

// Seam for doShutdown's renderer-straggler sweep (the zygote race that motivates it —
// Linux sandbox renderers living OUTSIDE Chrome's process group, so the group-SIGKILL
// misses them — only reproduces on multi-core Linux CI; CI is the arbiter for the race).
// This pins the targeting: only OUR profile dir's processes, exact-delimited.
test('stragglerPids targets only processes referencing our exact profile dir', () => {
  const ps = [
    '  123 /opt/chrome/chrome --headless=new --user-data-dir=/tmp/csstruth-AAA',
    '  456 /opt/chrome/chrome --type=renderer --user-data-dir=/tmp/csstruth-AAA --seatbelt=7',
    '  789 /opt/chrome/chrome --headless=new --user-data-dir=/tmp/csstruth-AAAB', // different dir, shared prefix
    '  321 /opt/chrome/chrome --user-data-dir=/tmp/other-profile',
    'garbage line with no pid --user-data-dir=/tmp/csstruth-AAA', // NaN pid dropped
    '',
  ].join('\n')
  expect(stragglerPids(ps, '/tmp/csstruth-AAA')).toEqual([123, 456])
  expect(stragglerPids(ps, '/tmp/csstruth-AAAB')).toEqual([789])
  expect(stragglerPids('', '/tmp/csstruth-AAA')).toEqual([])
})

// Seam for the cross-invocation startup sweep: only processes carrying OUR naming
// prefix whose profile dir is GONE from disk are abandoned. A dir still on disk could
// be a live concurrent csstruth — never touched.
test('abandonedProfilePids targets only csstruth profiles whose dir no longer exists', () => {
  const ps = [
    '  111 /opt/chrome/chrome --headless=new --user-data-dir=/tmp/csstruth-GONE1',
    '  222 /opt/chrome/chrome --type=renderer --user-data-dir=/tmp/csstruth-LIVE --x=1',
    '  333 /opt/chrome/chrome --type=renderer --user-data-dir=/tmp/csstruth-GONE2 --x=2',
    '  444 /opt/chrome/chrome --user-data-dir=/tmp/other-tool-profile', // not our prefix
    '  555 /opt/chrome/chrome --no-user-data-dir-at-all',
    'junk --user-data-dir=/tmp/csstruth-GONE1', // NaN pid dropped
  ].join('\n')
  const exists = (dir: string) => dir === '/tmp/csstruth-LIVE'
  expect(abandonedProfilePids(ps, '/tmp/csstruth-', exists)).toEqual([111, 333])
  expect(abandonedProfilePids(ps, '/tmp/csstruth-', () => true)).toEqual([]) // all dirs live -> touch nothing
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
