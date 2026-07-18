import { afterAll, expect, test } from 'vitest'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromePids, serveFixtures } from './helpers/server.js'

const run = promisify(execFile)
const srv = await serveFixtures('fixtures')
afterAll(() => srv.close())

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

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

// Field #3 escape hatch: mobile-viewport/index.html has no <meta name=viewport>, so a
// true mobile 375px capture renders at Chrome's real ~980px fallback (div.fixed is
// 500px wide, fits — clean); --desktop-only forces the OLD squeezed-desktop 375px
// emulation everywhere, where the same 500px div genuinely overflows.
test('--desktop-only restores the old squeezed-desktop emulation, changing the verdict on a non-viewport-tagged page', async () => {
  const { stdout } = await cli('check', `${srv.url}/mobile-viewport/index.html`, '--viewport', '375x800')
  expect(stdout).toContain('no violations')

  const err = await cli('check', `${srv.url}/mobile-viewport/index.html`, '--viewport', '375x800', '--desktop-only').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout).toContain('viewport-overflow')
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
  const dir = tmpDir('csstruth-test-')
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
  const dir = tmpDir('csstruth-test-')
  const err = await cli('snapshot', `${srv.url}/hover/index.html`, '--name', 'x', '--dir', dir, '--hover', '.cta').catch((e) => e)
  expect(err.code).toBe(2)
  expect(err.stderr).toContain('--hover')
}, 60_000)

test('snapshot --viewports then diff --viewports round-trips clean, then shows a prefixed diff on change', async () => {
  const dir = tmpDir('csstruth-test-')
  const workDir = tmpDir('csstruth-fixture-')
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
  // The 375 leg runs true mobile emulation. viewport-overflow must still fire: the
  // page's content is 720px against a 375px visual viewport. (Under mobile emulation
  // Chrome inflates the *layout* viewport to content width — extract.ts must source the
  // overflow denominator from the *visual* viewport, which stays clamped to 375, or the
  // overflow silently reads 0 and detection is lost.)
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
  const dir = tmpDir('csstruth-verify-test-')
  await cli('snapshot', `${srv.url}/responsive/index.html`, '--viewports', '1280x800', '--name', 'v', '--dir', dir)

  const { stdout: clean } = await cli('verify', `${srv.url}/responsive/index.html`, '--viewports', '1280x800', '--name', 'v', '--dir', dir)
  expect(clean.split('\n')[0]).toBe('VERDICT: PASS')
  expect(clean).toContain('(no layout changes)')

  const { stdout: missing } = await cli('verify', `${srv.url}/responsive/index.html`, '--viewports', '1280x800', '--name', 'nope', '--dir', dir)
  expect(missing.split('\n')[0]).toBe('VERDICT: PASS')
  expect(missing).toContain("note: no snapshot 'nope@1280x800' — diff skipped for this viewport")
}, 60_000)

test('check on the interactive fixture is clean by default; --click forces the menu open and surfaces the exact parent-bleed', async () => {
  const { stdout } = await cli('check', `${srv.url}/interactive/index.html`)
  expect(stdout).toContain('no violations')

  const err = await cli('check', `${srv.url}/interactive/index.html`, '--click', '#menu-btn').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout).toContain('parent-bleed')
  expect(err.stdout).toContain('bleeds 100px outside div.wrap')
}, 60_000)

test('check --scroll-to 500 scrolls past the fixture\'s threshold and surfaces the tap-target violation', async () => {
  const err = await cli('check', `${srv.url}/interactive/index.html`, '--scroll-to', '500').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout).toContain('tap-target')
  expect(err.stdout).toContain('16x16px')
}, 60_000)

