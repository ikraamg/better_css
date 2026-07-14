import { afterAll, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { explain } from '../src/core/explain.js'
import { parseSourceMap, originalPosition } from '../src/core/sourcemap.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

test('decodes VLQ mappings from the committed map', () => {
  const map = parseSourceMap(readFileSync('fixtures/sourcemap/built.css.map', 'utf8'))
  expect(map.sources.some((s) => s.includes('input.css'))).toBe(true)
  // minified output is one line; color decl maps back to input.css line 5
  const pos = originalPosition(map, 0, 20) // any column inside the h1 rule
  expect(pos?.source).toContain('input.css')
})

test('decodes negative VLQ deltas across multiple generated lines', () => {
  // hand-built map: line0 -> src line 10 (0-idx), line1 -> src line 7 via a -3 delta
  const map = parseSourceMap(JSON.stringify({
    version: 3, sources: ['a.css'], mappings: 'AAUA;AAHA',
  }))
  expect(originalPosition(map, 0, 0)?.line).toBe(11)
  expect(originalPosition(map, 1, 0)?.line).toBe(8)
})

test('malformed mappings throw instead of hanging', () => {
  // '=' is outside the base64 alphabet; pre-fix this infinite-looped.
  // The test completing at all is the real assertion — the throw feeds
  // loadMap's try/catch, which caches null and keeps generated positions.
  expect(() => parseSourceMap(JSON.stringify({
    version: 3, sources: ['a.css'], mappings: 'AAAA,=;AACA',
  }))).toThrow(/malformed VLQ/)
  // truncated continuation digit (bit 32 set, then end-of-string) also throws
  expect(() => parseSourceMap(JSON.stringify({
    version: 3, sources: ['a.css'], mappings: 'g',
  }))).toThrow(/malformed VLQ/)
})

test('parses a base64-decoded data-URI payload', () => {
  // exercises the decode half of loadMap's data: branch; URL resolution
  // inside loadMap itself remains covered only by review (not exported)
  const b64 = Buffer.from(JSON.stringify({ version: 3, sources: ['x.css'], mappings: 'AAAA' })).toString('base64')
  const map = parseSourceMap(Buffer.from(b64, 'base64').toString())
  expect(originalPosition(map, 0, 0)?.source).toBe('x.css')
})

test('explain resolves through the source map to input.css', async () => {
  const e = await withPage(`${srv.url}/sourcemap/index.html`, (c) => explain(c, 'h1', 'color'))
  const winner = e.entries.find((x) => x.status === 'winner')!
  expect(winner.file).toContain('input.css')
  expect(winner.line).toBe(5) // the color declaration's line in the ORIGINAL file
})
