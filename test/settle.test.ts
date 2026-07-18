import { afterAll, expect, test } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { serveFixtures } from './helpers/server.js'

const run = promisify(execFile)
const srv = await serveFixtures('fixtures')
afterAll(() => srv.close())

const cli = (...args: string[]) => run('npx', ['tsx', 'src/cli.ts', ...args], { encoding: 'utf8' })

// (a) RED, structured around the new clean behavior: WITHOUT the settle gate, a capture
// taken right after navigate() lands mid-render (unshrunk flex bleeding, empty stacked
// panels overlapping). WITH it, check waits out the ~1.2s staged JS and reads the
// settled, correct layout.
test('check on the async-render fixture is clean once JS finishes staging the layout', async () => {
  const { stdout } = await cli('check', `${srv.url}/async-render/index.html`)
  expect(stdout.trim()).toBe('no violations')
}, 60_000)

// (d) determinism: two independent runs land on the identical settled state.
test('check on the async-render fixture is byte-identical across two runs', async () => {
  const { stdout: first } = await cli('check', `${srv.url}/async-render/index.html`)
  const { stdout: second } = await cli('check', `${srv.url}/async-render/index.html`)
  expect(first).toBe(second)
}, 60_000)

// (b) never-settling, otherwise-clean page: the settle cap is hit every capture (perpetual
// per-frame mutation), the persistence filter converges on an empty set (the mover itself
// is not a bug) — PASS, not a phantom FAIL, but honestly worded as never having settled.
test('verify on a never-settling but otherwise clean page reports PASS (never fully settled)', async () => {
  const { stdout } = await cli('verify', `${srv.url}/async-render/never-settles.html`, '--viewport', '1280x800')
  expect(stdout.split('\n')[0]).toBe('VERDICT: PASS (page never fully settled)')
}, 60_000)

// (b) never-settling WITH a real, permanent bug: it must survive the persistence filter
// (present in both captures) and drive an honest INCONCLUSIVE verdict — never a
// confident FAIL on what might be mid-render noise — while still exiting 1 (CI shouldn't
// pass silently).
test('verify on a never-settling page with a real bug reports INCONCLUSIVE with the persistent violation, exit 1', async () => {
  const err = await cli('verify', `${srv.url}/async-render/never-settles-with-bug.html`, '--viewport', '1280x800').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout.split('\n')[0]).toBe('VERDICT: INCONCLUSIVE (page never settled; 1 persistent violations)')
  expect(err.stdout).toContain('note: page never settled — reporting only violations stable across two captures')
  expect(err.stdout).toContain('tap-target')
}, 60_000)

// contract 2b: `check` (not just verify) also applies the persistence filter and notes it.
test('check on the never-settling page notes the persistence filter and stays clean', async () => {
  const { stdout } = await cli('check', `${srv.url}/async-render/never-settles.html`)
  expect(stdout).toContain('no violations')
  expect(stdout).toContain('note: page never settled — reporting only violations stable across two captures')
}, 60_000)