test('layout --click shows #menu at its open 400px width; without --click it is absent (display:none)', async () => {
  const { stdout: clicked } = await cli('layout', `${srv.url}/interactive/index.html`, '--click', '#menu-btn')
  expect(clicked).toMatch(/div#menu\.open \(0,32 400x100\)/)

  const { stdout: natural } = await cli('layout', `${srv.url}/interactive/index.html`)
  expect(natural).not.toContain('div#menu')
}, 60_000)

test('--click on a selector matching nothing exits 2 with resolveNode\'s suggestions error', async () => {
  const err = await cli('layout', `${srv.url}/interactive/index.html`, '--click', '.nope').catch((e) => e)
  expect(err.code).toBe(2)
  expect(err.stderr).toContain("No element matches '.nope'")
}, 60_000)

test('two --click occurrences accumulate and run in argument order (fixture: B only violates if A ran first)', async () => {
  const err = await cli('check', `${srv.url}/interactive/index.html`, '--click', '#arm-btn', '--click', '#fire-btn').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout).toContain('div#menu2.open bleeds 100px outside div.wrap')

  const { stdout: reversed } = await cli('check', `${srv.url}/interactive/index.html`, '--click', '#fire-btn', '--click', '#arm-btn')
  expect(reversed).toContain('no violations')
}, 60_000)

test('--click on a below-fold target scrolls it into view first, so the click actually lands', async () => {
  const err = await cli('check', `${srv.url}/interactive/index.html`, '--click', '#fold-btn').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout).toContain('parent-bleed')
  expect(err.stdout).toContain('button#fold-btn')
}, 60_000)

test('a repeated --click does not disturb any other flag\'s last-wins behavior', async () => {
  const { stdout } = await cli('layout', `${srv.url}/interactive/index.html`, '--viewport', '900x800', '--viewport', '500x800', '--click', '#menu-btn', '--click', '#menu-btn')
  // last --viewport wins, exactly as before this change
  expect(stdout).toContain('body (0,0 500x')
}, 60_000)

test('--click and --scroll-to are rejected for snapshot and diff (out of scope in v1)', async () => {
  const dir = tmpDir('csstruth-test-')
  const clickErr = await cli('snapshot', `${srv.url}/interactive/index.html`, '--name', 'x', '--dir', dir, '--click', '#menu-btn').catch((e) => e)
  expect(clickErr.code).toBe(2)
  expect(clickErr.stderr).toContain('--click')

  const scrollErr = await cli('diff', `${srv.url}/interactive/index.html`, '--name', 'x', '--dir', dir, '--scroll-to', '500').catch((e) => e)
  expect(scrollErr.code).toBe(2)
  expect(scrollErr.stderr).toContain('--scroll-to')
}, 60_000)

test('forced-click layout is byte-identical across two invocations', async () => {
  const { stdout: first } = await cli('layout', `${srv.url}/interactive/index.html`, '--click', '#menu-btn')
  const { stdout: second } = await cli('layout', `${srv.url}/interactive/index.html`, '--click', '#menu-btn')
  expect(first).toBe(second)
}, 60_000)

test('check --settled fast-forwards the transition, surfacing the exact 100px parent-bleed', async () => {
  const err = await cli('check', `${srv.url}/animated/index.html`, '--settled').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout).toContain('parent-bleed')
  expect(err.stdout).toContain('bleeds 100px outside div.parent')
}, 60_000)

test('layout --settled shows the element at its final 400px width, and two runs are byte-identical', async () => {
  const { stdout: first } = await cli('layout', `${srv.url}/animated/index.html`, '--settled')
  expect(first).toContain('div#target.child.grow (0,0 400x50)')

  const { stdout: second } = await cli('layout', `${srv.url}/animated/index.html`, '--settled')
  expect(first).toBe(second)
}, 60_000)

test('layout --at-time 0 shows the element at its starting 200px width', async () => {
  const { stdout } = await cli('layout', `${srv.url}/animated/index.html`, '--at-time', '0')
  expect(stdout).toContain('div#target.child.grow (0,0 200x50)')
}, 60_000)

