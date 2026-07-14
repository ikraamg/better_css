export const STYLE_WHITELIST = [
  'display', 'position', 'flex-direction', 'justify-content', 'align-items',
  'gap', 'grid-template-columns', 'grid-template-rows',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'overflow-x', 'overflow-y', 'z-index', 'visibility', 'opacity', 'transform',
  'text-overflow', 'white-space',
] as const

export interface RawSnapshot {
  documents: any[]
  strings: string[]
  viewport: { width: number; height: number }
  contentWidth: number
  contentHeight: number
}

export async function extract(client: any): Promise<RawSnapshot> {
  const { DOMSnapshot, Page } = client
  await DOMSnapshot.enable()
  const snap = await DOMSnapshot.captureSnapshot({ computedStyles: [...STYLE_WHITELIST] })
  const metrics = await Page.getLayoutMetrics()
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
