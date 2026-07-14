import { afterAll, expect, test } from 'vitest'
import { execSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { serveFixtures } from './helpers/server.js'

function chromeLeaked(): boolean {
  // pgrep exits 1 (no match) once shutdownChrome has killed the headless Chrome
  // and removed its bettercss-* temp profile dir; exits 0 while it's still alive.
  try { execSync('pgrep -f "bettercss-"', { stdio: 'pipe' }); return true }
  catch { return false }
}

const srv = await serveFixtures('fixtures')
const client = new Client({ name: 'test', version: '0' })
await client.connect(new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp.ts'] }))
afterAll(async () => { await client.close(); srv.close() })

test('lists all six tools', async () => {
  const { tools } = await client.listTools()
  expect(tools.map((t) => t.name).sort())
    .toEqual(['check', 'diff', 'explain', 'inspect', 'layout', 'snapshot'])
})

test('layout tool returns the tree', async () => {
  const res = await client.callTool({ name: 'layout', arguments: { url: `${srv.url}/basic/index.html` } })
  const text = (res.content as any)[0].text
  expect(text).toContain('header#top (0,0 1280x64)')
}, 60_000)

test('explain tool traces cascade', async () => {
  const res = await client.callTool({
    name: 'explain',
    arguments: { url: `${srv.url}/cascade/index.html`, selector: '.sidebar', property: 'width' },
  })
  expect((res.content as any)[0].text).toContain('✓ width: 300px')
}, 60_000)

test('check tool reports violations', async () => {
  const res = await client.callTool({ name: 'check', arguments: { url: `${srv.url}/overflow-h/index.html` } })
  expect((res.content as any)[0].text).toContain('viewport-overflow')
}, 60_000)

test('shuts down its headless Chrome subprocess when the MCP session closes', async () => {
  await client.close()
  // client.close() ends stdin, waits up to 2s for a natural exit, then SIGTERMs the
  // server if it's still alive — give shutdownChrome's proc.kill() + rmSync a moment to land.
  await new Promise((r) => setTimeout(r, 500))
  expect(chromeLeaked()).toBe(false)
}, 60_000)