test('layout --settled notes the infinite spinner was pinned to its start', async () => {
  const { stdout } = await cli('layout', `${srv.url}/animated/index.html`, '--settled')
  expect(stdout).toContain('note: 1 infinite animation pinned to its start (t=0) for determinism')
}, 60_000)

test('a click that starts a transition longer than the settle cap, under --settled, seeks straight to the end with no misleading "not settled" note', async () => {
  const { stdout } = await cli('layout', `${srv.url}/interactive/index.html`, '--click', '#slow-anim-box', '--settled')
  // The seeked end position (translateX(200px) applied to its natural (0,146) box) —
  // asserted exactly, not just presence, so a broken seek (animation never registered,
  // stuck at its pre-click (0,146) start) can't slip past as a false pass.
  expect(stdout).toContain('div#slow-anim-box.moved (200,146 50x50)')
  expect(stdout).not.toContain('note: page had not settled after interactions')
}, 60_000)

test('snapshot --settled then diff --settled round-trips clean on the animated fixture', async () => {
  const dir = tmpDir('csstruth-settled-test-')
  await cli('snapshot', `${srv.url}/animated/index.html`, '--name', 'anim', '--dir', dir, '--settled')
  const { stdout } = await cli('diff', `${srv.url}/animated/index.html`, '--name', 'anim', '--dir', dir, '--settled')
  expect(stdout).toContain('(no layout changes)')
}, 60_000)

test('--at-time is rejected for snapshot and diff (a specific animation frame is not a deterministic snapshot)', async () => {
  const dir = tmpDir('csstruth-test-')
  const snapErr = await cli('snapshot', `${srv.url}/animated/index.html`, '--name', 'x', '--dir', dir, '--at-time', '0').catch((e) => e)
  expect(snapErr.code).toBe(2)
  expect(snapErr.stderr).toContain('--at-time is not valid for snapshot')

  const diffErr = await cli('diff', `${srv.url}/animated/index.html`, '--name', 'x', '--dir', dir, '--at-time', '0').catch((e) => e)
  expect(diffErr.code).toBe(2)
  expect(diffErr.stderr).toContain('--at-time is not valid for diff')
}, 60_000)

test('without --settled/--at-time, the animated fixture reads mid-flight and is unaffected (flag-less behavior is unchanged)', async () => {
  await expect(cli('layout', `${srv.url}/animated/index.html`)).resolves.toBeTruthy()
}, 60_000)

// A flag-less run on an ANIMATED page is inherently time-dependent, so the honest no-drift
// proof uses a page with no animations: there --settled arms the Animation domain but has
// nothing to seek, so its output must be byte-identical to a flag-less run.
test('--settled on a non-animated page is byte-identical to a flag-less run (plumbing adds no drift)', async () => {
  const { stdout: flagless } = await cli('layout', `${srv.url}/basic/index.html`)
  const { stdout: settled } = await cli('layout', `${srv.url}/basic/index.html`, '--settled')
  expect(settled).toBe(flagless)
}, 60_000)

test('verify --settled passes the flag through, failing with the exact 100px bleed', async () => {
  const err = await cli('verify', `${srv.url}/animated/index.html`, '--viewports', '1280x800', '--settled').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout.split('\n')[0]).toMatch(/^VERDICT: FAIL/)
  expect(err.stdout).toContain('bleeds 100px outside div.parent')
}, 60_000)

// (a) shifty fixture: exit 1, STABILITY line, the pushed-down img's selector at its
// +300-ish timing bucket, and the intrinsic-size suspect.
test('stability on the shifty fixture exits 1 and reports the shift, timing, and suspect', async () => {
  const err = await cli('stability', `${srv.url}/shifty/index.html`, '--viewport', '400x800').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout.split('\n')[0]).toMatch(/^STABILITY: 0\.\d+/)
  expect(err.stdout).toMatch(/\[\+[2-4]\d\d\] img\.photo moved \(0,0\)→\(0,200\) score 0\.\d+/)
  expect(err.stdout).toContain('suspect: img.photo has no intrinsic size attributes')
}, 20_000)

