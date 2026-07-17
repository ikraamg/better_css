import { afterAll, expect, test } from 'vitest'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shutdownChrome, withPage } from '../src/core/connect.js'
import { runLoop } from '../src/core/watch.js'
import { chromePids, serveFixtures } from './helpers/server.js'

const run = promisify(execFile)
const cli = (...args: string[]) => run('npx', ['tsx', 'src/cli.ts', ...args], { encoding: 'utf8' })

afterAll(async () => { await shutdownChrome() })

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

// Safety net: if a test throws mid-assertion (before its own try/finally kill runs, or
// because it forgot one), nothing here should leak a subprocess or a listening server
// past the suite — every child/server created below is registered here too.
const liveChildren: ChildProcess[] = []
afterAll(() => { for (const c of liveChildren) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL') })
const liveServers: Array<{ close(): void }> = []
afterAll(() => { for (const s of liveServers) { try { s.close() } catch {} } })

async function serve(dir: string): Promise<Awaited<ReturnType<typeof serveFixtures>>> {
  const srv = await serveFixtures(dir)
  liveServers.push(srv)
  return srv
}

function tempFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'csstruth-watch-'))
  dirs.push(dir)
  return dir
}

// Minimal CSS-only live-reload: polls the stylesheet and hot-swaps the <link> href
// (no navigation) whenever its content changes on disk — stands in for a real dev
// server's HMR CSS injection so watch's signature-poll path has something to observe,
// without needing to wire up an actual HMR toolchain for these tests.
const HTML = `<!doctype html><html><head><link rel="stylesheet" href="styles.css">
<script>
(function poll(prev) {
  fetch('styles.css', { cache: 'no-store' }).then(function (r) { return r.text() }).then(function (css) {
    if (prev !== null && css !== prev) {
      document.querySelector('link[rel=stylesheet]').href = 'styles.css?t=' + Date.now()
    }
    setTimeout(function () { poll(css) }, 100)
  }).catch(function () { setTimeout(function () { poll(prev) }, 100) })
})(null)
</script>
</head><body><div class="wrap"><div class="box">hi</div></div></body></html>`

const CSS_START = '* { margin: 0; padding: 0; } .wrap { width: 300px; height: 100px; } .box { width: 100px; height: 50px; margin-left: 0px; }'
const CSS_MOVED = '* { margin: 0; padding: 0; } .wrap { width: 300px; height: 100px; } .box { width: 100px; height: 50px; margin-left: 60px; }'
const CSS_BLEED = '* { margin: 0; padding: 0; } .wrap { width: 300px; height: 100px; } .box { width: 400px; height: 50px; margin-left: 0px; }'

function writeFixture(dir: string, css: string): void {
  writeFileSync(join(dir, 'index.html'), HTML)
  writeFileSync(join(dir, 'styles.css'), css)
}

async function waitFor(buf: () => string, substr: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!buf().includes(substr)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(substr)} — got:\n${buf()}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

// Single-process spawn (no npx→tsx chain) so SIGINT/SIGTERM reach the CLI itself —
// same reasoning as blame.test.ts's interrupt tests.
function startWatch(url: string): { child: ChildProcess; buf: () => string } {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'watch', url, '--interval', '100'], { stdio: ['ignore', 'pipe', 'pipe'] })
  liveChildren.push(child)
  let out = ''
  child.stdout.on('data', (d) => { out += d.toString() })
  child.stderr.on('data', (d) => { out += d.toString() })
  return { child, buf: () => out }
}

function waitClose(child: ChildProcess): Promise<number | null> {
  return new Promise((r) => child.on('close', (c) => r(c)))
}

