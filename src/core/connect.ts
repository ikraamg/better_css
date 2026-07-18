import CDP from 'chrome-remote-interface'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitForSettle } from './interact.js'

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean) as string[]

const HELP = `Cannot reach Chrome. Either let csstruth launch headless Chrome (install Chrome), or start yours with:
  open -a "Google Chrome" --args --remote-debugging-port=9222   (macOS)
  google-chrome --remote-debugging-port=9222                    (Linux)`

let launched: { proc: ChildProcess; port: number; dir: string } | null = null
let launching: Promise<number> | null = null
const busyPages = new WeakSet<object>()

// Opt-in attach to a developer's own Chrome on 9222 (for logged-in/app-state pages).
// Default is OFF: csstruth launches its own isolated headless Chrome, so it never opens
// tabs in — or fights over — a browser the developer has open for other work. The CLI's
// --attach flag turns it on for that invocation; the MCP server stays isolated always
// (a background server must not silently reach into the user's browser). An explicit
// --port always attaches to that port regardless of this switch.
let attachTo9222 = false
export function setAttachMode(on: boolean): void { attachTo9222 = on }

// Field #3: the 375px "mobile" leg of the default sweep used to run mobile:false,
// deviceScaleFactor:1 — a desktop window squeezed narrow, not a phone. Touch-target
// rules got enforced on non-touch emulation, and <meta viewport>/DPR-sensitive
// rendering never got exercised. --desktop-only (CLI) restores the old squeeze
// everywhere, same module-level-setter shape as --attach above.
let desktopOnly = false
export function setDesktopOnly(on: boolean): void { desktopOnly = on }
// Phones top out around ~430 CSS px (iPhone Pro Max); 500 is a safe cutoff that still
// excludes small tablets/foldables, which behave like desktop (mobile:false, DPR 1).
const MOBILE_WIDTH_MAX = 500

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
  // Self-heal before spawning: reap any Chrome abandoned by a PREVIOUS invocation
  // (CI telemetry proved a shutdown can genuinely reach "0 pids remain" and still leak —
  // on a loaded runner, fork-to-ps-visibility outruns any in-process sweep, and an exited
  // process can't reap what it never saw).
  sweepAbandonedProfiles()
  const bin = CHROME_PATHS.find((p) => existsSync(p))
  if (!bin) throw new Error(HELP)
  const dir = mkdtempSync(join(tmpdir(), 'csstruth-'))
  const proc = spawn(bin, [
    '--headless=new', '--remote-debugging-port=0', '--no-first-run',
    // crashpad_handler is designed to outlive Chrome and would leak past
    // shutdownChrome (observed on Linux CI); a headless tool doesn't need it
    '--disable-crash-reporter', '--disable-breakpad',
    // classic scrollbars consume layout width (15px on Linux), overlay ones don't —
    // force overlay so the same page yields byte-identical geometry on every platform
    '--enable-features=OverlayScrollbar',
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
  if (terminating) throw new Error('shutting down')
  if (explicit !== undefined) {
    if (await reachable(explicit)) return explicit
    throw new Error(`No Chrome at port ${explicit}. ${HELP}`)
  }
  // Attach to a developer's Chrome on 9222 only when explicitly opted in (--attach);
  // otherwise fall through to launching our own isolated headless instance.
  if (attachTo9222 && (await reachable(9222))) return 9222
  if (launched && (await reachable(launched.port))) return launched.port
  // Re-check after the awaits above: a terminal shutdown can begin while the
  // reachability probes were in flight — launching now would create the exact
  // orphan the latch exists to prevent (kill Chrome A, relaunch B, exit).
  if (terminating) throw new Error('shutting down')
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

// Layout-settle gate (field #1): navigate()'s load+network-idle race (or its 10s cap)
// only proves the DOCUMENT loaded — an app page can still be mid-render the instant it
// resolves (flex captured before shrink, async containers still empty). One settle wait
// here, right after navigation and before withPage's callback runs, so every capture path
// (check/layout/inspect/explain/verify/snapshot/diff) sees a stable DOM. interact.ts's own
// post-interact settle and animate.ts's post-seek settle are LATER-phase settles on top of
// an already-stable start, not a repeat of this one — this only runs once, here.
const neverSettled = new WeakSet<object>()
export function layoutNeverSettled(client: object): boolean {
  return neverSettled.has(client)
}
const NAV_SETTLE_CAP_MS = 3000

export async function withPage<T>(
  url: string,
  fn: (client: any) => Promise<T>,
  opts: {
    port?: number
    viewport?: { width: number; height: number }
    captureAnimations?: boolean
    // Runs after Page/Network are enabled and the viewport is set, but before Page.navigate —
    // the one gap where a caller can arm something that must see the FIRST document (e.g.
    // stability.ts's Page.addScriptToEvaluateOnNewDocument for its layout-shift observer).
    beforeNavigate?: (client: any) => Promise<void>
  } = {},
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
    // Narrow viewports emulate a real phone (mobile:true, DPR 2) instead of a squeezed
    // desktop window — extract.ts's normalizeBounds already divides DOMSnapshot bounds
    // back to CSS px regardless of DPR, so this only changes <meta viewport> fallback
    // behavior and touch semantics, exactly the field-test gap. mobile:true alone does
    // NOT flip hover/pointer media features or touch feature detection (verified
    // empirically against Chrome 150 headless) — setTouchEmulationEnabled is required.
    const mobile = !desktopOnly && vp.width <= MOBILE_WIDTH_MAX
    await client.Emulation.setDeviceMetricsOverride({ ...vp, deviceScaleFactor: mobile ? 2 : 1, mobile })
    if (mobile) await client.Emulation.setTouchEmulationEnabled({ enabled: true })
    if (opts.beforeNavigate) await opts.beforeNavigate(client)
    await navigate(client, url)
    if (opts.captureAnimations) {
      // Compose, don't stack (contract 1): the caller is about to run animate.ts's
      // settleAnimations, which freezes the page's ENTIRE animation clock and seeks
      // deterministically from t=0 — that supersedes a real settle wait here entirely. A
      // full wait would instead RACE a live, possibly long-running transition/animation
      // against that freeze, burning real wall-clock time before the caller ever gets a
      // chance to pin it (breaks the "seek is deterministic regardless of timing"
      // contract animate.ts relies on — verified empirically against a 10s transition).
      // One minimal pass only, mirroring interact.ts's skipSettleWait: just enough for a
      // load-triggered animation to have registered with Animation.animationStarted.
      await waitForSettle(client, 1)
    } else if (!(await waitForSettle(client, NAV_SETTLE_CAP_MS))) {
      neverSettled.add(client)
    }
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

// Terminal latch: once a { terminal: true } shutdown begins, resolvePort refuses all
// further launches ('shutting down'), permanently — the process is exiting. Without it,
// a signal handler's `await shutdownChrome()` (kills Chrome A, launched=null) races any
// in-flight work whose next withPage → resolvePort sees launched===null and launches
// Chrome B, which process.exit() then abandons (observed on 2-core Linux CI: blame's
// SIGINT test left 2 pids after a full 15s poll, exit code 130 — the handler ran fine,
// the walk relaunched behind it).
let terminating = false

export function shutdownChrome(opts: { terminal?: boolean } = {}): Promise<void> {
  if (opts.terminal) terminating = true
  if (shuttingDown) return shuttingDown
  if (!launched && !launching) return Promise.resolve()
  shuttingDown = doShutdown().finally(() => { shuttingDown = null })
  return shuttingDown
}

// Pure parse of `ps -eo pid=,args=` output → pids of processes referencing OUR profile
// dir exactly (delimited by whitespace or end-of-line, so /tmp/csstruth-AAA never
// matches a /tmp/csstruth-AAAB line). Exported as the unit-test seam for doShutdown's
// straggler sweep — the zygote race itself only reproduces on multi-core Linux CI.
export function stragglerPids(psOutput: string, dir: string): number[] {
  const ref = `--user-data-dir=${dir}`
  return psOutput.split('\n')
    .filter((l) => l.includes(ref + ' ') || l.trimEnd().endsWith(ref))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

// Pure filter seam for sweepAbandonedProfiles: ps lines whose --user-data-dir starts
// with OUR naming prefix AND whose profile dir no longer exists per `exists` (shutdown
// rm'd it → provably abandoned). A dir still on disk could be a live concurrent
// csstruth — never touched. Injected `exists` keeps this unit-testable.
export function abandonedProfilePids(psOutput: string, prefix: string, exists: (dir: string) => boolean): number[] {
  return psOutput.split('\n').flatMap((l) => {
    const dir = l.match(/--user-data-dir=(\S+)/)?.[1]
    if (!dir || !dir.startsWith(prefix) || exists(dir)) return []
    const pid = Number(l.trim().split(/\s+/)[0])
    return Number.isInteger(pid) && pid > 0 ? [pid] : []
  })
}

// Cross-invocation self-healing: SIGKILL processes still carrying a csstruth profile
// dir that no longer exists on disk. Run at every launchChrome (before spawning) and in
// doShutdown's final phase. Rationale: CI telemetry proved the in-process shutdown can
// reach "final: 0 pids remain" and STILL leak — on a loaded runner a renderer forked at
// kill-time becomes ps-visible only after the process exits, so no in-process sweep can
// ever reap it; the NEXT invocation does instead. Best-effort, never fatal.
export function sweepAbandonedProfiles(): number {
  try {
    const psOut = execSync('ps -eo pid=,args=', { stdio: 'pipe' }).toString()
    const pids = abandonedProfilePids(psOut, join(tmpdir(), 'csstruth-'), existsSync)
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch {} }
    if (pids.length) debugShutdown(`abandoned-profile sweep: reaped ${pids.length} pids`)
    return pids.length
  } catch { return 0 }
}

// Env-gated shutdown telemetry (CSSTRUTH_DEBUG_SHUTDOWN=1): one stderr line per phase,
// so a CI-only leak arrives self-explaining (the blame SIGINT test captures its child's
// stderr into the failure message; CI's workflow sets the env for every suite shutdown).
// Quiet for real users.
function debugShutdown(msg: string): void {
  if (process.env.CSSTRUTH_DEBUG_SHUTDOWN === '1') process.stderr.write(`[csstruth shutdown] ${msg}\n`)
}

// `--type=renderer` etc. summarized for telemetry; the main browser process has no --type.
function processTypes(psOutput: string, dir: string): string {
  const pids = new Set(stragglerPids(psOutput, dir))
  return psOutput.split('\n')
    .filter((l) => pids.has(Number(l.trim().split(/\s+/)[0])))
    .map((l) => l.match(/--type=(\S+)/)?.[1] ?? 'browser')
    .join(',')
}

async function doShutdown(): Promise<void> {
  // A signal can land while launchChrome is still in flight (watch's startup guard,
  // blame's mid-walk handler) — Chrome's process exists from the moment spawn()
  // returns, long before `launched` is set (DevTools-listening). Returning early here
  // would orphan that whole tree; wait for the launch so it's killable. A FAILED
  // launch rejected before setting `launched`, so there's nothing to kill.
  if (launching) { try { await launching } catch {} }
  if (!launched) return
  const { proc, dir } = launched
  launched = null

  const ps = (): string => {
    try { return execSync('ps -eo pid=,args=', { stdio: 'pipe' }).toString() } catch { return '' }
  }
  // Kill order matters (CI forensics: renderers spawned at the instant of a group-kill
  // survived it — on Linux the sandbox/zygote places them OUTSIDE the main process
  // group, and a renderer caught mid-spawn never notices the dead browser):
  // (1) collect EVERY pid carrying our unique profile dir — zygote, renderers, gpu,
  //     main — and SIGKILL them individually; killing the zygote first-class stops new
  //     renderer forks at the source (a dead zygote can't fork);
  // (2) group-SIGKILL as backstop for anything the ps snapshot missed;
  // (3) re-sweep-poll until zero profile pids or a 2s deadline (late ps-visibility
  //     under CI load is a candidate mechanism for the previous 450ms sweep missing).
  // All best-effort, never fatal. NOT --no-sandbox/--no-zygote: we render arbitrary
  // URLs — the sandbox stays.
  try {
    const first = ps()
    const initial = stragglerPids(first, dir)
    debugShutdown(`initial sweep: ${initial.length} pids [${processTypes(first, dir)}]`)
    for (const pid of initial) { try { process.kill(pid, 'SIGKILL') } catch {} }
    try { process.kill(-proc.pid!, 'SIGKILL'); debugShutdown('group-kill: ok') }
    catch (err) { proc.kill('SIGKILL'); debugShutdown(`group-kill failed (${(err as Error).message}), single-kill sent`) }
    if (proc.exitCode === null && proc.signalCode === null) {
      await new Promise((r) => proc.once('exit', r))
    }
    const deadline = Date.now() + 2000
    let remaining: number[]
    while ((remaining = stragglerPids(ps(), dir)).length > 0 && Date.now() < deadline) {
      debugShutdown(`re-sweep: ${remaining.length} pids remain`)
      for (const pid of remaining) { try { process.kill(pid, 'SIGKILL') } catch {} }
      await new Promise((r) => setTimeout(r, 150))
    }
    debugShutdown(`final: ${remaining.length} pids remain`)
  } catch (err) {
    debugShutdown(`sweep error: ${(err as Error).message}`)
    // ps unavailable or similar — fall back to what the old path always did
    try { process.kill(-proc.pid!, 'SIGKILL') } catch { proc.kill('SIGKILL') }
  }
  // Chrome's helper processes outlive the main process briefly and can still be
  // writing to the profile dir (ENOTEMPTY race, seen on Linux CI). Cleanup is
  // best-effort: retry twice, then leave it to the OS temp reaper — never fatal.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      break
    } catch {
      if (attempt >= 2) break
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  // Our dir is (usually) gone now, so any late-visible renderer of OURS also qualifies
  // as abandoned — catches same-process latecomers; launchChrome catches cross-invocation.
  sweepAbandonedProfiles()
}
