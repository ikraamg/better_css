import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Viewport } from './connect.js'
import { groupingKey, type Violation } from './invariants.js'

// Field #6: the identity key a baseline file accepts violations by — groupingKey (px
// excluded: it drifts run to run; #id stripped: three id-distinct instances of the same
// pattern are one signal, not three), optionally scoped to a viewport label. Delegating to
// groupingKey — the SAME function renderViolations groups its display lines by — is load-
// bearing: a baseline keyed by anything else can silently stop matching what the grouped
// output shows on screen. The label is present only when the run producing this key was a
// matrix (checkMatrix/verifyMatrix, or `baseline --viewports`) — a plain single-page
// capture has no viewport concept to key on. Pairing a baseline with a matrix run
// therefore requires the SAME viewport(s) on both sides; pairing with a non-matrix run
// requires neither side pass --viewports (see baselineShapeWarning below for the loud
// safety net when that pairing is wrong).
export function baselineKey(label: string | undefined, v: Violation): string {
  return label ? `[${label}] ${groupingKey(v)}` : groupingKey(v)
}

export function writeBaselineFile(path: string, keys: string[]): void {
  const dir = dirname(path)
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true })
  const sorted = [...new Set(keys)].sort()
  writeFileSync(path, sorted.map((k) => `${k}\n`).join(''))
}

export function loadBaselineFile(path: string): Set<string> {
  try {
    return new Set(readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean))
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err
    throw new Error(`No baseline file at ${resolve(path)} — run 'csstruth baseline' first, or check the --file/--baseline path.`)
  }
}

export interface BaselineDelta {
  newViolations: Violation[] // present now, key not in the baseline — itemized, drive the verdict
  addedKeys: string[]        // same set as newViolations, as baseline keys (for --update-baseline)
  resolvedKeys: string[]     // in the baseline, key no longer present — itemized as "resolved:"
  unchangedCount: number     // present now AND in the baseline — collapsed to one count
  currentKeys: string[]      // every current violation's key (new + unchanged) — the full set
                              // --update-baseline rewrites the file to
}

// Splits `violations` (already persistence-filtered by the caller) against `baseline`,
// scoped to one viewport `label` (undefined for a non-matrix run) — the caller only ever
// hands us one viewport's own violations at a time, so only that label's own baseline
// entries are "relevant" here (another viewport's entries are simply never in the running).
export function diffBaseline(baseline: Set<string>, label: string | undefined, violations: Violation[]): BaselineDelta {
  const prefix = label ? `[${label}] ` : ''
  const relevant = [...baseline].filter((k) => (label ? k.startsWith(prefix) : !k.startsWith('[')))
  const keyed = violations.map((v) => ({ v, key: baselineKey(label, v) }))
  const currentSet = new Set(keyed.map((k) => k.key))
  const newEntries = keyed.filter(({ key }) => !baseline.has(key))
  return {
    newViolations: newEntries.map((e) => e.v),
    addedKeys: newEntries.map((e) => e.key),
    resolvedKeys: relevant.filter((k) => !currentSet.has(k)).sort(),
    unchangedCount: keyed.length - newEntries.length,
    currentKeys: keyed.map((k) => k.key),
  }
}

// "resolved: <rule> <selector>" — the [label] a resolved key carries is redundant here:
// the caller already wraps this whole block in its own [label] prefix (prefixLines in
// matrix.ts/verify.ts), so the note re-derives the bare rule+selector.
function stripLabel(key: string): string {
  return key.replace(/^\[[^\]]+\]\s/, '')
}

// Rendered under the itemized NEW violations (renderViolations output) for one viewport's
// block: the collapsed baseline count, then one "resolved:" line per fixed violation —
// celebrating the fix is the point (field #6's whole motivation). Empty string when there's
// nothing baseline-shaped to say (no --baseline, or nothing baselined/resolved).
export function renderBaselineNote(delta: BaselineDelta): string {
  const lines: string[] = []
  if (delta.unchangedCount > 0) {
    lines.push(`baseline: ${delta.unchangedCount} accepted violation${delta.unchangedCount === 1 ? '' : 's'} unchanged`)
  }
  for (const key of delta.resolvedKeys) lines.push(`resolved: ${stripLabel(key)}`)
  return lines.join('\n')
}

export interface BaselineSummary { added: string[]; removed: string[]; allCurrent: string[] }

// Aggregates every viewport's delta into one summary for --update-baseline: `allCurrent`
// (baselined ∪ new, i.e. exactly what's true right now) is what the file gets rewritten to.
export function aggregateBaselineSummary(deltas: BaselineDelta[]): BaselineSummary {
  return {
    added: deltas.flatMap((d) => d.addedKeys),
    removed: deltas.flatMap((d) => d.resolvedKeys),
    allCurrent: deltas.flatMap((d) => d.currentKeys),
  }
}

export function renderBaselineUpdate(file: string, summary: BaselineSummary): string {
  const lines = [`baseline updated: ${file} (${summary.added.length} added, ${summary.removed.length} removed)`]
  for (const k of summary.added) lines.push(`  + ${k}`)
  for (const k of summary.removed) lines.push(`  - ${k}`)
  return lines.join('\n')
}

// Shared by every --update-baseline call site (cli.ts and mcp.ts, ~6 in total): write the
// file, then render what changed. One place instead of a copy-pasted write+render pair at
// each of check/verify's single-page and matrix branches.
export function applyBaselineUpdate(file: string, summary: BaselineSummary): string {
  writeBaselineFile(file, summary.allCurrent)
  return renderBaselineUpdate(file, summary)
}

function shapeOf(viewports: Viewport[] | undefined): string {
  return viewports ? `--viewports ${viewports.map((v) => v.label).join(',')}` : 'no --viewports (single, unlabeled)'
}

// Loud safety net (field #6 follow-up): baselineKey's [label] prefix is present only when
// BOTH the baseline capture and the comparison run were matrices over the SAME labels —
// get that pairing wrong and every diffBaseline lookup misses silently (a labeled current
// key can never equal an unlabeled baseline key, or a differently-labeled one), reporting
// "100% new" instead of the mismatch it actually is. Catches the two shapes that can NEVER
// legitimately match: the baseline is entirely labeled but this run isn't a matrix (or vice
// versa), or the baseline's label set shares NOTHING with this run's viewports. A baseline
// that's only PARTIALLY labeled-overlapping (e.g. captured for one more/fewer viewport) is
// left alone — that's an ordinary partial baseline, not a shape mismatch.
export function baselineShapeWarning(baseline: Set<string>, viewports: Viewport[] | undefined): string {
  if (baseline.size === 0) return ''
  const labels = [...baseline].map((k) => k.match(/^\[([^\]]+)\]/)?.[1])
  const allLabeled = labels.every((l) => l !== undefined)
  const allUnlabeled = labels.every((l) => l === undefined)
  if (!allLabeled && !allUnlabeled) return '' // mixed file — not a shape this check reasons about
  const isMatrix = viewports !== undefined
  const currentLabels = new Set(viewports?.map((v) => v.label) ?? [])
  const disjoint = allLabeled && isMatrix && labels.every((l) => !currentLabels.has(l as string))
  if (allLabeled === isMatrix && !disjoint) return '' // shapes agree (both matrix or both single) and labels overlap
  const baselineShape = allLabeled ? `--viewports ${[...new Set(labels)].join(',')}` : 'no --viewports (single, unlabeled)'
  return `warning: baseline was captured with a different viewport configuration (baseline: ${baselineShape}; this run: ${shapeOf(viewports)}) — keys won't match; re-run baseline with the same --viewports`
}