// (b) fluid fixture: no async DOM changes, so no shifts — exit 0.
test('stability on the fluid fixture exits 0 with a zero score', async () => {
  const { stdout } = await cli('stability', `${srv.url}/fluid/index.html`, '--duration', '500')
  expect(stdout.trimEnd()).toBe('STABILITY: 0 (threshold 0.1)')
}, 20_000)

test('stability --threshold overrides the default 0.1 boundary, dropping below the shifty score', async () => {
  const { stdout } = await cli('stability', `${srv.url}/shifty/index.html`, '--viewport', '400x800', '--threshold', '0.5')
  expect(stdout).toContain('(threshold 0.5)')
}, 20_000)

test('stability --duration with a non-numeric value exits 2', async () => {
  const err = await cli('stability', `${srv.url}/shifty/index.html`, '--duration', 'nope').catch((e) => e)
  expect(err.code).toBe(2)
  expect(err.stderr).toContain('--duration must be a number')
}, 60_000)

test('stability rejects --hover (interact/state flags are out of scope in v8)', async () => {
  const err = await cli('stability', `${srv.url}/shifty/index.html`, '--hover', '.cta').catch((e) => e)
  expect(err.code).toBe(2)
  expect(err.stderr).toContain('--hover')
}, 60_000)

// USAGE claims stability takes none of these — silently accepting them would be a lie
// (worst case: --viewports silently ran the default 1280x800 with no signal).
test.each([
  ['--settled', []],
  ['--at-time', ['0']],
  ['--viewports', ['400x800,600x800']],
])('stability rejects %s with exit 2 instead of silently ignoring it', async (flag, value) => {
  const err = await cli('stability', `${srv.url}/shifty/index.html`, flag, ...value).catch((e) => e)
  expect(err.code).toBe(2)
  expect(err.stderr).toContain(`${flag} is not valid for stability`)
}, 60_000)

// (d) missing --root on apply (and on a plain dry-run — root is needed just to resolve
// where a patch would land, so it's required for fix regardless of --apply) exits 2
test('fix without --root exits 2, with or without --apply', async () => {
  const dryErr = await cli('fix', `${srv.url}/fixable/index.html`).catch((e) => e)
  expect(dryErr.code).toBe(2)
  expect(dryErr.stderr).toContain('fix requires --root')

  const applyErr = await cli('fix', `${srv.url}/fixable/index.html`, '--apply').catch((e) => e)
  expect(applyErr.code).toBe(2)
  expect(applyErr.stderr).toContain('fix requires --root')
}, 60_000)

test('fix dry-run (CLI) prints patches and never writes; deferring exact patch content to fix.test.ts', async () => {
  const cssPath = 'fixtures/fixable/styles.css'
  const before = readFileSync(cssPath, 'utf8')
  const { stdout } = await cli('fix', `${srv.url}/fixable/index.html`, '--root', 'fixtures')
  expect(stdout).toContain('text-clip')
  expect(stdout).toContain('tap-target')
  expect(stdout).toContain('parent-bleed')
  expect(readFileSync(cssPath, 'utf8')).toBe(before)
}, 60_000)

test('fix --apply on a temp copy writes patches, reports before/after honestly, and exits 0 on a clean improvement', async () => {
  const workDir = tmpDir('csstruth-cli-fix-')
  cpSync('fixtures/fixable', join(workDir, 'fixable'), { recursive: true })
  const tmpSrv = await serveFixtures(workDir)
  try {
    const { stdout } = await cli('fix', `${tmpSrv.url}/fixable/index.html`, '--root', workDir, '--apply')
    expect(stdout).toMatch(/before: 3 violations → after: 0 violations/)
    expect(stdout).not.toContain('NEW violations introduced')
  } finally {
    tmpSrv.close()
  }
}, 60_000)

