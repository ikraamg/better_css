import { shutdownChrome, withPage } from './connect.js'
import { extract } from './extract.js'
import { buildTree, renderTree, type BuiltTree } from './tree.js'
import { checkInvariants, renderViolations, type Violation } from './invariants.js'
import { diffTrees, renderDiff } from './snapshot.js'
import { SIGNATURE_EXPR, waitForSettle } from './interact.js'

export interface WatchOpts {
  viewport?: { width: number; height: number }
  interval?: number // default 500
  port?: number
}

const DEFAULT_INTERVAL = 500

function ts(): string {
  return new Date().toTimeString().slice(0, 8) // "HH:MM:SS"
}

// Any HTTP response (even an error status) proves the origin is reachable — only a
// connection-level failure (dev server process gone) means "unreachable". No retry
// here: the caller stops on the first failure (contract: no infinite retry loop).
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) })
    return true
  } catch {
    return false
  }
}

const keyOf = (v: Violation): string => `${v.rule} ${v.selector}`

// (rule,selector) set difference — same technique blame.ts's sameState uses — so a
// violation whose px amount merely drifted isn't reported as newly-introduced/resolved.
function violationDelta(prev: Violation[], curr: Violation[]): { added: Violation[]; resolved: Violation[] } {
  const prevKeys = new Set(prev.map(keyOf))
  const currKeys = new Set(curr.map(keyOf))
  return {
    added: curr.filter((v) => !prevKeys.has(keyOf(v))),
    resolved: prev.filter((v) => !currKeys.has(keyOf(v))),
  }
}

// Reuses invariants.ts's grouped renderer (same collapsing + `suspect:` lookups as
// `check`) so a delta line reads identically to check's own output, just labeled.
// Only the group's own line gets the label — the indented `  suspect:` line stays as-is.
async function renderDelta(client: any, violations: Violation[], label: string): Promise<string[]> {
  if (!violations.length) return []
  const body = await renderViolations(client, violations)
  return body.split('\n').map((line) => (line.startsWith('  ') ? line : `${label}${line}`))
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/$/, '') === b.replace(/\/$/, '')
}

// One block per reported change: a single wall-clock timestamp line, then the
// deterministic diff/violation-delta content untouched — only the wrapper is
// observation-stream timing, per contract. Nothing is printed for a no-op change.
function printBlock(lines: string[]): void {
  if (!lines.length) return
  console.log(`[${ts()}]`)
  for (const line of lines) console.log(line)
}

async function capture(client: any): Promise<{ tree: BuiltTree; violations: Violation[]; text: string }> {
  const tree = buildTree(await extract(client))
  const violations = checkInvariants(tree)
  return { tree, violations, text: renderTree(tree) }
}

async function readSignature(client: any): Promise<unknown> {
  const { result } = await client.Runtime.evaluate({ expression: SIGNATURE_EXPR, returnByValue: true })
  return result.value
}

// The long-lived loop: holds `client`'s page open for the whole watch, polling the
// settle-signature hash every `interval` ms. Returns the process exit code (0 for a
// clean stop/SIGINT, 1 for unreachable/navigated-away) — never throws, never retries.
// SIGINT/SIGTERM are armed for the loop's entire lifetime and always disarmed in the
// finally (mirrors blame.ts's per-walk arm/disarm), but unlike blame there's nothing
// synchronous to clean up here: flipping `stopped` and waking the sleep lets the loop
// return normally, so withPage's own finally (page/target close) and cli.ts's
// shutdownChrome (browser process) run through the ordinary async exit path.
async function runLoop(client: any, url: string, interval: number): Promise<number> {
  let stopped = false
  let wake: (() => void) | undefined
  const onSignal = () => { stopped = true; wake?.() }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  // Armed for the whole loop, same rationale as interact.ts's own frameNavigated
  // listener: a reload can land between poll ticks, so it's event-driven, not polled.
  let navigatedTo: string | null = null
  client.Page.frameNavigated(({ frame }: any) => {
    if (!frame.parentId) navigatedTo = frame.url
  })

  try {
    const initial = await capture(client)
    console.log(await renderViolations(client, initial.violations))
    console.log(`watching ${url} (Ctrl+C to stop)`)
    if (stopped) return 0

    let stableText = initial.text
    let stableViolations = initial.violations
    let lastSig = await readSignature(client)

    const sleep = (ms: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      wake = () => { clearTimeout(timer); resolve() }
    })

    // Full recapture + report, shared by both trigger paths (signature-poll change and
    // same-URL reload) — a reload's new DOM needs the identical settle/diff/delta
    // treatment a CSS-only change gets, just with its own leading line.
    const settleAndReport = async (): Promise<void> => {
      await waitForSettle(client)
      const next = await capture(client)
      const diffEntries = diffTrees(stableText, next.text)
      const { added, resolved } = violationDelta(stableViolations, next.violations)
      const lines: string[] = []
      if (diffEntries.length) lines.push(...renderDiff(diffEntries).split('\n'))
      lines.push(...(await renderDelta(client, added, 'new violation: ')))
      lines.push(...(await renderDelta(client, resolved, 'resolved: ')))
      printBlock(lines)
      stableText = next.text
      stableViolations = next.violations
      lastSig = await readSignature(client)
    }

    while (!stopped) {
      await sleep(interval)
      if (stopped) break

      if (navigatedTo !== null) {
        const navUrl = navigatedTo
        navigatedTo = null
        if (!sameUrl(navUrl, url)) {
          console.log(`[${ts()}] navigated away to ${navUrl} — stopping`)
          return 1
        }
        console.log(`[${ts()}] page reloaded`)
        await settleAndReport()
        continue
      }

      if (!(await reachable(url))) {
        console.log(`[${ts()}] page unreachable — stopping`)
        return 1
      }
      if (stopped) break

      let sig: unknown
      try {
        sig = await readSignature(client)
      } catch {
        continue // execution context transiently gone (e.g. a reload in flight) — next tick resolves it
      }
      if (sig === lastSig) continue // quiet: nothing changed, no heartbeat spam

      await settleAndReport()
    }
    return 0
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }
}

// CLI-only in v1 (see README/SKILL): a streaming daemon doesn't fit MCP's
// request/response shape. An agent drives it via a background shell and reads the
// stream instead of re-running `diff` after every edit.
//
// The clean-shutdown contract applies from INVOCATION, not from the first poll:
// Chrome launch / CDP connect / navigate all happen inside withPage before runLoop
// arms its handlers, and a Ctrl+C in that startup window ("mistyped the URL,
// immediately interrupted") would otherwise hit Node's default disposition — exit 130
// with the whole detached Chrome tree orphaned. So arm here first; shutdownChrome
// itself waits out an in-flight launch (connect.ts), and the handoff to runLoop is
// race-free: the removeListener calls and runLoop's own process.on run in the same
// synchronous stretch (signals only ever arrive via the event loop between them).
export async function watch(url: string, opts: WatchOpts = {}): Promise<number> {
  const early = () => { void shutdownChrome().finally(() => process.exit(0)) }
  process.on('SIGINT', early)
  process.on('SIGTERM', early)
  try {
    return await withPage(url, (client) => {
      process.removeListener('SIGINT', early)
      process.removeListener('SIGTERM', early)
      return runLoop(client, url, opts.interval ?? DEFAULT_INTERVAL)
    }, { port: opts.port, viewport: opts.viewport })
  } finally {
    process.removeListener('SIGINT', early)
    process.removeListener('SIGTERM', early)
  }
}
