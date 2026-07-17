// Moved to src/core/serve.ts (src can't import from test/ — rootDir is src) so
// blame.ts can reuse the exact same static server. Re-exported here so every existing
// test import (`from './helpers/server.js'`) keeps working unchanged.
export { serveFixtures } from '../../src/core/serve.js'

import { execSync } from 'node:child_process'

// Chrome trees launched by bettercss (the [b] character class keeps this grep's own
// argv, or an operator's shell prompt, from matching its own pattern). Shared by every
// test file that polls for a leaked/orphaned Chrome process around a SIGINT/SIGTERM test.
export function chromePids(): Set<string> {
  try {
    return new Set(
      execSync('ps -eo pid,args | grep "user-data-dir=.*[b]ettercss-" | grep -v grep', { stdio: 'pipe' })
        .toString().trim().split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/)[0]),
    )
  } catch { return new Set() }
}