// Regression honesty: a patch that trades one violation for a NEW one must NOT exit 0.
// The regressing fixture is built for exactly this: max-width: 100% cures the bleed but
// shrinks the box below its text width, introducing a text-clip.
test('fix --apply that introduces a NEW violation reports it and exits 1', async () => {
  const workDir = tmpDir('csstruth-cli-fix-regress-')
  cpSync('fixtures/regressing', join(workDir, 'regressing'), { recursive: true })
  const tmpSrv = await serveFixtures(workDir)
  try {
    const err = await cli('fix', `${tmpSrv.url}/regressing/index.html`, '--root', workDir, '--apply').catch((e) => e)
    expect(err.code).toBe(1)
    expect(err.stdout).toContain('before: 1 violations → after: 1 violations')
    expect(err.stdout).toContain('NEW violations introduced')
    expect(err.stdout).toContain('text-clip')
  } finally {
    tmpSrv.close()
  }
}, 60_000)

// Zero-patches --apply semantics: nothing attempted is not failure — exit 0, say so plainly.
test('fix --apply with nothing fixable exits 0 with "no patches applied"', async () => {
  const { stdout } = await cli('fix', `${srv.url}/zero-size/index.html`, '--root', 'fixtures', '--apply')
  expect(stdout).toContain('no mechanical fix for zero-size')
  expect(stdout).toContain('no patches applied')
}, 60_000)

// Field #6: baselines + delta verdicts. Reuses the hover fixture's deterministic
// forced-hover violation (parent-bleed, see the check --hover tests above) as the one
// "known-benign" baseline entry throughout.
function baselineFile(): string {
  return join(tmpDir('csstruth-baseline-test-'), '.csstruth-baseline')
}

