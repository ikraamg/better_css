export const STYLE_WHITELIST = [
  'display', 'position', 'flex-direction', 'justify-content', 'align-items',
  'gap', 'grid-template-columns', 'grid-template-rows',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'overflow-x', 'overflow-y', 'z-index', 'visibility', 'opacity', 'transform',
  'text-overflow', 'white-space', 'clip', 'clip-path',
] as const

export interface RawSnapshot {
  documents: any[]
  strings: string[]
  viewport: { width: number; height: number }
  contentWidth: number
  contentHeight: number
}

// Self-calibrating device-pixel normalization: some Chrome builds report DOMSnapshot
// layout bounds in DEVICE pixels (observed live: Chrome 150 on Retina returns 2560-wide
// bounds for a 1280 CSS-px viewport even at deviceScaleFactor:1), others in CSS px —
// and the unit has flip-flopped across Chrome versions before, so hardcoding a DPR
// would break on the next flip. Instead, measure the effective scale empirically per
// capture: Page.getLayoutMetrics returns the SAME quantity (layout viewport width) in
// both unit systems from ONE call — the deprecated `layoutViewport` tracks whatever
// units the snapshot machinery uses (both flipped together historically, and did here:
// 2560/2560), while `cssLayoutViewport` is guaranteed CSS px. Their ratio IS the
// snapshot's scale, whatever Chrome decided this week.
//
// Failure mode: if a future Chrome ever puts layoutViewport and DOMSnapshot bounds in
// DIFFERENT unit systems, this miscalibrates — every pinned-geometry test in the suite
// fails loudly (×scale everywhere), which is exactly the signal that the measurement
// pair needs re-picking. It cannot fail silently on a same-unit build (ratio 1).
//
// Exported (with normalizeBounds) as the unit-test seam for the division math.
export function boundsScale(metrics: any): number {
  const css = metrics.cssLayoutViewport?.clientWidth
  const raw = metrics.layoutViewport?.clientWidth
  return css > 0 && raw > 0 ? raw / css : 1
}

// Mutates the snapshot documents in place (they're throwaway CDP payloads owned by
// extract): every layout row's [x,y,w,h] divided by scale, across all documents (iframes
// included). Fractional results are fine — buildTree rounds. Scale ≈ 1 is a no-op so
// same-unit Chrome builds stay byte-identical, division skipped entirely.
export function normalizeBounds(documents: any[], scale: number): void {
  if (Math.abs(scale - 1) < 0.001) return
  for (const doc of documents) {
    for (const b of doc.layout.bounds) {
      for (let i = 0; i < b.length; i++) b[i] /= scale
    }
  }
}

export async function extract(client: any): Promise<RawSnapshot> {
  const { DOMSnapshot, Page } = client
  await DOMSnapshot.enable()
  const snap = await DOMSnapshot.captureSnapshot({ computedStyles: [...STYLE_WHITELIST] })
  const metrics = await Page.getLayoutMetrics()
  normalizeBounds(snap.documents, boundsScale(metrics))
  const vp = metrics.cssLayoutViewport
  const cs = metrics.cssContentSize
  return {
    documents: snap.documents,
    strings: snap.strings,
    viewport: { width: vp.clientWidth, height: vp.clientHeight },
    contentWidth: Math.round(cs.width),
    contentHeight: Math.round(cs.height),
  }
}
