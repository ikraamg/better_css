import { afterAll, expect, test } from 'vitest'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { shutdownChrome } from '../src/core/connect.js'
import { chromePids, chromeProcessLines } from './helpers/server.js'

afterAll(async () => { await shutdownChrome() })

const run = promisify(execFile)
const cli = (...args: string[]) => run('npx', ['tsx', 'src/cli.ts', ...args], { encoding: 'utf8' })

// --- throwaway git repo helper (NEVER the project repo — always a fresh temp dir) ---

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
}

const repos: string[] = []
afterAll(() => { for (const dir of repos) rmSync(dir, { recursive: true, force: true }) })

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bettercss-blame-repo-'))
  repos.push(dir)
  git(dir, ['init', '-q'])
  // Local to the throwaway repo only — never touches the developer's global git config.
  git(dir, ['config', 'user.email', 'blame-test@example.com'])
  git(dir, ['config', 'user.name', 'Test Author'])
  return dir
}

function writeAndCommit(dir: string, files: Record<string, string>, message: string): { sha: string; short: string } {
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', message])
  return { sha: git(dir, ['rev-parse', 'HEAD']), short: git(dir, ['rev-parse', '--short', 'HEAD']) }
}

const HTML = '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head>\n<body><div class="wrap"><div class="box">hi</div></div></body></html>'

const GOOD_CSS = '* { margin: 0; padding: 0; font-family: monospace; }\n.wrap { width: 200px; height: 100px; }\n.box { width: 180px; height: 50px; }\n'
const GOOD_CSS_2 = '* { margin: 0; padding: 0; font-family: monospace; }\n.wrap { width: 200px; height: 100px; background: #eee; }\n.box { width: 180px; height: 50px; }\n'
const BAD_CSS = '* { margin: 0; padding: 0; font-family: monospace; }\n.wrap { width: 200px; height: 100px; background: #eee; }\n.box { width: 400px; height: 50px; }\n'
const BAD_CSS_2 = '* { margin: 0; padding: 0; font-family: monospace; }\n.wrap { width: 200px; height: 100px; background: #eee; }\n.box { width: 400px; height: 50px; background: tomato; }\n'

// commit1 good -> commit2 unrelated -> commit3 introduces the bleed -> commit4 (=HEAD) unrelated
function buildRegressionRepo(prefix = ''): { dir: string; culprit: { sha: string; short: string } } {
  const dir = initRepo()
  writeAndCommit(dir, { [`${prefix}index.html`]: HTML, [`${prefix}styles.css`]: GOOD_CSS }, 'add page')
  writeAndCommit(dir, { [`${prefix}styles.css`]: GOOD_CSS_2 }, 'tweak wrap background')
  const culprit = writeAndCommit(dir, { [`${prefix}styles.css`]: BAD_CSS }, 'widen box')
  writeAndCommit(dir, { [`${prefix}styles.css`]: BAD_CSS_2 }, 'tweak box color')
  return { dir, culprit }
}

// (a) blame names the culprit commit, with subject/date/author, and exits 1
test('blame names the commit that introduced the bleed, with subject and author, exit 1', async () => {
  const { dir, culprit } = buildRegressionRepo()
  const err = await cli('blame', '--root', dir, '--page', 'index.html').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout).toContain(`broken by ${culprit.short} "widen box"`)
  expect(err.stdout).toContain('Test Author')
  expect(err.stdout).toContain('parent-bleed')
  expect(err.stdout).toContain('violations introduced:')
  // layout delta: div.box widened 180px -> 400px between the good and bad commit
  expect(err.stdout).toMatch(/resized: .*div\.box 180x50→400x50/)
}, 90_000)

// (b) clean HEAD -> nothing to blame, exit 0
test('blame on a clean page prints "nothing to blame" and exits 0', async () => {
  const dir = initRepo()
  writeAndCommit(dir, { 'index.html': HTML, 'styles.css': GOOD_CSS }, 'add page')
  // cli() rejects on a non-zero exit — resolving here already proves exit 0.
  const { stdout } = await cli('blame', '--root', dir, '--page', 'index.html')
  expect(stdout.trim()).toBe('nothing to blame — page is clean')
}, 90_000)

// (c) every commit within the cap is still bad -> raise-max-commits message
test('blame within an exhausted --max-commits reports "still broken N commits back"', async () => {
  const dir = initRepo()
  const ALLBAD_1 = '* { margin: 0; padding: 0; } .wrap { width: 200px; height: 100px; } .box { width: 400px; height: 50px; }\n'
  const ALLBAD_2 = '* { margin: 0; padding: 0; } .wrap { width: 200px; height: 100px; background: #eee; } .box { width: 400px; height: 50px; }\n'
  const ALLBAD_3 = '* { margin: 0; padding: 0; } .wrap { width: 200px; height: 100px; background: #eee; } .box { width: 400px; height: 50px; background: tomato; }\n'
  writeAndCommit(dir, { 'index.html': HTML, 'styles.css': ALLBAD_1 }, 'initial (already broken)')
  writeAndCommit(dir, { 'styles.css': ALLBAD_2 }, 'unrelated tweak 1')
  writeAndCommit(dir, { 'styles.css': ALLBAD_3 }, 'unrelated tweak 2')
  const err = await cli('blame', '--root', dir, '--page', 'index.html', '--max-commits', '2').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout.trim()).toBe('still broken 2 commits back — raise --max-commits')
}, 90_000)

