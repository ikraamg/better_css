import { afterAll, expect, test } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveFixtures } from './helpers/server.js'

const run = promisify(execFile)
const srv = await serveFixtures('fixtures')
afterAll(() => srv.close())

const cli = (...args: string[]) =>
  run('npx', ['tsx', 'src/cli.ts', ...args], { encoding: 'utf8' })

test('layout prints the tree', async () => {
  const { stdout } = await cli('layout', `${srv.url}/basic/index.html`)
  expect(stdout).toContain('header#top (0,0 1280x64)')
}, 60_000)

test('layout --selector scopes to a subtree', async () => {
  const { stdout } = await cli('layout', `${srv.url}/basic/index.html`, '--selector', 'main')
  expect(stdout.split('\n')[0]).toMatch(/^main \(0,64/)
  expect(stdout).not.toContain('header#top')
}, 60_000)

test('layout --selector with no match exits 2', async () => {
  const err = await cli('layout', `${srv.url}/basic/index.html`, '--selector', '.nope').catch((e) => e)
  expect(err.code).toBe(2)
  expect(err.stderr).toContain("No element matching '.nope'")
}, 60_000)

test('check exits 1 with violations and names a suspect rule', async () => {
  const err = await cli('check', `${srv.url}/overflow-h/index.html`).catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout).toContain('viewport-overflow')
  expect(err.stdout).toContain('div.wide')
  expect(err.stdout).toMatch(/suspect: width: 1400px/)
}, 60_000)

test('check exits 0 on a clean page', async () => {
  const { stdout } = await cli('check', `${srv.url}/basic/index.html`)
  expect(stdout).toContain('no violations')
}, 60_000)

test('explain traces the cascade', async () => {
  const { stdout } = await cli('explain', `${srv.url}/cascade/index.html`, '--selector', '.sidebar', '--property', 'width')
  expect(stdout).toContain('✓ width: 300px')
}, 60_000)

test('layout --viewport WxH emulates the given viewport', async () => {
  const { stdout } = await cli('layout', `${srv.url}/basic/index.html`, '--viewport', '500x800')
  expect(stdout).toContain('body (0,0 500x')
}, 60_000)

test('--viewport with a malformed value exits 2', async () => {
  const err = await cli('layout', `${srv.url}/basic/index.html`, '--viewport', 'nope').catch((e) => e)
  expect(err.code).toBe(2)
  expect(err.stderr).toContain('--viewport must be WxH')
}, 60_000)

test('layout on a deep tree defaults to the 400-line budget with a truncation note', async () => {
  const { stdout } = await cli('layout', `${srv.url}/deep/index.html`)
  const lines = stdout.trimEnd().split('\n')
  expect(lines.length).toBeLessThanOrEqual(400)
  expect(stdout).toContain('truncated to depth')
}, 60_000)

test('layout --depth on a deep tree disables the budget', async () => {
  const { stdout } = await cli('layout', `${srv.url}/deep/index.html`, '--depth', '500')
  const lines = stdout.trimEnd().split('\n')
  expect(lines.length).toBeGreaterThan(400)
  expect(stdout).not.toContain('truncated to depth')
}, 60_000)

test('check --viewports checks each viewport and prefixes violations with [WxH]', async () => {
  const err = await cli('check', `${srv.url}/responsive/index.html`, '--viewports', '1280x800,600x800').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout).toContain('[600x800] viewport-overflow')
  expect(err.stdout).not.toMatch(/\[1280x800\] viewport-overflow/)
  expect(err.stdout).toContain('checked 2 viewports: 1280x800=clean, 600x800=2 violations')
}, 60_000)

test('check on the hover fixture is clean by default; --hover forces the state and surfaces the parent-bleed', async () => {
  const { stdout } = await cli('check', `${srv.url}/hover/index.html`)
  expect(stdout).toContain('no violations')

  const err = await cli('check', `${srv.url}/hover/index.html`, '--hover', '.cta').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout).toContain('parent-bleed')
  expect(err.stdout).toContain('100px')
}, 60_000)

test('check --viewports + --hover forces the state inside each viewport (bleed at 1280 only, per the fixture media query)', async () => {
  const err = await cli('check', `${srv.url}/hover/index.html`, '--viewports', '1280x800,600x800', '--hover', '.cta').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout).toMatch(/\[1280x800\] parent-bleed: a\.cta/)
  expect(err.stdout).toContain('[600x800] no violations')
  expect(err.stdout).not.toMatch(/\[600x800\] parent-bleed/)
  expect(err.stdout).toContain('checked 2 viewports: 1280x800=1 violations, 600x800=clean')
}, 60_000)

test('snapshot --viewports + --hover still rejects (state forcing in the matrix is check-only)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bettercss-test-'))
  const err = await cli('snapshot', `${srv.url}/hover/index.html`, '--viewports', '1280x800,600x800', '--name', 'x', '--dir', dir, '--hover', '.cta').catch((e) => e)
  expect(err.code).toBe(2)
  expect(err.stderr).toContain('--hover')
}, 60_000)

test('layout --hover forces the state, changing width; without it, the natural width shows', async () => {
  const { stdout: hovered } = await cli('layout', `${srv.url}/hover/index.html`, '--hover', '.cta')
  expect(hovered).toContain('a.cta (0,0 400x40)')

  const { stdout: natural } = await cli('layout', `${srv.url}/hover/index.html`)
  expect(natural).toContain('a.cta (0,0 200x40)')
}, 60_000)

