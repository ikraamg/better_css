// Moved to src/core/serve.ts (src can't import from test/ — rootDir is src) so
// blame.ts can reuse the exact same static server. Re-exported here so every existing
// test import (`from './helpers/server.js'`) keeps working unchanged.
export { serveFixtures } from '../../src/core/serve.js'

import { execSync } from 'node:child_process'

// Chrome trees launched by csstruth (the [c] character class keeps this grep's own
// argv, or an operator's shell prompt, from matching its own pattern). Shared by every
// test file that polls for a leaked/orphaned Chrome process around a SIGINT/SIGTERM test.
// Full `pid args` lines, so a failing leak assertion names the survivors (mirrors
// mcp.test.ts's leakedProcesses forensics).
export function chromeProcessLines(): string[] {
  try {
    return execSync('ps -eo pid,args | grep "user-data-dir=.*[c]sstruth-" | grep -v grep', { stdio: 'pipe' })
      .toString().trim().split('\n').filter(Boolean).map((l) => l.trim())
  } catch { return [] }
}

export function chromePids(): Set<string> {
  return new Set(chromeProcessLines().map((l) => l.split(/\s+/)[0]))
}
