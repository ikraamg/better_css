import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve as resolvePath, sep } from 'node:path'
import { explain, type CascadeEntry } from './explain.js'
import type { Violation } from './invariants.js'

// Rules with a known mechanical fix. Everything else in Violation['rule'] (zero-size,
// overlap) has no safe one-shot patch — those always report "no mechanical fix".
const FIXABLE = new Set<Violation['rule']>(['text-clip', 'tap-target', 'viewport-overflow', 'parent-bleed'])

// Property whose winning cascade entry names the rule block we patch, per fixable rule —
// same "explain the width" idea renderViolations already uses for its suspect line, except
// text-clip cares about what's clipping (overflow-x), not what's sized (width).
const SUSPECT_PROPERTY: Partial<Record<Violation['rule'], string>> = {
  'text-clip': 'overflow-x',
  'tap-target': 'width',
  'viewport-overflow': 'width',
  'parent-bleed': 'width',
}

export interface Patch {
  violation: Violation
  file: string // resolved local path, verified to sit inside --root
  sourceRef: string // the suspect's original file reference (URL or source-map path), for display
  line: number // 1-based line actually edited in `file` (post stale-tolerance search)
  before: string
  after: string
}

export type FixOutcome =
  | { kind: 'patch'; patch: Patch }
  | { kind: 'skip'; violation: Violation; reason: string }

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Matches `prop: value` allowing whitespace/semicolon slack, and refusing to match a longer
// property name that happens to end with `prop` (e.g. searching for `overflow` must not hit
// `overflow-x`).
function declRegex(prop: string, value: string): RegExp {
  return new RegExp(`(?<![\\w-])${esc(prop)}\\s*:\\s*${esc(value)}\\s*;?`)
}

function splitVia(via: string): [string, string] {
  const i = via.indexOf(':')
  return [via.slice(0, i).trim(), via.slice(i + 1).trim()]
}

// Resolves a suspect's file reference to a local path under `root`, the same way for both
// forms CascadeEntry.file takes: an absolute stylesheet URL (unmapped), or a source-map
// `sources[]` path (mapped) — resolving the latter against `sheetURL` (the compiled sheet's
// own URL) mirrors how a browser would resolve a relative sourceMappingURL. `root` is always
// the write boundary: the final path is verified to sit inside it (prefixed with '.' before
// path.resolve so a pathname starting with '/' can't override root the way path.resolve
// normally treats a leading-slash argument as absolute).
export function resolveSuspectFile(fileRef: string, sheetURL: string, root: string): string {
  const abs = new URL(fileRef, sheetURL)
  const rootAbs = resolvePath(root)
  const target = resolvePath(rootAbs, '.' + decodeURIComponent(abs.pathname))
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
    throw new Error(`refusing to write outside --root: '${fileRef}' resolves to ${target}`)
  }
  return target
}

function isInline(entry: CascadeEntry, pageURL: string): boolean {
  return entry.file === '(inline)' || entry.sheetURL === '<style>' || entry.sheetURL === pageURL
}

// The selector text of the rule block containing `lineIdx` (0-based): scans backward for the
// nearest `{`, the line it's on holds the selector before that brace (works for both a
// single-line rule, where the declaration's own line has the `{`, and a multi-line one, where
// it's on an earlier line). ponytail: brace-position heuristic, not a real CSS parser — a
// selector containing a literal `{` (never valid CSS) or deeply nested at-rules could confuse
// it; good enough for the flat, one-rule-per-declaration-block stylesheets this targets.
function ruleSelectorAt(lines: string[], lineIdx: number): string {
  for (let i = lineIdx; i >= 0; i--) {
    const open = lines[i].lastIndexOf('{')
    if (open !== -1) return lines[i].slice(0, open)
  }
  return ''
}

// Finds a line within `expected ± 3` whose text matches `needle` AND sits inside a rule block
// for `ruleSelector` — the stale-source guard. Concurrent edits can shift a rule by a few
// lines without actually invalidating the suspect; anything further off, a total miss, or a
// same-property match that belongs to a DIFFERENT rule (e.g. two rules that both set
// `overflow: hidden`), means the file has drifted since Chrome analyzed it.
function findLine(lines: string[], expected: number, needle: RegExp, ruleSelector: string): number | null {
  for (let d = 0; d <= 3; d++) {
    for (const cand of d === 0 ? [expected] : [expected - d, expected + d]) {
      if (cand < 1 || cand > lines.length) continue
      if (needle.test(lines[cand - 1]) && ruleSelectorAt(lines, cand - 1).includes(ruleSelector.trim())) return cand
    }
  }
  return null
}

function insertAfter(line: string, needle: RegExp, addition: string): string {
  const m = line.match(needle)!
  const at = m.index! + m[0].length
  return `${line.slice(0, at)} ${addition}${line.slice(at)}`
}

