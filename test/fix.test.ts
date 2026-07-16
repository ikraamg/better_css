import { afterAll, expect, test } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { extract } from '../src/core/extract.js'
import { buildTree } from '../src/core/tree.js'
import { checkInvariants } from '../src/core/invariants.js'
import { applyFixes, buildFixes, renderFixes, resolveSuspectFile, type FixOutcome } from '../src/core/fix.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

async function fixesFor(path: string, root = 'fixtures') {
  const url = `${srv.url}${path}`
  return withPage(url, async (client) => {
    const violations = checkInvariants(buildTree(await extract(client)))
    return buildFixes(client, url, violations, root)
  })
}

const violationOf = (o: FixOutcome) => (o.kind === 'patch' ? o.patch.violation : o.violation)

const patchFor = (outcomes: FixOutcome[], rule: string) => {
  const o = outcomes.find((o) => violationOf(o).rule === rule)
  if (o?.kind !== 'patch') throw new Error(`expected a patch for ${rule}, got ${JSON.stringify(o)}`)
  return o.patch
}
const skipFor = (outcomes: FixOutcome[], rule: string) => {
  const o = outcomes.find((o) => violationOf(o).rule === rule)
  if (o?.kind !== 'skip') throw new Error(`expected a skip for ${rule}, got ${JSON.stringify(o)}`)
  return o
}

// (a) dry-run: one patch per fixable violation, correct file:line, nothing written
test('dry-run prints a patch per fixable violation with correct file:line and writes nothing', async () => {
  const cssPath = 'fixtures/fixable/styles.css'
  const beforeContent = readFileSync(cssPath, 'utf8')
  const beforeMtime = statSync(cssPath).mtimeMs

  const outcomes = await fixesFor('/fixable/index.html')
  expect(outcomes.filter((o) => o.kind === 'patch')).toHaveLength(3)

  const clip = patchFor(outcomes, 'text-clip')
  expect(clip.file).toBe(resolve(cssPath))
  expect(clip.line).toBe(3)
  expect(clip.after).toContain('text-overflow: ellipsis;')

  const tap = patchFor(outcomes, 'tap-target')
  expect(tap.line).toBe(2)
  expect(tap.after).toContain('min-width: 24px; min-height: 24px;')

  const bleed = patchFor(outcomes, 'parent-bleed')
  expect(bleed.line).toBe(5)
  expect(bleed.after).toContain('max-width: 100%; /* was: width: 400px */')

  const rendered = renderFixes(outcomes)
  expect(rendered).toContain(`${resolve(cssPath)}:3`)
  expect(rendered).toContain('- .clipper')
  expect(rendered).toContain('+ .clipper')

  // dry-run never writes — buildFixes only reads
  expect(readFileSync(cssPath, 'utf8')).toBe(beforeContent)
  expect(statSync(cssPath).mtimeMs).toBe(beforeMtime)
})

// (b) apply on a temp copy fixes text-clip
test('apply on a temp copy fixes text-clip: re-check shows it gone, css contains the ellipsis', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'bettercss-fix-apply-'))
  cpSync('fixtures/fixable', join(workDir, 'fixable'), { recursive: true })
  const tmpSrv = await serveFixtures(workDir)
  try {
    const url = `${tmpSrv.url}/fixable/index.html`
    const outcomes = await withPage(url, async (client) => {
      const violations = checkInvariants(buildTree(await extract(client)))
      return buildFixes(client, url, violations, workDir)
    })
    applyFixes(outcomes)

    const cssPath = join(workDir, 'fixable/styles.css')
    expect(readFileSync(cssPath, 'utf8')).toContain('text-overflow: ellipsis;')

    const after = await withPage(url, async (client) => checkInvariants(buildTree(await extract(client))))
    expect(after.some((v) => v.rule === 'text-clip')).toBe(false)
  } finally {
    tmpSrv.close()
  }
})

// (c) stale-source guard: the file at --root can legitimately be a different working copy
// than what's actually served (a concurrent local edit, a stale checkout, ...) — buildFixes
// must verify the suspect's declaration text against THAT file, at patch-build time, not
// just trust what Chrome analyzed. Serving one (clean) copy and pointing --root at a second,
// separately mutated copy isolates the guard from Chrome's own live source-text refetching,
// which (verified empirically) reflects the SERVED bytes, not a frozen-at-parse-time snapshot.
test('stale-source guard refuses a drifted patch only; other patches in the same file still apply', async () => {
  const served = mkdtempSync(join(tmpdir(), 'bettercss-fix-stale-served-'))
  cpSync('fixtures/fixable', join(served, 'fixable'), { recursive: true })
  const tmpSrv = await serveFixtures(served)

  const root = mkdtempSync(join(tmpdir(), 'bettercss-fix-stale-root-'))
  cpSync('fixtures/fixable', join(root, 'fixable'), { recursive: true })
  const rootCssPath = join(root, 'fixable/styles.css')
  // drift ONLY the .clipper rule's overflow value in the --root copy; .tiny-link and
  // .bleeder stay byte-identical to what's served
  const original = readFileSync(rootCssPath, 'utf8')
  writeFileSync(rootCssPath, original.replace('overflow: hidden; white-space: nowrap;', 'overflow: scroll; white-space: nowrap;'))

  try {
    const url = `${tmpSrv.url}/fixable/index.html`
    const outcomes = await withPage(url, async (client) => {
      const violations = checkInvariants(buildTree(await extract(client)))
      return buildFixes(client, url, violations, root)
    })

    const clipSkip = skipFor(outcomes, 'text-clip')
    expect(clipSkip.reason).toContain('stale source')

    // different lines in the SAME file — untouched by the drift, still resolve cleanly
    expect(patchFor(outcomes, 'tap-target')).toBeTruthy()
    expect(patchFor(outcomes, 'parent-bleed')).toBeTruthy()

    applyFixes(outcomes)
    const final = readFileSync(rootCssPath, 'utf8')
    // the drifted line is left exactly as it was — not reverted, not patched
    expect(final).toContain('overflow: scroll; white-space: nowrap;')
    expect(final).not.toContain('text-overflow: ellipsis')
    // the other two patches DID land
    expect(final).toContain('min-width: 24px; min-height: 24px;')
    expect(final).toContain('max-width: 100%; /* was: width: 400px */')
  } finally {
    tmpSrv.close()
  }
})

