import { afterAll, expect, test } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { shutdownChrome } from '../src/core/connect.js'

afterAll(async () => { await shutdownChrome() })

const run = promisify(execFile)
const cli = (...args: string[]) => run('npx', ['tsx', 'src/cli.ts', ...args], { encoding: 'utf8' })

// --- throwaway git repo helper (NEVER the project repo — always a fresh temp dir) ---

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bettercss-blame-repo-'))
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
