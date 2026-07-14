export interface SourceMap {
  sources: string[]
  // per generated line: array of [genCol, srcIdx, srcLine, srcCol], sorted by genCol
  lines: number[][][]
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function decodeVLQ(str: string, pos: { i: number }): number {
  let result = 0, shift = 0
  while (true) {
    const digit = B64.indexOf(str[pos.i++])
    result += (digit & 31) << shift
    if ((digit & 32) === 0) break
    shift += 5
  }
  return result & 1 ? -(result >>> 1) : result >>> 1
}

export function parseSourceMap(json: string): SourceMap {
  const raw = JSON.parse(json)
  const lines: number[][][] = []
  let srcIdx = 0, srcLine = 0, srcCol = 0
  for (const lineStr of (raw.mappings as string).split(';')) {
    const segs: number[][] = []
    let genCol = 0
    for (const segStr of lineStr.split(',')) {
      if (!segStr) continue
      const pos = { i: 0 }
      genCol += decodeVLQ(segStr, pos)
      if (pos.i < segStr.length) {
        srcIdx += decodeVLQ(segStr, pos)
        srcLine += decodeVLQ(segStr, pos)
        srcCol += decodeVLQ(segStr, pos)
        segs.push([genCol, srcIdx, srcLine, srcCol])
      }
    }
    lines.push(segs)
  }
  return { sources: raw.sources, lines }
}

export function originalPosition(map: SourceMap, line: number, column: number): { source: string; line: number } | null {
  const segs = map.lines[line]
  if (!segs?.length) return null
  let best = segs[0]
  for (const s of segs) { if (s[0] <= column) best = s; else break }
  return { source: map.sources[best[1]] ?? '(unknown)', line: best[2] + 1 }
}
