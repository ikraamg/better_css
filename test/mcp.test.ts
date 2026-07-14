import { afterAll, expect, test } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { serveFixtures } from './helpers/server.js'

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