// (a) a layout-only CSS edit streams a `moved` line; SIGINT then exits 0 with no
// orphaned Chrome processes.
test('watch streams a moved diff on a CSS edit, then SIGINT exits 0 with no Chrome orphans', async () => {
  const dir = tempFixture()
  writeFixture(dir, CSS_START)
  const srv = await serve(dir)
  const pidsBefore = chromePids()

  const { child, buf } = startWatch(`${srv.url}/index.html`)
  try {
    await waitFor(buf, 'watching', 20_000)
    writeFileSync(join(dir, 'styles.css'), CSS_MOVED)
    await waitFor(buf, 'moved:', 20_000)
    expect(buf()).toMatch(/moved: .*div\.box/)
  } finally {
    child.kill('SIGINT')
  }
  const code = await waitClose(child)
  expect(code).toBe(0)
  srv.close()

  const deadline = Date.now() + 15_000
  while ([...chromePids()].some((p) => !pidsBefore.has(p)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
  }
  expect([...chromePids()].filter((p) => !pidsBefore.has(p))).toEqual([])
}, 90_000)

// (b) an edit that introduces a violation streams "new violation: parent-bleed", and
// reverting it streams "resolved:".
test('watch streams a new violation then resolved on revert', async () => {
  const dir = tempFixture()
  writeFixture(dir, CSS_START)
  const srv = await serve(dir)

  const { child, buf } = startWatch(`${srv.url}/index.html`)
  try {
    await waitFor(buf, 'watching', 20_000)

    writeFileSync(join(dir, 'styles.css'), CSS_BLEED)
    await waitFor(buf, 'new violation: parent-bleed', 20_000)

    writeFileSync(join(dir, 'styles.css'), CSS_START)
    await waitFor(buf, 'resolved:', 20_000)
    expect(buf()).toContain('resolved: parent-bleed')
  } finally {
    child.kill('SIGINT')
    await waitClose(child)
    srv.close()
  }
}, 90_000)

// (c) killing the fixture server mid-watch exits 1 with the unreachable message —
// no infinite retry.
test('watch exits 1 with "page unreachable" when the fixture server dies', async () => {
  const dir = tempFixture()
  writeFixture(dir, CSS_START)
  const srv = await serve(dir)

  const { child, buf } = startWatch(`${srv.url}/index.html`)
  await waitFor(buf, 'watching', 20_000)
  srv.close()

  const code = await waitClose(child)
  expect(code).toBe(1)
  expect(buf()).toContain('page unreachable — stopping')
}, 90_000)

// Polls for a flag file and acts once it 200s, guarded by sessionStorage so it never
// fires twice. Driven by the TEST writing the flag only after 'watching' has already
// appeared in the child's output — i.e. only once watch's frameNavigated listener is
// provably armed. A page-load-relative setTimeout raced watch's own startup (navigate()'s
// settle wait) in an earlier version of this test and fired before the listener existed,
// so the reload/navigation was silently missed — this replaces that race with an
// explicit signal.
function pollAndAct(flagName: string, action: string): string {
  return `<script>
(function poll() {
  if (sessionStorage.getItem('acted')) return
  fetch('${flagName}', { cache: 'no-store' }).then(function (r) {
    if (r.ok) { sessionStorage.setItem('acted', '1'); ${action} }
    else setTimeout(poll, 50)
  }).catch(function () { setTimeout(poll, 50) })
})()
</script>`
}

// contract #3, same-URL half: a same-URL full reload (HMR full-refresh) prints
// "page reloaded" and the process keeps running — not an error.
test('watch survives a same-URL full reload with a "page reloaded" line, then SIGINT exits 0', async () => {
  const dir = tempFixture()
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head>
<body><div class="wrap"><div class="box">hi</div></div>
${pollAndAct('reload.flag', 'location.reload()')}
</body></html>`)
  writeFileSync(join(dir, 'styles.css'), CSS_START)
  const srv = await serve(dir)

  const { child, buf } = startWatch(`${srv.url}/index.html`)
  try {
    await waitFor(buf, 'watching', 20_000)
    writeFileSync(join(dir, 'reload.flag'), '')
    await waitFor(buf, 'page reloaded', 20_000)
    expect(child.exitCode).toBeNull() // still running — a reload is not a stop condition
  } finally {
    child.kill('SIGINT')
  }
  const code = await waitClose(child)
  expect(code).toBe(0)
  srv.close()
}, 90_000)

// contract #3, different-URL half: navigating away to a different URL is a stop
// condition — "navigated away to <url> — stopping", exit 1.
test('watch stops with exit 1 when the page navigates to a different URL', async () => {
  const dir = tempFixture()
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head>
<body><div class="wrap"><div class="box">hi</div></div>
${pollAndAct('nav.flag', "location.href = 'other.html'")}
</body></html>`)
  writeFileSync(join(dir, 'other.html'), '<!doctype html><html><body>elsewhere</body></html>')
  writeFileSync(join(dir, 'styles.css'), CSS_START)
  const srv = await serve(dir)

  const { child, buf } = startWatch(`${srv.url}/index.html`)
  try {
    await waitFor(buf, 'watching', 20_000)
    writeFileSync(join(dir, 'nav.flag'), '')
    const code = await waitClose(child)
    expect(code).toBe(1)
    expect(buf()).toContain('navigated away to')
    expect(buf()).toContain('other.html')
    expect(buf()).toContain('— stopping')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  srv.close()
}, 90_000)

// safety: SIGINT during the STARTUP window (Chrome launched, page not yet ready —
// before 'watching' prints and before runLoop's handlers exist) must still exit 0
// with Chrome down. This is the "mistyped the URL, immediately Ctrl+C" pattern.
// Waiting for the Chrome tree to appear (instead of a fixed sleep) proves the signal
// lands inside watch()'s own startup — after its code is running, before the loop.
test('SIGINT during startup (before watching prints) exits 0 with no Chrome orphans', async () => {
  const dir = tempFixture()
  writeFixture(dir, CSS_START)
  const srv = await serve(dir)
  const pidsBefore = chromePids()

  const { child, buf } = startWatch(`${srv.url}/index.html`)
  const spawnDeadline = Date.now() + 30_000
  while (![...chromePids()].some((p) => !pidsBefore.has(p)) && Date.now() < spawnDeadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  expect([...chromePids()].some((p) => !pidsBefore.has(p))).toBe(true)
  child.kill('SIGINT')
  const code = await waitClose(child)
  expect(code, buf()).toBe(0)
  srv.close()

  const deadline = Date.now() + 15_000
  while ([...chromePids()].some((p) => !pidsBefore.has(p)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
  }
  expect([...chromePids()].filter((p) => !pidsBefore.has(p))).toEqual([])
}, 90_000)

// safety: SIGTERM (not just SIGINT) also shuts Chrome down cleanly, exit 0.
test('watch handles SIGTERM the same as SIGINT: exit 0, no Chrome orphans', async () => {
  const dir = tempFixture()
  writeFixture(dir, CSS_START)
  const srv = await serve(dir)
  const pidsBefore = chromePids()

  const { child, buf } = startWatch(`${srv.url}/index.html`)
  await waitFor(buf, 'watching', 20_000)

  child.kill('SIGTERM')
  const code = await waitClose(child)
  expect(code).toBe(0)
  srv.close()

  const deadline = Date.now() + 15_000
  while ([...chromePids()].some((p) => !pidsBefore.has(p)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
  }
  expect([...chromePids()].filter((p) => !pidsBefore.has(p))).toEqual([])
}, 90_000)

// plumbing: --viewports is rejected before any Chrome is touched (watch holds one page
// open; it takes --viewport, singular, not a sweep).
test('watch rejects --viewports, exiting 2 with no page opened', async () => {
  const err = await cli('watch', 'http://127.0.0.1:1', '--viewports', '375x800,1280x800').catch((e) => e)
  expect(err.code).toBe(2)
  expect(err.stderr).toContain('--viewports is not valid for watch')
}, 20_000)

// plumbing: --interval too small (including an explicit 0, which the CLI's own
// `f.interval ? Number(f.interval) : undefined` ternary would otherwise pass through as a
// literal 0 — a busy-loop hammering the page on every tick) is rejected before any Chrome
// is touched, not silently defaulted or honored.
test.each(['0', '10', '49'])('watch rejects --interval %s (below the 50ms floor), exiting 2 with no page opened', async (interval) => {
  const err = await cli('watch', 'http://127.0.0.1:1', '--interval', interval).catch((e) => e)
  expect(err.code).toBe(2)
  expect(err.stderr).toContain('--interval must be >= 50')
}, 20_000)

// quiet-when-idle: no output at all while nothing changes (no heartbeat spam).
test('watch prints nothing beyond the startup lines while the page is idle', async () => {
  const dir = tempFixture()
  writeFixture(dir, CSS_START)
  const srv = await serve(dir)

  const { child, buf } = startWatch(`${srv.url}/index.html`)
  try {
    await waitFor(buf, 'watching', 20_000)
    const afterStartup = buf()
    await new Promise((r) => setTimeout(r, 2000)) // several poll ticks at --interval 100
    expect(buf()).toBe(afterStartup)
  } finally {
    child.kill('SIGINT')
    await waitClose(child)
    srv.close()
  }
}, 90_000)

// crash-vs-unreachable: a CDP throw while reporting a detected change (inside
// settleAndReport) must be told apart from a real bug — if the page is ALSO unreachable
// (the dev server died in that exact window), runLoop must fall back to the same exit-1
// "page unreachable" contract, not let the raw error escape as an uncaught exit-2 crash.
// Deterministic seam, not an HTTP-teardown race (an abrupt srv.close() mid-reload proved
// unreproducible across dozens of manual trials — Chrome handles a dead-server reload by
// committing to an error page rather than throwing): the fixture server is closed from
// INSIDE a patched DOMSnapshot.captureSnapshot, at the exact moment settleAndReport's
// second capture runs, so reachable() is provably true right up to the throw and false
// right after — no timing luck required.
test('runLoop reports "page unreachable" instead of crashing when a CDP failure coincides with the dev server dying', async () => {
  const dir = tempFixture()
  writeFixture(dir, CSS_START)
  const srv = await serve(dir)
  const url = `${srv.url}/index.html`

  await withPage(url, async (client) => {
    let captures = 0
    const origCapture = client.DOMSnapshot.captureSnapshot.bind(client.DOMSnapshot)
    client.DOMSnapshot.captureSnapshot = async (...args: unknown[]) => {
      captures++
      if (captures === 2) {
        srv.close() // kill the dev server at the exact moment settleAndReport recaptures
        throw new Error('simulated CDP failure')
      }
      return origCapture(...args)
    }

    const loop = runLoop(client, url, 30)
    await new Promise((r) => setTimeout(r, 300)) // past the initial capture and a few idle ticks
    await client.Runtime.evaluate({ expression: "document.querySelector('.box').style.width = '999px'" })
    const code = await loop
    expect(code).toBe(1)
  })
}, 30_000)

// The other half of the same guard: when the page is STILL reachable, a CDP failure while
// reporting is a real bug and must surface, not be swallowed as if the server had died.
test('runLoop rethrows a CDP failure during change-reporting when the page is still reachable', async () => {
  const dir = tempFixture()
  writeFixture(dir, CSS_START)
  const srv = await serve(dir)
  const url = `${srv.url}/index.html`

  try {
    await expect(withPage(url, async (client) => {
      let captures = 0
      const origCapture = client.DOMSnapshot.captureSnapshot.bind(client.DOMSnapshot)
      client.DOMSnapshot.captureSnapshot = async (...args: unknown[]) => {
        captures++
        if (captures === 2) throw new Error('simulated CDP failure')
        return origCapture(...args)
      }

      const loop = runLoop(client, url, 30)
      await new Promise((r) => setTimeout(r, 300))
      await client.Runtime.evaluate({ expression: "document.querySelector('.box').style.width = '999px'" })
      await loop
    })).rejects.toThrow('simulated CDP failure')
  } finally {
    srv.close()
  }
}, 30_000)
