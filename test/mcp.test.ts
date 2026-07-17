import { afterAll, expect, test } from 'vitest'
import { execSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { serveFixtures } from './helpers/server.js'

function leakedProcesses(): string {
  // Empty once shutdownChrome has killed the headless Chrome tree. On failure
  // the PID/PPID/args triple names the culprit AND its parent (ppid 1 = orphan).
  //
  // Matches the actual leaked-Chrome signature — `--user-data-dir=<tmpdir>/csstruth-*`
  // (connect.ts's launchChrome) — not a bare "csstruth-" substring: an operator's own
  // resident shell can easily have that substring in its command line too (a `cd
  // .../csstruth` prompt, another agent session's command mentioning a `csstruth-`
  // test dir prefix, ...), which a bare pattern would misreport as a leak. The [c]
  // character class still keeps the pattern from matching this grep's own argv.
  try {
    return execSync('ps -eo pid,ppid,args | grep "user-data-dir=.*[c]sstruth-" | grep -v grep', { stdio: 'pipe' })
      .toString().trim()
  } catch { return '' }
}
function chromeLeaked(): boolean {
  return leakedProcesses() !== ''
}

const srv = await serveFixtures('fixtures')
const client = new Client({ name: 'test', version: '0' })
// Single-process spawn (no npx→tsx chain): the SDK's shutdown signals target the
// spawned pid, and a chain head dying orphans the real server with stdin still
// open — it then never sees the close and leaks its Chrome (seen on Linux CI).
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp.ts'] }))
afterAll(async () => { await client.close(); srv.close() })

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

test('lists all ten tools', async () => {
  const { tools } = await client.listTools()
  expect(tools.map((t) => t.name).sort())
    .toEqual(['blame', 'check', 'diff', 'explain', 'fix', 'inspect', 'layout', 'snapshot', 'stability', 'verify'])
})

test('layout tool returns the tree', async () => {
  const res = await client.callTool({ name: 'layout', arguments: { url: `${srv.url}/basic/index.html` } })
  const text = (res.content as any)[0].text
  expect(text).toContain('header#top (0,0 1280x64)')
}, 60_000)

test('layout tool accepts a viewport override', async () => {
  const res = await client.callTool({
    name: 'layout',
    arguments: { url: `${srv.url}/basic/index.html`, viewport: '500x800' },
  })
  expect((res.content as any)[0].text).toContain('body (0,0 500x')
}, 60_000)

test('layout tool defaults to the 400-line budget on a deep tree, with a truncation note', async () => {
  const res = await client.callTool({ name: 'layout', arguments: { url: `${srv.url}/deep/index.html` } })
  const text = (res.content as any)[0].text
  const lines = text.split('\n')
  expect(lines.length).toBeLessThanOrEqual(400)
  expect(text).toContain('truncated to depth')
}, 60_000)

test('explain tool traces cascade', async () => {
  const res = await client.callTool({
    name: 'explain',
    arguments: { url: `${srv.url}/cascade/index.html`, selector: '.sidebar', property: 'width' },
  })
  expect((res.content as any)[0].text).toContain('✓ width: 300px')
}, 60_000)

test('check tool reports violations with a suspect rule', async () => {
  const res = await client.callTool({ name: 'check', arguments: { url: `${srv.url}/overflow-h/index.html` } })
  const text = (res.content as any)[0].text
  expect(text).toContain('viewport-overflow')
  expect(text).toMatch(/suspect: width: 1400px/)
}, 60_000)

test('check tool with hover param forces the state and surfaces the parent-bleed', async () => {
  const clean = await client.callTool({ name: 'check', arguments: { url: `${srv.url}/hover/index.html` } })
  expect((clean.content as any)[0].text).toContain('no violations')

  const res = await client.callTool({ name: 'check', arguments: { url: `${srv.url}/hover/index.html`, hover: '.cta' } })
  const text = (res.content as any)[0].text
  expect(text).toContain('parent-bleed')
  expect(text).toContain('100px')
}, 60_000)

test('check tool with viewports + hover forces the state inside each viewport (mirrors the CLI)', async () => {
  const res = await client.callTool({
    name: 'check',
    arguments: { url: `${srv.url}/hover/index.html`, viewports: '1280x800,600x800', hover: '.cta' },
  })
  const text = (res.content as any)[0].text
  expect(text).toMatch(/\[1280x800\] parent-bleed: a\.cta/)
  expect(text).toContain('[600x800] no violations')
  expect(text).not.toMatch(/\[600x800\] parent-bleed/)
  expect(text).toContain('checked 2 viewports: 1280x800=1 violations, 600x800=clean')
}, 60_000)

test('check tool with viewports checks each viewport and prefixes violations with [WxH]', async () => {
  const res = await client.callTool({
    name: 'check',
    arguments: { url: `${srv.url}/responsive/index.html`, viewports: '1280x800,600x800' },
  })
  const text = (res.content as any)[0].text
  expect(text).toContain('[600x800] viewport-overflow')
  expect(text).not.toMatch(/\[1280x800\] viewport-overflow/)
  expect(text).toContain('checked 2 viewports: 1280x800=clean, 600x800=2 violations')
}, 60_000)

test('snapshot/diff tools with viewports round-trip per-viewport snapshots', async () => {
  const dir = tmpDir('csstruth-mcp-test-')
  await client.callTool({
    name: 'snapshot',
    arguments: { url: `${srv.url}/responsive/index.html`, viewports: '1280x800,600x800', name: 'resp', dir },
  })
  const res = await client.callTool({
    name: 'diff',
    arguments: { url: `${srv.url}/responsive/index.html`, viewports: '1280x800,600x800', name: 'resp', dir },
  })
  const text = (res.content as any)[0].text
  expect(text).toContain('[1280x800] (no layout changes)')
  expect(text).toContain('[600x800] (no layout changes)')
}, 60_000)

test('verify tool returns verdict-first output for the basic fixture', async () => {
  // Pinned to 1280x800: the basic fixture bleeds ~7px at the default sweep's 375px viewport
  // (a CSS-grid min-width:auto quirk unrelated to verify) — 1280x800 is where it's clean.
  const res = await client.callTool({ name: 'verify', arguments: { url: `${srv.url}/basic/index.html`, viewports: '1280x800' } })
  const text = (res.content as any)[0].text
  expect(text.split('\n')[0]).toBe('VERDICT: PASS')
})

test('check tool with click param opens the interactive fixture\'s menu and surfaces the parent-bleed', async () => {
  const clean = await client.callTool({ name: 'check', arguments: { url: `${srv.url}/interactive/index.html` } })
  expect((clean.content as any)[0].text).toContain('no violations')

  const res = await client.callTool({ name: 'check', arguments: { url: `${srv.url}/interactive/index.html`, click: ['#menu-btn'] } })
  const text = (res.content as any)[0].text
  expect(text).toContain('parent-bleed')
  expect(text).toContain('bleeds 100px outside div.wrap')
}, 60_000)

test('check tool with scrollTo param scrolls past the fixture\'s threshold and surfaces the tap-target violation', async () => {
  const res = await client.callTool({ name: 'check', arguments: { url: `${srv.url}/interactive/index.html`, scrollTo: '500' } })
  const text = (res.content as any)[0].text
  expect(text).toContain('tap-target')
  expect(text).toContain('16x16px')
}, 60_000)

test('layout tool with settled fast-forwards the transition to its end width', async () => {
  const res = await client.callTool({ name: 'layout', arguments: { url: `${srv.url}/animated/index.html`, settled: true } })
  expect((res.content as any)[0].text).toContain('div#target.child.grow (0,0 400x50)')
})

test('layout tool rejects settled+atTime together with a clear error', async () => {
  const res = await client.callTool({ name: 'layout', arguments: { url: `${srv.url}/animated/index.html`, settled: true, atTime: 0 } })
  expect(res.isError).toBe(true)
  expect((res.content as any)[0].text).toContain('mutually exclusive')
})

test('layout tool rejects settled+atTime before ever loading the page (cheap pre-check, no wasted page load)', async () => {
  let hit = false
  const decoy = createServer((_req, res) => { hit = true; res.end('<html></html>') })
  await new Promise<void>((resolve) => decoy.listen(0, '127.0.0.1', resolve))
  const { port } = decoy.address() as { port: number }
  try {
    const res = await client.callTool({ name: 'layout', arguments: { url: `http://127.0.0.1:${port}/`, settled: true, atTime: 0 } })
    expect(res.isError).toBe(true)
    expect((res.content as any)[0].text).toContain('mutually exclusive')
    expect(hit).toBe(false)
  } finally {
    decoy.close()
  }
})

test('snapshot/diff tools with settled round-trip a clean diff on the animated fixture', async () => {
  const dir = tmpDir('csstruth-mcp-settled-test-')
  await client.callTool({ name: 'snapshot', arguments: { url: `${srv.url}/animated/index.html`, name: 'anim', dir, settled: true } })
  const res = await client.callTool({ name: 'diff', arguments: { url: `${srv.url}/animated/index.html`, name: 'anim', dir, settled: true } })
  expect((res.content as any)[0].text).toContain('(no layout changes)')
})

test('verify tool with name diffs the resting layout and notes a missing per-viewport snapshot', async () => {
  const dir = tmpDir('csstruth-verify-mcp-test-')
  await client.callTool({
    name: 'snapshot',
    arguments: { url: `${srv.url}/responsive/index.html`, viewports: '1280x800', name: 'v', dir },
  })
  const res = await client.callTool({
    name: 'verify',
    arguments: { url: `${srv.url}/responsive/index.html`, viewports: '1280x800', name: 'nope', dir },
  })
  const text = (res.content as any)[0].text
  expect(text.split('\n')[0]).toBe('VERDICT: PASS')
  expect(text).toContain("note: no snapshot 'nope@1280x800' — diff skipped for this viewport")
}, 60_000)

test('snapshot tool rejects click with a clear error instead of silently ignoring it', async () => {
  const res = await client.callTool({ name: 'snapshot', arguments: { url: `${srv.url}/interactive/index.html`, name: 'x', click: ['#menu-btn'] } })
  expect(res.isError).toBe(true)
  expect((res.content as any)[0].text).toContain('--click/--scroll-to are only valid for layout/inspect/explain/check/verify, not snapshot')
})

test('diff tool rejects atTime with a clear error instead of silently ignoring it', async () => {
  const res = await client.callTool({ name: 'diff', arguments: { url: `${srv.url}/animated/index.html`, name: 'x', atTime: 0 } })
  expect(res.isError).toBe(true)
  expect((res.content as any)[0].text).toContain('--at-time is not valid for diff')
})

test('stability tool rejects viewports with a clear error instead of silently ignoring it', async () => {
  const res = await client.callTool({ name: 'stability', arguments: { url: `${srv.url}/basic/index.html`, viewports: '600x800,1280x800' } })
  expect(res.isError).toBe(true)
  expect((res.content as any)[0].text).toContain('--viewports is not valid for stability')
})

test('stability tool reports the shifty fixture\'s shift, timing, and suspect, exceeding the default threshold', async () => {
  const res = await client.callTool({
    name: 'stability',
    arguments: { url: `${srv.url}/shifty/index.html`, viewport: '400x800' },
  })
  const text = (res.content as any)[0].text
  expect(text.split('\n')[0]).toMatch(/^STABILITY: 0\.\d+/)
  expect(text).toMatch(/\[\+[2-4]\d\d\] img\.photo moved \(0,0\)→\(0,200\) score 0\.\d+/)
  expect(text).toContain('suspect: img.photo has no intrinsic size attributes')
}, 20_000)

test('stability tool reports zero score on the fluid fixture (no shifts)', async () => {
  const res = await client.callTool({
    name: 'stability',
    arguments: { url: `${srv.url}/fluid/index.html`, duration: 500 },
  })
  expect((res.content as any)[0].text).toBe('STABILITY: 0 (threshold 0.1)')
}, 20_000)

// (f) MCP fix with apply=false returns patches, never writes
test('fix tool with apply=false (the default) returns patches and never writes', async () => {
  const cssPath = 'fixtures/fixable/styles.css'
  const before = readFileSync(cssPath, 'utf8')
  const res = await client.callTool({
    name: 'fix',
    arguments: { url: `${srv.url}/fixable/index.html`, root: 'fixtures' },
  })
  const text = (res.content as any)[0].text
  expect(text).toContain('text-clip')
  expect(text).toContain('tap-target')
  expect(text).toContain('parent-bleed')
  expect(readFileSync(cssPath, 'utf8')).toBe(before)
}, 60_000)

test('fix tool without root is rejected by the schema (root is required)', async () => {
  const res = await client.callTool({ name: 'fix', arguments: { url: `${srv.url}/fixable/index.html` } })
  expect(res.isError).toBe(true)
})

test('shuts down its headless Chrome subprocess when the MCP session closes', async () => {
  await client.close()
  // client.close() ends stdin, waits up to 2s for a natural exit, then SIGTERMs the
  // server if it's still alive. Process teardown is asynchronous (and slower on Linux
  // CI than macOS), so poll for the invariant — eventually no Chrome — with a deadline.
  const deadline = Date.now() + 15_000
  while (chromeLeaked() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
  }
  expect(leakedProcesses(), 'processes still matching csstruth-').toBe('')
}, 60_000)