// (c2) when the walk reaches the END of history (fewer commits exist than the cap) and
// EVERY one is still bad, raising --max-commits can't help — there's no more history to
// walk — so the message must say so instead of suggesting a cap raise that would do nothing.
test('blame that walks its entire (short) history and finds it always broken says so, not "raise --max-commits"', async () => {
  const dir = initRepo()
  const ALLBAD_1 = '* { margin: 0; padding: 0; } .wrap { width: 200px; height: 100px; } .box { width: 400px; height: 50px; }\n'
  const ALLBAD_2 = '* { margin: 0; padding: 0; } .wrap { width: 200px; height: 100px; background: #eee; } .box { width: 400px; height: 50px; }\n'
  writeAndCommit(dir, { 'index.html': HTML, 'styles.css': ALLBAD_1 }, 'initial (already broken)')
  writeAndCommit(dir, { 'styles.css': ALLBAD_2 }, 'unrelated tweak')
  // default --max-commits (25) is well beyond this repo's 2-commit history
  const err = await cli('blame', '--root', dir, '--page', 'index.html').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout.trim()).toBe('the page was never good in this history')
}, 90_000)

// plumbing: blame's --root/--page branch runs before the generic numeric-flag validation
// every other command gets — --port must be checked there too, same as --max-commits.
test('blame rejects a non-numeric --port with exit 2, no Chrome touched', async () => {
  const dir = initRepo()
  writeAndCommit(dir, { 'index.html': HTML, 'styles.css': GOOD_CSS }, 'add page')
  const err = await cli('blame', '--root', dir, '--page', 'index.html', '--port', 'nope').catch((e) => e)
  expect(err.code).toBe(2)
  expect(err.stderr).toContain("--port must be a number, got 'nope'")
}, 20_000)

// (d) safety: the throwaway repo's HEAD, branch, index, and working tree are byte-identical
// after a blame run, and no worktree is left registered.
test('a blame run never touches the repo\'s HEAD, branch, index, or working tree, and leaves no worktree behind', async () => {
  const { dir } = buildRegressionRepo()
  const before = {
    head: git(dir, ['rev-parse', 'HEAD']),
    branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    status: git(dir, ['status', '--porcelain']),
    log: git(dir, ['log', '--oneline']),
  }

  await cli('blame', '--root', dir, '--page', 'index.html').catch((e) => e)

  const after = {
    head: git(dir, ['rev-parse', 'HEAD']),
    branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    status: git(dir, ['status', '--porcelain']),
    log: git(dir, ['log', '--oneline']),
  }
  expect(after).toEqual(before)
  expect(before.status).toBe('') // sanity: nothing was ever dirty to begin with

  const worktrees = git(dir, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '))
  expect(worktrees).toHaveLength(1) // only the repo's own primary worktree remains
}, 90_000)

// self-review: works when --root is a subdirectory of the repo (git -C must find the toplevel)
test('blame works when --root is a subdirectory of the repo', async () => {
  const { dir, culprit } = buildRegressionRepo('site/')
  const err = await cli('blame', '--root', join(dir, 'site'), '--page', 'index.html').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout).toContain(`broken by ${culprit.short} "widen box"`)
}, 90_000)

// (e) MCP mirror of (a) — single-process spawn, matching mcp.test.ts's own pattern.
const mcpClient = new Client({ name: 'blame-test', version: '0' })
await mcpClient.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp.ts'] }))
afterAll(async () => { await mcpClient.close() })

test('blame tool (MCP) mirrors the CLI: names the culprit commit', async () => {
  const { dir, culprit } = buildRegressionRepo()
  const res = await mcpClient.callTool({ name: 'blame', arguments: { root: dir, page: 'index.html' } })
  const text = (res.content as any)[0].text
  expect(text).toContain(`broken by ${culprit.short} "widen box"`)
  expect(text).toContain('parent-bleed')
}, 90_000)

// --- interrupt / honesty hardening ---

// blame's scratch checkout dirs (bettercss-blame-XXXXXX), NOT the throwaway test repos
// (bettercss-blame-repo-XXXXXX) this file creates itself.
function scratchDirs(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((d) => d.startsWith('bettercss-blame-') && !d.startsWith('bettercss-blame-repo-')))
}

