import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.map': 'application/json',
}

// Minimal static file server — moved here (from test/helpers/server.ts, which now just
// re-exports it) so blame.ts can serve each historical git-worktree checkout from src/
// without src importing from test/ (rootDir is src; see tsconfig.json).
export async function serveFixtures(root: string): Promise<{ url: string; close(): void }> {
  const server = createServer(async (req, res) => {
    try {
      const path = normalize(decodeURIComponent(new URL(req.url!, 'http://x').pathname))
      const body = await readFile(join(root, path))
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
}
