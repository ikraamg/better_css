import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { violationKey, type Violation } from './invariants.js'

// Field #6: the identity key a baseline file accepts violations by — the SAME (rule,
// selector) identity invariants.ts's violationKey/renderViolations grouping already use
// (px excluded: it drifts run to run), optionally scoped to a viewport label. The label is
// present only when the run producing this key was a matrix (checkMatrix/verifyMatrix, or
// `baseline --viewports`) — a plain single-page capture has no viewport concept to key on.
// Pairing a baseline with a matrix run therefore requires the SAME viewport(s) on both
// sides; pairing with a non-matrix run requires neither side pass --viewports.
export function baselineKey(label: string | undefined, v: Violation): string {
  return label ? `[${label}] ${violationKey(v)}` : violationKey(v)
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
