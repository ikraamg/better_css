import { expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  aggregateBaselineSummary, baselineKey, diffBaseline, loadBaselineFile,
  renderBaselineNote, renderBaselineUpdate, writeBaselineFile,
} from '../src/core/baseline.js'
import { groupingKey, type Violation } from '../src/core/invariants.js'

function v(rule: Violation['rule'], selector: string, px?: number): Violation {
  return { rule, selector, message: '', backendNodeId: 0, px }
}

test('baselineKey: px excluded, label optional', () => {
  expect(baselineKey(undefined, v('parent-bleed', 'a.cta', 100))).toBe('parent-bleed a.cta')
  expect(baselineKey('1280x800', v('parent-bleed', 'a.cta', 100))).toBe('[1280x800] parent-bleed a.cta')
})

// Critical fix: baselineKey MUST match renderViolations' grouping key exactly, which strips
// the #id (three id-distinct instances of one pattern are one signal, not three). Before the
// fix baselineKey kept the id, so id-bearing selectors never collapsed against a baseline.
test('baselineKey strips the #id, matching the display grouping key', () => {
  expect(baselineKey(undefined, v('tap-target', 'a#vote-1.vote', 12))).toBe('tap-target a.vote')
  expect(baselineKey(undefined, v('tap-target', 'a#vote-9.vote', 12)))
    .toBe(baselineKey(undefined, v('tap-target', 'a#vote-1.vote', 12)))
  expect(baselineKey(undefined, v('tap-target', 'a#vote-1.vote', 12)))
    .toBe(groupingKey(v('tap-target', 'a#vote-1.vote', 12)))
})

test('diffBaseline: new/resolved/unchanged, scoped to one label at a time', () => {
  const baseline = new Set(['[1280x800] parent-bleed a.cta', '[600x800] tap-target button', 'parent-bleed a.cta'])
  const delta = diffBaseline(baseline, '1280x800', [v('parent-bleed', 'a.cta'), v('tap-target', 'button.small')])
  expect(delta.newViolations.map((x) => x.selector)).toEqual(['button.small'])
  expect(delta.addedKeys).toEqual(['[1280x800] tap-target button.small'])
  expect(delta.resolvedKeys).toEqual([]) // parent-bleed a.cta still present
  expect(delta.unchangedCount).toBe(1)
  expect(delta.currentKeys.sort()).toEqual(['[1280x800] parent-bleed a.cta', '[1280x800] tap-target button.small'])

  // [600x800]'s entry is a DIFFERENT viewport's baseline — irrelevant to the 1280x800 diff,
  // never surfaces as resolved just because this run didn't see it.
})

test('diffBaseline: everything baselined and gone -> resolved, nothing new', () => {
  const baseline = new Set(['parent-bleed a.cta'])
  const delta = diffBaseline(baseline, undefined, [])
  expect(delta.newViolations).toEqual([])
  expect(delta.resolvedKeys).toEqual(['parent-bleed a.cta'])
  expect(delta.unchangedCount).toBe(0)
})

test('renderBaselineNote: collapsed count + resolved lines, empty when nothing to say', () => {
  expect(renderBaselineNote({ newViolations: [], addedKeys: [], resolvedKeys: [], unchangedCount: 0, currentKeys: [] })).toBe('')
  expect(renderBaselineNote({ newViolations: [], addedKeys: [], resolvedKeys: [], unchangedCount: 1, currentKeys: [] }))
    .toBe('baseline: 1 accepted violation unchanged')
  expect(renderBaselineNote({ newViolations: [], addedKeys: [], resolvedKeys: [], unchangedCount: 3, currentKeys: [] }))
    .toBe('baseline: 3 accepted violations unchanged')
  expect(renderBaselineNote({ newViolations: [], addedKeys: [], resolvedKeys: ['[1280x800] parent-bleed a.cta'], unchangedCount: 0, currentKeys: [] }))
    .toBe('resolved: parent-bleed a.cta') // the [label] is stripped — the caller's own [label] block prefix already carries it
})

test('aggregateBaselineSummary + renderBaselineUpdate', () => {
  const summary = aggregateBaselineSummary([
    { newViolations: [], addedKeys: ['[1280x800] tap-target button'], resolvedKeys: [], unchangedCount: 1, currentKeys: ['[1280x800] parent-bleed a.cta', '[1280x800] tap-target button'] },
    { newViolations: [], addedKeys: [], resolvedKeys: ['[600x800] zero-size button'], unchangedCount: 0, currentKeys: [] },
  ])
  expect(summary.added).toEqual(['[1280x800] tap-target button'])
  expect(summary.removed).toEqual(['[600x800] zero-size button'])
  expect(summary.allCurrent).toEqual(['[1280x800] parent-bleed a.cta', '[1280x800] tap-target button'])
  expect(renderBaselineUpdate('.csstruth-baseline', summary)).toBe(
    'baseline updated: .csstruth-baseline (1 added, 1 removed)\n' +
    '  + [1280x800] tap-target button\n' +
    '  - [600x800] zero-size button',
  )
})

test('writeBaselineFile: sorted, deduped, deterministic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csstruth-baseline-unit-'))
  try {
    const file = join(dir, '.csstruth-baseline')
    writeBaselineFile(file, ['tap-target button', 'parent-bleed a.cta', 'parent-bleed a.cta'])
    expect(loadBaselineFile(file)).toEqual(new Set(['parent-bleed a.cta', 'tap-target button']))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeBaselineFile: empty violation set writes an empty file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csstruth-baseline-unit-'))
  try {
    const file = join(dir, '.csstruth-baseline')
    writeBaselineFile(file, [])
    expect(loadBaselineFile(file)).toEqual(new Set())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadBaselineFile: missing file throws a clear resolved-path error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csstruth-baseline-unit-'))
  try {
    const missing = join(dir, 'nope')
    expect(() => loadBaselineFile(missing))
      .toThrow(`No baseline file at ${resolve(missing)} — run 'csstruth baseline' first, or check the --file/--baseline path.`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
