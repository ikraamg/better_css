import CDP from 'chrome-remote-interface'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
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

let launched: { proc: ChildProcess; port: number } | null = null
const busyPages = new WeakSet<object>()

async function reachable(port: number): Promise<boolean> {
  try { await CDP.Version({ port }); return true } catch { return false }
}

async function launchChrome(): Promise<number> {
  const { existsSync } = await import('node:fs')
  const bin = CHROME_PATHS.find((p) => existsSync(p))
  if (!bin) throw new Error(HELP)
  const proc = spawn(bin, [
    '--headless=new', '--remote-debugging-port=0', '--no-first-run',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'bettercss-'))}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
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
  launched = { proc, port }
  return port
}

async function resolvePort(explicit?: number): Promise<number> {
  if (explicit !== undefined) {
    if (await reachable(explicit)) return explicit
    throw new Error(`No Chrome at port ${explicit}. ${HELP}`)
  }
  if (await reachable(9222)) return 9222
  if (launched && (await reachable(launched.port))) return launched.port
  return launchChrome()
}

async function navigate(client: any, url: string): Promise<void> {
  const { Page, Network } = client
  let inflight = 0
  let settle: ReturnType<typeof setTimeout> | undefined
  const idle = new Promise<void>((resolve) => {
    const check = () => {
      clearTimeout(settle)
      if (inflight === 0) settle = setTimeout(resolve, 500)
    }
    Network.requestWillBeSent(() => { inflight++; clearTimeout(settle) })
    Network.loadingFinished(() => { inflight--; check() })
    Network.loadingFailed(() => { inflight--; check() })
    check()
  })
  const loaded = Page.loadEventFired()
  await Page.navigate({ url })
  await loaded
  const timedOut = await Promise.race([
    idle.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), 10_000)),
  ])
  if (timedOut) busyPages.add(client)
}

export function pageWasBusy(client: object): boolean {
  return busyPages.has(client)
}

export async function withPage<T>(
  url: string,
  fn: (client: any) => Promise<T>,
  opts: { port?: number; viewport?: { width: number; height: number } } = {},
): Promise<T> {
  const port = await resolvePort(opts.port)
  const target = await CDP.New({ port, url: 'about:blank' })
  const client: any = await CDP({ port, target })
  try {
    await client.Page.enable()
    await client.Network.enable()
    const vp = opts.viewport ?? { width: 1280, height: 800 }
    await client.Emulation.setDeviceMetricsOverride({ ...vp, deviceScaleFactor: 1, mobile: false })
    await navigate(client, url)
    return await fn(client)
  } finally {
    await client.close()
    await CDP.Close({ port, id: target.id })
  }
}

export async function shutdownChrome(): Promise<void> {
  if (launched) { launched.proc.kill(); launched = null }
}