test('explain --hover names the :hover rule as the cascade winner', async () => {
  const { stdout } = await cli('explain', `${srv.url}/hover/index.html`, '--hover', '.cta', '--selector', '.cta', '--property', 'width')
  expect(stdout).toContain('✓ width: 400px')
  expect(stdout).toContain('.cta:hover')
  expect(stdout).toMatch(/main\.css:\d+/)
}, 60_000)

test('forced-hover layout is byte-identical across two invocations', async () => {
  const { stdout: first } = await cli('layout', `${srv.url}/hover/index.html`, '--hover', '.cta')
  const { stdout: second } = await cli('layout', `${srv.url}/hover/index.html`, '--hover', '.cta')
  expect(first).toBe(second)
}, 60_000)

test('--hover is rejected for snapshot and diff (out of scope in v1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bettercss-test-'))
  const err = await cli('snapshot', `${srv.url}/hover/index.html`, '--name', 'x', '--dir', dir, '--hover', '.cta').catch((e) => e)
  expect(err.code).toBe(2)
  expect(err.stderr).toContain('--hover')
}, 60_000)

test('snapshot --viewports then diff --viewports round-trips clean, then shows a prefixed diff on change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bettercss-test-'))
  const workDir = mkdtempSync(join(tmpdir(), 'bettercss-fixture-'))
  cpSync('fixtures/responsive', workDir, { recursive: true })

  await cli('snapshot', `${srv.url}/responsive/index.html`, '--viewports', '1280x800,600x800', '--name', 'resp', '--dir', dir)

  const { stdout: cleanDiff } = await cli('diff', `${srv.url}/responsive/index.html`, '--viewports', '1280x800,600x800', '--name', 'resp', '--dir', dir)
  expect(cleanDiff).toContain('[1280x800] (no layout changes)')
  expect(cleanDiff).toContain('[600x800] (no layout changes)')

  // CSS-visible change on the same fixture, served from a temp copy
  writeFileSync(join(workDir, 'index.html'),
    '<!doctype html><html><head><style>* { margin: 0; } .fixed { width: 720px; height: 90px; background: tomato; }</style></head><body><div class="fixed"></div></body></html>')
  const changedSrv = await serveFixtures(workDir)
  try {
    const { stdout: changedDiff } = await cli('diff', `${changedSrv.url}/index.html`, '--viewports', '1280x800,600x800', '--name', 'resp', '--dir', dir)
    expect(changedDiff).toMatch(/\[600x800\] resized/)
  } finally {
    changedSrv.close()
  }
}, 60_000)

test('verify defaults to the standard sweep, verdict first, [WxH] violations, clean viewports named', async () => {
  const err = await cli('verify', `${srv.url}/responsive/index.html`).catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout.split('\n')[0]).toMatch(/^VERDICT: FAIL/)
  expect(err.stdout).toContain('[375x800] viewport-overflow')
  expect(err.stdout).toContain('1280x800=clean')
}, 60_000)

test('bare verify passes the full default sweep on a genuinely responsive page', async () => {
  // a 404 page is trivially clean, which would make this test pass vacuously
  expect(existsSync('fixtures/fluid/index.html')).toBe(true)
  const { stdout } = await cli('verify', `${srv.url}/fluid/index.html`)
  expect(stdout.split('\n')[0]).toBe('VERDICT: PASS')
  expect(stdout).toContain('checked 3 viewports: 375x800=clean, 768x800=clean, 1280x800=clean')
}, 60_000)

test('verify honors --viewport (singular) as a one-entry sweep', async () => {
  const { stdout } = await cli('verify', `${srv.url}/basic/index.html`, '--viewport', '1280x800')
  expect(stdout.split('\n')[0]).toBe('VERDICT: PASS')
  expect(stdout).toContain('checked 1 viewports: 1280x800=clean')
}, 60_000)

test('verify on a clean page passes with verdict-first output', async () => {
  // basic fixture bleeds ~7px at the default sweep's 375px viewport (a CSS-grid min-width:auto
  // quirk unrelated to verify), so pin a viewport it's actually clean at — still exercises the
  // "verify always runs as a matrix, even with one viewport" contract (@WxH-named snapshots).
  const { stdout } = await cli('verify', `${srv.url}/basic/index.html`, '--viewports', '1280x800')
  expect(stdout.split('\n')[0]).toBe('VERDICT: PASS')
}, 60_000)

test('verify --hover --viewports checks each viewport with the state forced, FAIL only where it bleeds', async () => {
  const err = await cli('verify', `${srv.url}/hover/index.html`, '--hover', '.cta', '--viewports', '1280x800,600x800').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout.split('\n')[0]).toMatch(/^VERDICT: FAIL/)
  expect(err.stdout).toMatch(/\[1280x800\] parent-bleed/)
  expect(err.stdout).not.toMatch(/\[600x800\] parent-bleed/)
}, 60_000)

test('verify --name diffs the resting layout against a per-viewport snapshot; missing snapshot is a note, not a failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bettercss-verify-test-'))
  await cli('snapshot', `${srv.url}/responsive/index.html`, '--viewports', '1280x800', '--name', 'v', '--dir', dir)

  const { stdout: clean } = await cli('verify', `${srv.url}/responsive/index.html`, '--viewports', '1280x800', '--name', 'v', '--dir', dir)
  expect(clean.split('\n')[0]).toBe('VERDICT: PASS')
  expect(clean).toContain('(no layout changes)')

  const { stdout: missing } = await cli('verify', `${srv.url}/responsive/index.html`, '--viewports', '1280x800', '--name', 'nope', '--dir', dir)
  expect(missing.split('\n')[0]).toBe('VERDICT: PASS')
  expect(missing).toContain("note: no snapshot 'nope@1280x800' — diff skipped for this viewport")
}, 60_000)