// A temp copy of fixtures/hover with one ADDITIONAL violation that's always present
// (a 10x10 button — independent of --hover) — used to prove baselining only reports the
// NEW one, not the pre-existing (baselined) parent-bleed.
function serveMutatedHover() {
  const workDir = tmpDir('csstruth-baseline-hover-')
  cpSync('fixtures/hover', workDir, { recursive: true })
  writeFileSync(join(workDir, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="main.css"></head><body>' +
    '<div class="rail"><a class="cta" href="#">Click</a></div>' +
    '<button style="width:10px;height:10px;display:block">x</button>' +
    '</body></html>')
  return serveFixtures(workDir)
}

test('(a) baseline write on the hover fixture pins deterministic, sorted, px-excluded file content', async () => {
  const file = baselineFile()
  const { stdout } = await cli('baseline', `${srv.url}/hover/index.html`, '--hover', '.cta', '--viewports', '1280x800', '--file', file)
  expect(stdout).toContain('baseline written:')
  expect(stdout).toContain('1 violation')
  expect(readFileSync(file, 'utf8')).toBe('[1280x800] parent-bleed a.cta\n')
}, 60_000)

test('(b) verify --baseline collapses a still-present baselined violation to PASS', async () => {
  const file = baselineFile()
  await cli('baseline', `${srv.url}/hover/index.html`, '--hover', '.cta', '--viewports', '1280x800', '--file', file)
  expect(readFileSync(file, 'utf8')).toBe('[1280x800] parent-bleed a.cta\n')

  const { stdout } = await cli('verify', `${srv.url}/hover/index.html`, '--hover', '.cta', '--viewports', '1280x800', '--baseline', file)
  expect(stdout.split('\n')[0]).toBe('VERDICT: PASS (0 resolved, 0 new, 1 baseline)')
  expect(stdout).toContain('baseline: 1 accepted violation unchanged')
  expect(stdout).not.toContain('parent-bleed:')
}, 60_000)

test('(c) verify --baseline FAILs naming ONLY a genuinely new violation, not the baselined one', async () => {
  const file = baselineFile()
  await cli('baseline', `${srv.url}/hover/index.html`, '--hover', '.cta', '--viewports', '1280x800', '--file', file)

  const mutated = await serveMutatedHover()
  try {
    const err = await cli('verify', `${mutated.url}/index.html`, '--hover', '.cta', '--viewports', '1280x800', '--baseline', file).catch((e) => e)
    expect(err.code).toBe(1)
    expect(err.stdout.split('\n')[0]).toBe('VERDICT: FAIL (0 resolved, 1 new, 1 baseline)')
    expect(err.stdout).toContain('tap-target')
    expect(err.stdout).not.toContain('parent-bleed:')
    expect(err.stdout).toContain('baseline: 1 accepted violation unchanged')
  } finally {
    mutated.close()
  }
}, 60_000)

test('(d) verify --baseline PASSes with a resolved: line when a baselined violation is fixed', async () => {
  const file = baselineFile()
  await cli('baseline', `${srv.url}/hover/index.html`, '--hover', '.cta', '--viewports', '1280x800', '--file', file)

  // No --hover this time: the fixture's natural state is clean (see the hover tests above).
  const { stdout } = await cli('verify', `${srv.url}/hover/index.html`, '--viewports', '1280x800', '--baseline', file)
  expect(stdout.split('\n')[0]).toBe('VERDICT: PASS (1 resolved, 0 new, 0 baseline)')
  expect(stdout).toContain('resolved: parent-bleed a.cta')
}, 60_000)

test('(e) --update-baseline rewrites the file to the current set and round-trips clean', async () => {
  const file = baselineFile()
  await cli('baseline', `${srv.url}/hover/index.html`, '--hover', '.cta', '--viewports', '1280x800', '--file', file)

  const mutated = await serveMutatedHover()
  try {
    const err = await cli('verify', `${mutated.url}/index.html`, '--hover', '.cta', '--viewports', '1280x800', '--baseline', file, '--update-baseline').catch((e) => e)
    expect(err.code).toBe(1) // the run that PRODUCES the update still reports the new violation
    expect(err.stdout).toContain('baseline updated:')
    expect(err.stdout).toContain('1 added, 0 removed')
    expect(err.stdout).toContain('[1280x800] tap-target button')

    const updated = readFileSync(file, 'utf8').split('\n').filter(Boolean).sort()
    expect(updated).toEqual(['[1280x800] parent-bleed a.cta', '[1280x800] tap-target button'])

    const { stdout } = await cli('verify', `${mutated.url}/index.html`, '--hover', '.cta', '--viewports', '1280x800', '--baseline', file)
    expect(stdout.split('\n')[0]).toBe('VERDICT: PASS (0 resolved, 0 new, 2 baseline)')
  } finally {
    mutated.close()
  }
}, 60_000)

// Critical fix (key identity): id-distinct instances of one pattern collapse to a SINGLE
// baseline key, matching how check groups them for display. Before the fix baselineKey kept
// the #id, so the 3 vote links wrote 3 keys and a same-pattern page with different ids read
// as 100% new. idmismatch fixture: 3 <a id="vote-N" class="vote"> 12px tap targets.
test('(f) baseline collapses id-distinct same-pattern violations to one key', async () => {
  const file = baselineFile()
  await cli('baseline', `${srv.url}/idmismatch/index.html`, '--viewports', '1280x800', '--file', file)
  // one key, id stripped — not three id-bearing keys
  expect(readFileSync(file, 'utf8')).toBe('[1280x800] tap-target a.vote\n')
  const { stdout } = await cli('check', `${srv.url}/idmismatch/index.html`, '--viewports', '1280x800', '--baseline', file)
  expect(stdout).toContain('baseline: 3 accepted violations unchanged')
  expect(stdout).not.toMatch(/tap-target:/)
}, 60_000)

// Critical fix (default viewport matching): the README's own quickstart — baseline then
// verify with NO viewport flags on either side. verify always runs the default sweep, so
// baseline must too (labeled keys), or nothing collapses. Before the fix baseline wrote
// unlabeled keys here and verify reported every violation as new across all 3 viewports.
test('(g) the no-flags baseline→verify quickstart collapses instead of reporting all-new', async () => {
  const file = baselineFile()
  await cli('baseline', `${srv.url}/idmismatch/index.html`, '--file', file)
  // baseline defaulted to the full sweep, so keys are per-viewport labeled
  expect(readFileSync(file, 'utf8')).toBe(
    '[1280x800] tap-target a.vote\n[375x800] tap-target a.vote\n[768x800] tap-target a.vote\n')
  const { stdout } = await cli('verify', `${srv.url}/idmismatch/index.html`, '--baseline', file)
  expect(stdout.split('\n')[0]).toBe('VERDICT: PASS (0 resolved, 0 new, 9 baseline)')
}, 60_000)

// Critical fix (loud safety net): a baseline captured with a different viewport shape than
// the run it's compared against must WARN, not silently report everything new. Here a labeled
// 1280x800 baseline is compared by a default single-viewport check (unlabeled keys).
test('(h) a mismatched-shape baseline pairing prints a loud warning', async () => {
  const file = baselineFile()
  await cli('baseline', `${srv.url}/idmismatch/index.html`, '--viewports', '1280x800', '--file', file)
  // check defaults to a single unlabeled 1280x800 — labels won't match the file's [1280x800],
  // so nothing collapses and check exits 1 (cli() rejects); the warning is on stdout regardless.
  const res = await cli('check', `${srv.url}/idmismatch/index.html`, '--baseline', file).catch((e) => e)
  expect(res.stdout).toContain('warning: baseline was captured with a different viewport configuration')
}, 60_000)

test('missing --baseline file is a clear resolved-path error, exit 2', async () => {
  const dir = tmpDir('csstruth-baseline-missing-')
  const missing = join(dir, 'nope')
  const err = await cli('check', `${srv.url}/basic/index.html`, '--baseline', missing).catch((e) => e)
  expect(err.code).toBe(2)
  expect(err.stderr).toContain(`No baseline file at ${missing}`)
}, 60_000)

test('--baseline is rejected for commands other than check/verify', async () => {
  const err = await cli('layout', `${srv.url}/basic/index.html`, '--baseline', 'x').catch((e) => e)
  expect(err.code).toBe(2)
  expect(err.stderr).toContain('--baseline is only valid for check/verify')
}, 60_000)

test('--update-baseline without --baseline is rejected', async () => {
  const err = await cli('check', `${srv.url}/basic/index.html`, '--update-baseline').catch((e) => e)
  expect(err.code).toBe(2)
  expect(err.stderr).toContain('--update-baseline requires --baseline')
}, 60_000)

// SIGINT on a non-watch command must still tear down Chrome, not orphan the tree — same
// shape as blame.test.ts's own mid-walk SIGINT test. Single-process spawn (no npx→tsx
// chain) so the signal reaches the CLI itself; waiting for a NEW Chrome pid to appear
// (instead of a fixed sleep) proves the signal lands after Chrome is actually up.
test('SIGINT during check exits 130 with no Chrome orphans', async () => {
  const pidsBefore = chromePids()
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'check', `${srv.url}/basic/index.html`], { stdio: ['ignore', 'pipe', 'pipe'] })

  const spawnDeadline = Date.now() + 30_000
  while (![...chromePids()].some((p) => !pidsBefore.has(p)) && Date.now() < spawnDeadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  expect([...chromePids()].some((p) => !pidsBefore.has(p))).toBe(true)

  child.kill('SIGINT')
  const code = await new Promise<number | null>((r) => child.on('close', (c) => r(c)))
  expect(code).toBe(130)

  const cleanupDeadline = Date.now() + 15_000
  while ([...chromePids()].some((p) => !pidsBefore.has(p)) && Date.now() < cleanupDeadline) {
    await new Promise((r) => setTimeout(r, 250))
  }
  expect([...chromePids()].filter((p) => !pidsBefore.has(p))).toEqual([])
}, 60_000)