// SIGINT mid-walk (CLI): everything the walk created must be gone — no registered
// worktrees, no scratch dir, no orphaned Chrome — and the exit code is 130.
test('SIGINT mid-walk cleans worktrees, scratch dir, and Chrome, exiting 130', async () => {
  const { dir } = buildRegressionRepo()
  const pidsBefore = chromePids()
  const scratchBefore = scratchDirs()

  // Single-process spawn (no npx→tsx chain) so the signal reaches the CLI itself.
  // BETTERCSS_DEBUG_SHUTDOWN: the child's doShutdown narrates each phase to stderr, and
  // the leak assertion below includes that stderr — a CI-only failure arrives self-explaining.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'blame', '--root', dir, '--page', 'index.html'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BETTERCSS_DEBUG_SHUTDOWN: '1' } })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d.toString() })
  // git prints "Preparing worktree" to stderr as each historical checkout starts —
  // the walk is provably mid-flight once it appears.
  const deadline = Date.now() + 30_000
  while (!stderr.includes('Preparing worktree') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  expect(stderr).toContain('Preparing worktree')
  child.kill('SIGINT')
  const code = await new Promise<number | null>((r) => child.on('close', (c) => r(c)))
  expect(code).toBe(130)

  // no worktree left registered in the repo
  const worktrees = git(dir, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '))
  expect(worktrees).toHaveLength(1)
  // no scratch checkout dir left in tmp
  expect([...scratchDirs()].filter((d) => !scratchBefore.has(d))).toEqual([])
  // no NEW Chrome tree left behind (teardown is asynchronous — poll like mcp.test.ts).
  // Assert on the FULL ps lines, not bare pids, so a CI-only failure names the survivors.
  const chromeDeadline = Date.now() + 15_000
  while ([...chromePids()].some((p) => !pidsBefore.has(p)) && Date.now() < chromeDeadline) {
    await new Promise((r) => setTimeout(r, 250))
  }
  const survivors = chromeProcessLines().filter((l) => !pidsBefore.has(l.split(/\s+/)[0]))
  expect(survivors, `child stderr (shutdown telemetry):\n${stderr}`).toEqual([])
}, 90_000)

// SIGINT to the MCP server AFTER a blame call completed: blame's handler must be disarmed
// by then, so only mcp.ts's graceful shutdown runs — exit 0, no Chrome debris.
test('MCP server still shuts down gracefully (exit 0, no Chrome) on SIGINT after a blame call', async () => {
  const dir = initRepo()
  writeAndCommit(dir, { 'index.html': HTML, 'styles.css': GOOD_CSS }, 'add page')
  const pidsBefore = chromePids()

  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp.ts'] })
  const client = new Client({ name: 'blame-sigint-test', version: '0' })
  await client.connect(transport)
  // NOTE: reaches into the SDK transport's private _process — the only way to observe the
  // server's actual exit code (the public API only surfaces onclose, not the code).
  const proc = (transport as any)._process
  const exited = new Promise<number | null>((r) => proc.on('close', (c: number | null) => r(c)))

  const res = await client.callTool({ name: 'blame', arguments: { root: dir, page: 'index.html' } })
  expect((res.content as any)[0].text).toContain('nothing to blame')

  process.kill(transport.pid!, 'SIGINT')
  expect(await exited).toBe(0)

  const chromeDeadline = Date.now() + 15_000
  while ([...chromePids()].some((p) => !pidsBefore.has(p)) && Date.now() < chromeDeadline) {
    await new Promise((r) => setTimeout(r, 250))
  }
  expect([...chromePids()].filter((p) => !pidsBefore.has(p))).toEqual([])
}, 90_000)

// A page referencing a resource OUTSIDE --root (../shared.css) 404s silently in every
// comparison — blame must warn instead of confidently reporting a clean/wrong verdict.
test('a linked resource outside --root produces a prominent warning, not a silent false verdict', async () => {
  const dir = initRepo()
  const html = '<!doctype html><html><head><link rel="stylesheet" href="../shared.css"></head>\n<body><div class="wrap"><div class="box">hi</div></div></body></html>'
  writeAndCommit(dir, { 'shared.css': GOOD_CSS, 'site/index.html': html }, 'add page')
  const { stdout } = await cli('blame', '--root', join(dir, 'site'), '--page', 'index.html')
  expect(stdout).toContain('warning: 1 linked resources failed to load from --root')
  expect(stdout).toContain('/shared.css')
  expect(stdout).toContain('point --root at the repo root')
}, 90_000)

// Disk-state bad but HEAD's COMMITTED state clean: the breakage is uncommitted — blame
// must say so instead of framing the innocent newest commit.
test('uncommitted breakage blames the working tree, not an innocent commit', async () => {
  const dir = initRepo()
  writeAndCommit(dir, { 'index.html': HTML, 'styles.css': GOOD_CSS }, 'add page')
  writeAndCommit(dir, { 'styles.css': GOOD_CSS_2 }, 'innocent tweak')
  writeFileSync(join(dir, 'styles.css'), BAD_CSS) // the actual breakage, never committed

  const err = await cli('blame', '--root', dir, '--page', 'index.html').catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout).toContain('broken by uncommitted changes in your working tree (not any commit)')
  expect(err.stdout).toContain('note: working tree has uncommitted changes')
  expect(err.stdout).not.toContain('innocent tweak') // no commit framed
}, 90_000)