// (d, CLI-level) is covered in test/cli.test.ts; (f, MCP-level) in test/mcp.test.ts

// (e) px-width bleed patch: max-width:100% + comment, after-check improves
test('a fixed px-width parent-bleed patches to max-width:100% with the original kept as a comment', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'bettercss-fix-bleed-'))
  cpSync('fixtures/fixable', join(workDir, 'fixable'), { recursive: true })
  const tmpSrv = await serveFixtures(workDir)
  try {
    const url = `${tmpSrv.url}/fixable/index.html`
    const before = await withPage(url, async (client) => checkInvariants(buildTree(await extract(client))))
    expect(before.some((v) => v.rule === 'parent-bleed')).toBe(true)

    const outcomes = await withPage(url, async (client) => {
      const violations = checkInvariants(buildTree(await extract(client)))
      return buildFixes(client, url, violations, workDir)
    })
    const bleed = patchFor(outcomes, 'parent-bleed')
    expect(bleed.after).toContain('max-width: 100%;')
    expect(bleed.after).toContain('/* was: width: 400px */')
    applyFixes(outcomes)

    const after = await withPage(url, async (client) => checkInvariants(buildTree(await extract(client))))
    expect(after.some((v) => v.rule === 'parent-bleed')).toBe(false)
    expect(after.length).toBeLessThan(before.length)
  } finally {
    tmpSrv.close()
  }
})

test('a rule outside the fixable set reports "no mechanical fix" instead of a patch', async () => {
  const outcomes = await fixesFor('/zero-size/index.html')
  const zero = outcomes.find((o) => violationOf(o).rule === 'zero-size')!
  expect(zero.kind).toBe('skip')
  expect((zero as Extract<FixOutcome, { kind: 'skip' }>).reason).toContain('no mechanical fix for zero-size')
})

test('an inline style="" suspect is refused as not patchable, naming the page:line to hand-edit', async () => {
  const outcomes = await fixesFor('/tap/index.html')
  const tap = skipFor(outcomes, 'tap-target')
  expect(tap.reason).toContain('inline styles not patchable')
  expect(tap.reason).toContain('/tap/index.html:')
})

// Source-map handling: the suspect's file must resolve to the ORIGINAL source path from the
// map's sources[], not the generated/built stylesheet — and a patch must land there, not in
// the built file (editing the generated file would be overwritten by the next build).
test('a source-mapped suspect resolves and patches the ORIGINAL source file, not the built one', async () => {
  const outcomes = await fixesFor('/fixable-mapped/index.html')
  const patch = patchFor(outcomes, 'text-clip')
  expect(patch.file).toBe(resolve('fixtures/fixable-mapped/source.css'))
  expect(patch.line).toBe(3) // the `overflow: hidden;` line in the hand-authored (unminified) source
  expect(patch.after).toContain('text-overflow: ellipsis')

  const workDir = mkdtempSync(join(tmpdir(), 'bettercss-fix-mapped-'))
  cpSync('fixtures/fixable-mapped', join(workDir, 'fixable-mapped'), { recursive: true })
  const tmpSrv = await serveFixtures(workDir)
  try {
    const url = `${tmpSrv.url}/fixable-mapped/index.html`
    const mappedOutcomes = await withPage(url, async (client) => {
      const violations = checkInvariants(buildTree(await extract(client)))
      return buildFixes(client, url, violations, workDir)
    })
    applyFixes(mappedOutcomes)
    expect(readFileSync(join(workDir, 'fixable-mapped/source.css'), 'utf8')).toContain('text-overflow: ellipsis')
    // the generated file actually served to the browser is untouched — a source-map fix
    // patches the original, it does not (and cannot) rebuild
    expect(readFileSync(join(workDir, 'fixable-mapped/built.css'), 'utf8')).not.toContain('text-overflow')
  } finally {
    tmpSrv.close()
  }
})

// Safety bar: writes must never escape --root, however a stylesheet/source-map URL is crafted.
test('resolveSuspectFile never resolves outside root, even under an adversarial relative reference', () => {
  const root = mkdtempSync(join(tmpdir(), 'bettercss-fix-root-'))
  const rootAbs = resolve(root)

  // many levels of '..' from deep inside the sheet's URL path
  const deep = resolveSuspectFile('../../../../../../../../etc/passwd', `http://host/a/b/c/styles.css`, root)
  expect(deep === rootAbs || deep.startsWith(rootAbs + '/')).toBe(true)

  // an absolute cross-origin source reference — only the pathname is ever used
  const crossOrigin = resolveSuspectFile('http://evil.example/../../etc/passwd', 'http://host/fixable/built.css', root)
  expect(crossOrigin === rootAbs || crossOrigin.startsWith(rootAbs + '/')).toBe(true)

  // sanity: a benign relative reference resolves where expected, inside root
  const benign = resolveSuspectFile('sub/styles.css', 'http://host/app/index.css', root)
  expect(benign).toBe(join(rootAbs, 'app', 'sub', 'styles.css'))
})
