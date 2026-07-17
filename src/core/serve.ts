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
//
// `misses` records each distinct non-favicon path that 404'd — blame reads it to warn
// when a page's resources live outside the served root (a silent 404 in EVERY comparison
// would otherwise yield a confidently wrong verdict).
export async function serveFixtures(root: string): Promise<{ url: string; close(): void; misses: string[] }> {
  const misses: string[] = []
  const server = createServer(async (req, res) => {
    try {
      const path = normalize(decodeURIComponent(new URL(req.url!, 'http://x').pathname))
      const body = await readFile(join(root, path))
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      const path = new URL(req.url!, 'http://x').pathname
      if (path !== '/favicon.ico' && !misses.includes(path)) misses.push(path)
      res.writeHead(404)
      res.end('not found')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  // closeAllConnections: server.close() alone only stops accepting NEW connections —
  // an existing keep-alive socket stays open and can still serve requests until it
  // times out on its own, so a caller relying on close() to mean "gone now" (watch.ts's
  // dev-server-death test) needs every open socket torn down immediately too.
  return { url: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); server.close() }, misses }
}
