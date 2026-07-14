import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { extract } from '../src/core/extract.js'
import { buildTree, selectorOf, walk, type LayoutNode } from '../src/core/tree.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

async function built(path: string) {
  return withPage(`${srv.url}${path}`, async (c) => buildTree(await extract(c)))
}

test('builds hierarchy rooted at body with exact pinned geometry', async () => {
  const { root, viewport } = await built('/basic/index.html')
  expect(root.tag).toBe('body')
  expect(viewport.width).toBe(1280)

  const header = root.children.find((n) => n.tag === 'header')!
  expect(header.id).toBe('top')
  expect(header.box).toEqual({ x: 0, y: 0, w: 1280, h: 64 })
  expect(header.styles['display']).toBe('flex')
  expect(header.styles['gap']).toBe('16px')

  const logo = header.children.find((n) => n.classes.includes('logo'))!
  expect(logo.box).toEqual({ x: 24, y: 12, w: 40, h: 40 })

  const main = root.children.find((n) => n.tag === 'main')!
  const sidebar = main.children.find((n) => n.classes.includes('sidebar'))!
  expect(sidebar.box).toEqual({ x: 0, y: 64, w: 240, h: 400 })
})

test('text folds into parent, not separate nodes', async () => {
  const { root } = await built('/basic/index.html')
  let h1: LayoutNode | undefined
  walk(root, (n) => { if (n.tag === 'h1') h1 = n })
  expect(h1!.text).toBe('Hello')
  expect(h1!.textBoxes.length).toBeGreaterThan(0)
  expect(h1!.children).toHaveLength(0)
})

test('selectorOf formats tag#id.classes', async () => {
  const { root } = await built('/basic/index.html')
  const header = root.children[0]
  expect(selectorOf(header)).toBe('header#top')
})

test('pseudo-elements (::marker, ::before, ::after) never become LayoutNodes', async () => {
  const { root } = await built('/basic/index.html')
  let sawPseudo = false
  walk(root, (n) => { if (n.tag.startsWith('::')) sawPseudo = true })
  expect(sawPseudo).toBe(false)
})
