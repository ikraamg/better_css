import CDP from 'chrome-remote-interface'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean) as string[]

const HELP = `Cannot reach Chrome. Either let bettercss launch headless Chrome (install Chrome), or start yours with:
  open -a "Google Chrome" --args --remote-debugging-port=9222   (macOS)
  google-chrome --remote-debugging-port=9222                    (Linux)`

let launched: { proc: ChildProcess; port: number; dir: string } | null = null
let launching: Promise<number> | null = null
const busyPages = new WeakSet<object>()

// Populated only when withPage's captureAnimations opt is set (src/core/animate.ts's
// settleAnimations reads this). Animation.animationStarted events carry
// animation.source.duration/delay/iterations — that's the only place seekable timing
// comes from, so they must be cached as they arrive rather than queried on demand.
const animationCache = new WeakMap<object, any[]>()
export function cachedAnimations(client: object): any[] {
  return animationCache.get(client) ?? []
}

async function reachable(port: number): Promise<boolean> {
  try { await CDP.Version({ port }); return true } catch { return false }
}

async function launchChrome(): Promise<number> {
  const { existsSync } = await import('node:fs')
  const bin = CHROME_PATHS.find((p) => existsSync(p))
  if (!bin) throw new Error(HELP)
  const dir = mkdtempSync(join(tmpdir(), 'bettercss-'))
  const proc = spawn(bin, [
    '--headless=new', '--remote-debugging-port=0', '--no-first-run',
    // crashpad_handler is designed to outlive Chrome and would leak past
    // shutdownChrome (observed on Linux CI); a headless tool doesn't need it
    '--disable-crash-reporter', '--disable-breakpad',
    `--user-data-dir=${dir}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true }) // own process group, so shutdown can group-kill
  const port = await new Promise<number>((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error(HELP)), 15_000)
    proc.stderr!.on('data', (d) => {
      buf += d.toString()
      const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    })
    proc.on('exit', () => { clearTimeout(timer); reject(new Error(HELP)) })
  })
  launched = { proc, port, dir }
  return port
}

async function resolvePort(explicit?: number): Promise<number> {
  if (explicit !== undefined) {
    if (await reachable(explicit)) return explicit
    throw new Error(`No Chrome at port ${explicit}. ${HELP}`)
  }
  if (await reachable(9222)) return 9222
  if (launched && (await reachable(launched.port))) return launched.port
  // NOTE: shared promise so concurrent callers await one launch instead of racing.
  if (!launching) launching = launchChrome().finally(() => { launching = null })
  return launching
}

async function navigate(client: any, url: string): Promise<void> {
  const { Page, Network } = client
  let inflight = 0
  let settle: ReturnType<typeof setTimeout> | undefined
  let resolveIdle!: () => void
  const idle = new Promise<void>((resolve) => { resolveIdle = resolve })
  const check = () => {
    clearTimeout(settle)
    if (inflight === 0) settle = setTimeout(resolveIdle, 500)
  }
  Network.requestWillBeSent(() => { inflight++; clearTimeout(settle) })
  Network.loadingFinished(() => { inflight--; check() })
  Network.loadingFailed(() => { inflight--; check() })
  const loaded = Page.loadEventFired()
  const { errorText } = await Page.navigate({ url })
  if (errorText) throw new Error(`Failed to load ${url}: ${errorText}`)
  // NOTE: arm the settle timer only after navigate is issued, so a slow-starting
  // main-document request can't let the idle promise resolve early and for good.
  check()
  await loaded
  let cap: ReturnType<typeof setTimeout> | undefined
  const timedOut = await Promise.race([
    idle.then(() => false),
    new Promise<boolean>((r) => { cap = setTimeout(() => r(true), 10_000) }),
  ])
  clearTimeout(cap)
  clearTimeout(settle)
  if (timedOut) busyPages.add(client)
}

export function pageWasBusy(client: object): boolean {
  return busyPages.has(client)
}

export async function withPage<T>(
  url: string,
  fn: (client: any) => Promise<T>,
  opts: { port?: number; viewport?: { width: number; height: number }; captureAnimations?: boolean } = {},
): Promise<T> {
  const port = await resolvePort(opts.port)
  const target = await CDP.New({ port, url: 'about:blank' })
  let client: any
  try {
    client = await CDP({ port, target })
    if (opts.captureAnimations) {
      // Must be armed before Page.navigate — animationStarted fires as each animation is
      // CREATED (verified empirically), so enabling after navigation misses page-load-triggered
      // ones entirely (e.g. a transition/animation kicked off by an inline <script>).
      const events: any[] = []
      animationCache.set(client, events)
      client.Animation.animationStarted((e: any) => events.push(e.animation))
      await client.Animation.enable()
    }
    await client.Page.enable()
    await client.Network.enable()
    const vp = opts.viewport ?? { width: 1280, height: 800 }
    await client.Emulation.setDeviceMetricsOverride({ ...vp, deviceScaleFactor: 1, mobile: false })
    await navigate(client, url)
    return await fn(client)
  } finally {
    // Swallow cleanup errors: they must not mask fn's error or skip closing the tab.
    if (client) { try { await client.close() } catch {} }
    try { await CDP.Close({ port, id: target.id }) } catch {}
  }
}

// Shared by the CLI's --viewport WxH flag and the MCP tools' viewport param.
export function parseViewport(spec: string): { width: number; height: number } {
  const m = spec.match(/^(\d+)x(\d+)$/)
  if (!m) throw new Error(`--viewport must be WxH (e.g. 1280x800), got '${spec}'`)
  return { width: Number(m[1]), height: Number(m[2]) }
}

export interface Viewport { label: string; width: number; height: number }

// verify's default viewport sweep when --viewports/viewports is omitted — mobile, tablet,
// desktop. Shared constant so the CLI USAGE text, the MCP tool description, and the
// actual default can't drift apart.
export const DEFAULT_SWEEP = '375x800,768x800,1280x800'

// Shared by the CLI's --viewports and the MCP tools' viewports param: comma-separated
// WxH list, e.g. "600x800,1280x800". label preserves the original WxH text for output prefixes.
export function parseViewportList(spec: string): Viewport[] {
  return spec.split(',').map((s) => {
    const label = s.trim()
    return { label, ...parseViewport(label) }
  })
}

// One withPage per viewport (withPage opens a single page per call) — sequential and in
// input order, so the matrix's summary line stays deterministic.
export async function forEachViewport<T>(
  url: string,
  viewports: Viewport[],
  fn: (client: any, vp: Viewport) => Promise<T>,
  opts: { port?: number; captureAnimations?: boolean } = {},
): Promise<Array<{ label: string; result: T }>> {
  const out: Array<{ label: string; result: T }> = []
  for (const vp of viewports) {
    const result = await withPage(url, (client) => fn(client, vp), { port: opts.port, viewport: vp, captureAnimations: opts.captureAnimations })
    out.push({ label: vp.label, result })
  }
  return out
}

// Memoized so a second caller AWAITS the in-flight shutdown instead of returning
// early: the MCP server's stdio-close handler starts shutdown, then the host's
// follow-up SIGTERM re-enters — an instant return there would process.exit(0)
// mid-Browser.close and orphan the whole Chrome tree (observed on Linux CI).
let shuttingDown: Promise<void> | null = null

export function shutdownChrome(): Promise<void> {
  if (shuttingDown) return shuttingDown
  if (!launched) return Promise.resolve()
  shuttingDown = doShutdown().finally(() => { shuttingDown = null })
  return shuttingDown
}

async function doShutdown(): Promise<void> {
  if (!launched) return
  const { proc, dir } = launched
  launched = null
  // Group-SIGKILL the whole Chrome tree at once. Nothing needs a graceful
  // close — the profile dir is deleted below anyway — and shutdown must fit
  // inside an MCP host's kill grace (the SDK SIGKILLs the server ~4s after
  // stdio close; a slow graceful path orphaned renderers on Linux CI).
  // Chrome is spawned detached (its own process group), so -pid takes
  // browser + renderers + GPU together.
  try { process.kill(-proc.pid!, 'SIGKILL') } catch { proc.kill('SIGKILL') }
  if (proc.exitCode === null && proc.signalCode === null) {
    await new Promise((r) => proc.once('exit', r))
  }
  // Chrome's helper processes outlive the main process briefly and can still be
  // writing to the profile dir (ENOTEMPTY race, seen on Linux CI). Cleanup is
  // best-effort: retry twice, then leave it to the OS temp reaper — never fatal.
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      if (attempt >= 2) return
      await new Promise((r) => setTimeout(r, 150))
    }
  }
}
