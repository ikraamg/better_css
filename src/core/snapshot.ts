import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface DiffEntry {
  kind: 'moved' | 'resized' | 'appeared' | 'disappeared'
  key: string
  detail: string
}

export function saveSnapshot(text: string, name: string, dir = '.bettercss'): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}.tree`)
  writeFileSync(path, text)
  return path
}

export function loadSnapshot(name: string, dir = '.bettercss'): string {
  const path = join(dir, `${name}.tree`)
  try {
    return readFileSync(path, 'utf8')
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err
    // Relative dirs resolve against the process cwd — for the MCP server that's
    // wherever the host launched it, so name the absolute path in the error.
    throw new Error(`No snapshot '${name}' at ${resolve(path)} — check the dir option and the server's working directory`)
  }
}

// Matches renderTree's line shapes (src/core/tree.ts renderNode):
//   normal:    "sel (x,y WxH)[ layoutDesc][ ⚠warn]"
//   collapsed: "sel ×N (~WxH)"                        (position-less)
// Trailing layout descriptors and warnings are intentionally left unmatched —
// they're not part of the structural diff key.
const LINE = /^(\s*)([a-z][\w-]*(?:#[\w-]+)?(?:\.[\w-]+)*)(?: ×\d+)? \((~?)(-?\d+)[,x](-?\d+)(?: (\d+)x(\d+))?\)/

interface Parsed { key: string; x: number; y: number; w: number; h: number }

function parse(text: string): Map<string, Parsed> {
  const out = new Map<string, Parsed>()
  const stack: string[] = []
  const counts = new Map<string, number>()
  for (const line of text.split('\n')) {
    const m = LINE.exec(line)
    if (!m) continue
    const depth = m[1].length / 2
    stack.length = depth
    const parentKey = stack[depth - 1] ?? ''
    // collapsed lines (~WxH) have no position; key them but skip geometry compare
    const collapsed = m[3] === '~'
    const base = `${parentKey}>${m[2]}`
    const n = (counts.get(base) ?? 0) + 1
    counts.set(base, n)
    const key = `${base}[${n}]`
    stack[depth] = key
    // root's own box is a derived aggregate of its children (e.g. body height
    // shrinks whenever a child disappears) — diffing it is noise, not signal.
    if (collapsed || depth === 0) continue
    out.set(key, { key, x: +m[4], y: +m[5], w: +m[6], h: +m[7] })
  }
  return out
}

export function diffTrees(oldText: string, newText: string): DiffEntry[] {
  const a = parse(oldText), b = parse(newText)
  const entries: DiffEntry[] = []
  for (const [key, oldN] of a) {
    const newN = b.get(key)
    if (!newN) { entries.push({ kind: 'disappeared', key, detail: `was at (${oldN.x},${oldN.y} ${oldN.w}x${oldN.h})` }); continue }
    const dx = newN.x - oldN.x, dy = newN.y - oldN.y
    const dw = newN.w - oldN.w, dh = newN.h - oldN.h
    if (dx || dy) entries.push({ kind: 'moved', key, detail: `(${oldN.x},${oldN.y})→(${newN.x},${newN.y}) Δ${dx >= 0 ? '+' : ''}${dx},${dy >= 0 ? '+' : ''}${dy}` })
    if (dw || dh) entries.push({ kind: 'resized', key, detail: `${oldN.w}x${oldN.h}→${newN.w}x${newN.h}` })
  }
  for (const key of b.keys()) {
    if (!a.has(key)) {
      const n = b.get(key)!
      entries.push({ kind: 'appeared', key, detail: `at (${n.x},${n.y} ${n.w}x${n.h})` })
    }
  }
  return entries
}

export function renderDiff(entries: DiffEntry[]): string {
  if (!entries.length) return '(no layout changes)'
  return entries.map((e) => `${e.kind}: ${e.key.replace(/\[1\]/g, '').replace(/^>/, '')} ${e.detail}`).join('\n')
}
