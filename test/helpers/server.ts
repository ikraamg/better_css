// Moved to src/core/serve.ts (src can't import from test/ — rootDir is src) so
// blame.ts can reuse the exact same static server. Re-exported here so every existing
// test import (`from './helpers/server.js'`) keeps working unchanged.
export { serveFixtures } from '../../src/core/serve.js'