function replaceMatch(line: string, needle: RegExp, replacement: string): string {
  const m = line.match(needle)!
  return `${line.slice(0, m.index)}${replacement}${line.slice(m.index! + m[0].length)}`
}

// Builds one FixOutcome per violation: a concrete Patch (file, line, before/after) for
// anything mechanically fixable, or a `skip` naming why not (unfixable rule, inline style,
// unresolvable/stale source). Nothing is written here — this only reads (CDP + the local
// filesystem) to decide what a patch WOULD be; see applyFixes for the write.
export async function buildFixes(
  client: any, pageURL: string, violations: Violation[], root: string,
): Promise<FixOutcome[]> {
  const outcomes: FixOutcome[] = []
  for (const v of violations) {
    if (!FIXABLE.has(v.rule)) {
      outcomes.push({ kind: 'skip', violation: v, reason: `no mechanical fix for ${v.rule} — see suspect` })
      continue
    }

    const property = SUSPECT_PROPERTY[v.rule]!
    let entry: CascadeEntry | undefined
    try {
      const e = await explain(client, { backendNodeId: v.backendNodeId }, property, v.selector)
      entry = e.entries.find((x) => x.status === 'winner')
    } catch (err) {
      outcomes.push({ kind: 'skip', violation: v, reason: `could not resolve suspect: ${(err as Error).message}` })
      continue
    }
    if (!entry) {
      outcomes.push({ kind: 'skip', violation: v, reason: `no mechanical fix for ${v.rule} — see suspect (no declared ${property})` })
      continue
    }
    if (isInline(entry, pageURL)) {
      outcomes.push({ kind: 'skip', violation: v, reason: `inline styles not patchable — edit ${pageURL}:${entry.line}` })
      continue
    }

    const isBleed = v.rule === 'viewport-overflow' || v.rule === 'parent-bleed'
    if (isBleed && (entry.via || !/^-?[\d.]+px$/.test(entry.value.trim()))) {
      outcomes.push({ kind: 'skip', violation: v, reason: `no mechanical fix for ${v.rule} — see suspect (not a fixed px width)` })
      continue
    }

    let resolved: string
    try {
      resolved = resolveSuspectFile(entry.file, entry.sheetURL, root)
    } catch (err) {
      outcomes.push({ kind: 'skip', violation: v, reason: (err as Error).message })
      continue
    }
    if (!existsSync(resolved)) {
      outcomes.push({ kind: 'skip', violation: v, reason: `resolved file not found: '${entry.file}' → ${resolved}` })
      continue
    }

    const lines = readFileSync(resolved, 'utf8').split('\n')
    const [searchProp, searchValue] = entry.via ? splitVia(entry.via) : [property, entry.value]
    const needle = declRegex(searchProp, searchValue)
    const foundLine = findLine(lines, entry.line, needle, entry.selector)
    if (foundLine === null) {
      outcomes.push({
        kind: 'skip', violation: v,
        reason: `stale source: expected '${searchProp}: ${searchValue}' near ${resolved}:${entry.line} (±3 lines), not found`,
      })
      continue
    }

    const before = lines[foundLine - 1]
    const after = v.rule === 'text-clip'
      ? insertAfter(before, needle, 'text-overflow: ellipsis;')
      : v.rule === 'tap-target'
      ? insertAfter(before, needle, 'min-width: 24px; min-height: 24px;')
      : replaceMatch(before, needle, `max-width: 100%; /* was: ${searchProp}: ${searchValue} */`)

    outcomes.push({ kind: 'patch', patch: { violation: v, file: resolved, sourceRef: entry.file, line: foundLine, before, after } })
  }
  return outcomes
}

// Writes every patch. Patches targeting the same file are grouped into one read-modify-write
// so a second patch's line index isn't computed against a half-written file.
export function applyFixes(outcomes: FixOutcome[]): void {
  const byFile = new Map<string, Patch[]>()
  for (const o of outcomes) {
    if (o.kind !== 'patch') continue
    const arr = byFile.get(o.patch.file) ?? []
    arr.push(o.patch)
    byFile.set(o.patch.file, arr)
  }
  for (const [file, patches] of byFile) {
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const p of patches) lines[p.line - 1] = p.after
    writeFileSync(file, lines.join('\n'))
  }
}

// Unified-diff-style hunks, one per violation: a patch shows file:line and the changed line;
// a skip states plainly why nothing can be done for it.
export function renderFixes(outcomes: FixOutcome[]): string {
  if (!outcomes.length) return 'no violations to fix'
  const lines: string[] = []
  for (const o of outcomes) {
    if (o.kind === 'skip') {
      lines.push(`${o.violation.rule}: ${o.violation.selector} — ${o.reason}`)
    } else {
      const p = o.patch
      lines.push(`${p.violation.rule}: ${p.violation.selector}`)
      lines.push(`  ${p.file}:${p.line}`)
      lines.push(`  - ${p.before.trim()}`)
      lines.push(`  + ${p.after.trim()}`)
    }
  }
  return lines.join('\n')
}
