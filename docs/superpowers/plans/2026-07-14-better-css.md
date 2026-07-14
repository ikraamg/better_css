# better_css Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CDP-based tool giving coding agents deterministic ground truth for CSS/layout — compact layout trees, invariant checks, cascade tracing to source `file:line`, and snapshot diffing — exposed as a live MCP server and a mirror CLI.

**Architecture:** One TypeScript core speaks raw Chrome DevTools Protocol (`chrome-remote-interface`): a single bulk `DOMSnapshot.captureSnapshot` yields DOM + layout boxes + whitelisted computed styles; `CSS.getMatchedStylesForNode` yields cascade traces lazily per element. Two thin skins (MCP stdio server, CLI) call identical core functions. Fixture pages with planted bugs are the permanent test suite.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node ≥ 20, `chrome-remote-interface`, `@modelcontextprotocol/sdk` + `zod`, vitest + tsx (dev only).

## Global Constraints

- Runtime dependencies: `chrome-remote-interface`, `@modelcontextprotocol/sdk`, `zod` (MCP SDK peer dep) — nothing else. No Playwright/Puppeteer. Source-map decoding is hand-rolled.
- Chromium-only via CDP. Attach to running Chrome at port 9222 if available, else launch headless (`--headless=new`).
- Default viewport 1280×800 via `Emulation.setDeviceMetricsOverride` — required for determinism.
- LayoutTree text output MUST be deterministic: same render → byte-identical text. No timestamps, no randomness, no object-key-order dependence.
- Tests never assert on text-derived pixel sizes (font metrics vary by machine). Fixtures pin sizes with explicit CSS; assertions use those pinned numbers or substrings.
- Coordinates rounded with `Math.round`. Indentation: 2 spaces per depth level.
- Invariant escape hatch: elements with a `data-bettercss-ignore` attribute are skipped by ALL invariants.
- Errors are single clear messages (spec §Error handling): Chrome unreachable → print the exact `--remote-debugging-port=9222` launch command; unknown selector → say so and suggest nearest matches; page busy after 10 s network-idle cap → extract anyway and note it.
- Commit messages follow the alchemist style (`Added …`, `Updated …`, `Fixed …`).
- CDP payloads may be typed loosely (`any` at the protocol boundary); our own structures (`LayoutNode`, `Violation`, `CascadeEntry`) are typed strictly.

## File Structure

```
better_css/
├── package.json, tsconfig.json, vitest.config.ts
├── src/
│   ├── core/
│   │   ├── connect.ts     # Chrome attach/launch, withPage(), navigate w/ network-idle
│   │   ├── extract.ts     # DOMSnapshot capture → RawSnapshot
│   │   ├── tree.ts        # RawSnapshot → LayoutNode tree → deterministic text
│   │   ├── invariants.ts  # 6 always-a-bug checks + check() aggregation
│   │   ├── explain.ts     # cascade trace to file:line, source-map aware
│   │   ├── inspect.ts     # single-element deep dive
│   │   └── snapshot.ts    # save / parse / structural diff of .tree files
│   ├── mcp.ts             # MCP stdio server (6 tools)
│   └── cli.ts             # CLI (same 6 commands)
├── fixtures/              # planted-bug pages (each task adds its own)
└── test/
    ├── helpers/server.ts  # static fixture server on a random port
    └── *.test.ts          # one test file per core module
```

---

### Task 1: Project scaffolding + fixture server

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `test/helpers/server.ts`
- Create: `fixtures/basic/index.html`
- Test: `test/server.test.ts`

**Interfaces:**
- Produces: `serveFixtures(root: string): Promise<{ url: string; close(): void }>` — serves a directory over HTTP on 127.0.0.1, random port. All later test files consume this.

- [ ] **Step 1: Write config files**

`package.json`:
```json
{
  "name": "bettercss",
  "version": "0.1.0",
  "type": "module",
  "bin": { "bettercss": "./dist/cli.js" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "chrome-remote-interface": "^0.33.2",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src"]
}
```

`vitest.config.ts` (single thread: one shared Chrome, deterministic order):
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
```

`.gitignore`:
```
node_modules/
dist/
.bettercss/
```

- [ ] **Step 2: Write the failing test**

`test/server.test.ts`:
```ts
import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'

const srv = await serveFixtures('fixtures')
afterAll(() => srv.close())

test('serves fixture html with content-type', async () => {
  const res = await fetch(`${srv.url}/basic/index.html`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/html')
  expect(await res.text()).toContain('<header')
})

test('404s on missing files', async () => {
  const res = await fetch(`${srv.url}/nope.html`)
  expect(res.status).toBe(404)
})
```

`fixtures/basic/index.html`:
```html
<!doctype html>
<html><head><style>
* { margin: 0; box-sizing: border-box; font-family: monospace; }
header { display: flex; flex-direction: row; gap: 16px; padding: 12px 24px; height: 64px; }
.logo { width: 40px; height: 40px; background: #333; }
nav { display: flex; gap: 24px; height: 24px; }
main { display: grid; grid-template-columns: 240px 1fr; }
.sidebar { height: 400px; background: #eee; }
.content { padding: 32px; height: 400px; }
</style></head>
<body>
<header id="top"><div class="logo"></div><nav><a href="#">Home</a><a href="#">Docs</a></nav></header>
<main><aside class="sidebar"></aside><section class="content"><h1>Hello</h1></section></main>
</body></html>
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm install && npx vitest run test/server.test.ts`
Expected: FAIL — `Cannot find module './helpers/server.js'`

- [ ] **Step 4: Write the server helper**

`test/helpers/server.ts`:
```ts
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.map': 'application/json',
}

export async function serveFixtures(root: string): Promise<{ url: string; close(): void }> {
  const server = createServer(async (req, res) => {
    try {
      const path = normalize(decodeURIComponent(new URL(req.url!, 'http://x').pathname))
      const body = await readFile(join(root, path))
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/server.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore test fixtures
git commit -m "Added project scaffolding and fixture server"
```

---

### Task 2: CDP connection (`connect.ts`)

**Files:**
- Create: `src/core/connect.ts`
- Test: `test/connect.test.ts`

**Interfaces:**
- Produces:
  - `withPage<T>(url: string, fn: (client: any) => Promise<T>, opts?: { port?: number; viewport?: { width: number; height: number } }): Promise<T>` — opens a tab, sets viewport (default 1280×800), navigates, waits for load + network idle (500 ms quiet, 10 s cap), runs `fn`, always closes the tab. Attaches to Chrome at `opts.port ?? 9222` if reachable, else launches headless once (module singleton).
  - `shutdownChrome(): Promise<void>` — kills the launched headless Chrome if any (used in test `afterAll`).
  - `pageWasBusy(client: any): boolean` — true if the 10 s idle cap was hit for that page.

- [ ] **Step 1: Write the failing test**

`test/connect.test.ts`:
```ts
import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

test('opens page and evaluates against it', async () => {
  const title = await withPage(`${srv.url}/basic/index.html`, async (client) => {
    const { result } = await client.Runtime.evaluate({ expression: 'document.querySelector("h1").textContent' })
    return result.value
  })
  expect(title).toBe('Hello')
})

test('viewport defaults to 1280x800', async () => {
  const w = await withPage(`${srv.url}/basic/index.html`, async (client) => {
    const { result } = await client.Runtime.evaluate({ expression: 'window.innerWidth' })
    return result.value
  })
  expect(w).toBe(1280)
})

test('unreachable Chrome on explicit bad port gives actionable error', async () => {
  await expect(withPage(`${srv.url}/basic/index.html`, async () => {}, { port: 59999 }))
    .rejects.toThrow(/remote-debugging-port/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/connect.test.ts`
Expected: FAIL — cannot find `../src/core/connect.js`

- [ ] **Step 3: Implement `connect.ts`**

`src/core/connect.ts`:
```ts
import CDP from 'chrome-remote-interface'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean) as string[]

const HELP = `Cannot reach Chrome. Either let bettercss launch headless Chrome (install Chrome), or start yours with:
  open -a "Google Chrome" --args --remote-debugging-port=9222   (macOS)
  google-chrome --remote-debugging-port=9222                    (Linux)`

let launched: { proc: ChildProcess; port: number } | null = null
const busyPages = new WeakSet<object>()

async function reachable(port: number): Promise<boolean> {
  try { await CDP.Version({ port }); return true } catch { return false }
}

async function launchChrome(): Promise<number> {
  const { existsSync } = await import('node:fs')
  const bin = CHROME_PATHS.find((p) => existsSync(p))
  if (!bin) throw new Error(HELP)
  const proc = spawn(bin, [
    '--headless=new', '--remote-debugging-port=0', '--no-first-run',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'bettercss-'))}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error(HELP)), 15_000)
    proc.stderr!.on('data', (d) => {
      buf += d.toString()
      const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    })
    proc.on('exit', () => { clearTimeout(timer); reject(new Error(HELP)) })
  })
  launched = { proc, port }
  return port
}

async function resolvePort(explicit?: number): Promise<number> {
  if (explicit !== undefined) {
    if (await reachable(explicit)) return explicit
    throw new Error(`No Chrome at port ${explicit}. ${HELP}`)
  }
  if (await reachable(9222)) return 9222
  if (launched && (await reachable(launched.port))) return launched.port
  return launchChrome()
}

async function navigate(client: any, url: string): Promise<void> {
  const { Page, Network } = client
  let inflight = 0
  let settle: ReturnType<typeof setTimeout> | undefined
  const idle = new Promise<void>((resolve) => {
    const check = () => {
      clearTimeout(settle)
      if (inflight === 0) settle = setTimeout(resolve, 500)
    }
    Network.requestWillBeSent(() => { inflight++; clearTimeout(settle) })
    Network.loadingFinished(() => { inflight--; check() })
    Network.loadingFailed(() => { inflight--; check() })
    check()
  })
  const loaded = Page.loadEventFired()
  await Page.navigate({ url })
  await loaded
  const timedOut = await Promise.race([
    idle.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), 10_000)),
  ])
  if (timedOut) busyPages.add(client)
}

export function pageWasBusy(client: object): boolean {
  return busyPages.has(client)
}

export async function withPage<T>(
  url: string,
  fn: (client: any) => Promise<T>,
  opts: { port?: number; viewport?: { width: number; height: number } } = {},
): Promise<T> {
  const port = await resolvePort(opts.port)
  const target = await CDP.New({ port, url: 'about:blank' })
  const client: any = await CDP({ port, target })
  try {
    await client.Page.enable()
    await client.Network.enable()
    const vp = opts.viewport ?? { width: 1280, height: 800 }
    await client.Emulation.setDeviceMetricsOverride({ ...vp, deviceScaleFactor: 1, mobile: false })
    await navigate(client, url)
    return await fn(client)
  } finally {
    await client.close()
    await CDP.Close({ port, id: target.id })
  }
}

export async function shutdownChrome(): Promise<void> {
  if (launched) { launched.proc.kill(); launched = null }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/connect.test.ts`
Expected: PASS (3 tests). First run downloads nothing — requires Chrome installed locally.

- [ ] **Step 5: Commit**

```bash
git add src/core/connect.ts test/connect.test.ts
git commit -m "Added CDP connection with attach-or-launch and network-idle navigation"
```

---

### Task 3: Raw extraction (`extract.ts`)

**Files:**
- Create: `src/core/extract.ts`
- Test: `test/extract.test.ts`

**Interfaces:**
- Consumes: `withPage` from Task 2.
- Produces:
  - `STYLE_WHITELIST: readonly string[]` — the computed-style whitelist.
  - `interface RawSnapshot { documents: any[]; strings: string[]; viewport: { width: number; height: number }; contentWidth: number; contentHeight: number }`
  - `extract(client: any): Promise<RawSnapshot>`

- [ ] **Step 1: Write the failing test**

`test/extract.test.ts`:
```ts
import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { extract } from '../src/core/extract.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

test('captures snapshot with layout bounds and whitelisted styles', async () => {
  const raw = await withPage(`${srv.url}/basic/index.html`, extract)
  expect(raw.viewport).toEqual({ width: 1280, height: 800 })
  expect(raw.documents.length).toBeGreaterThan(0)
  const doc = raw.documents[0]
  // BODY exists in the node table
  const names = doc.nodes.nodeName.map((i: number) => raw.strings[i])
  expect(names).toContain('BODY')
  // layout table is aligned: every layout row has 4-number bounds
  expect(doc.layout.nodeIndex.length).toBe(doc.layout.bounds.length)
  expect(doc.layout.bounds[0]).toHaveLength(4)
  // whitelisted styles resolve through the string table
  const headerRow = doc.layout.nodeIndex.findIndex((ni: number) =>
    raw.strings[doc.nodes.nodeName[ni]] === 'HEADER')
  const styleOf = (row: number, prop: string) => {
    const idx = doc.layout.styles[row][STYLE_ORDER(prop)]
    return raw.strings[idx]
  }
  // display of header must be 'flex' (see fixture CSS)
  expect(styleOf(headerRow, 'display')).toBe('flex')
})

// helper mirroring extract.ts whitelist ordering
import { STYLE_WHITELIST } from '../src/core/extract.js'
function STYLE_ORDER(prop: string): number {
  return STYLE_WHITELIST.indexOf(prop)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/extract.test.ts`
Expected: FAIL — cannot find `../src/core/extract.js`

- [ ] **Step 3: Implement `extract.ts`**

`src/core/extract.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/extract.test.ts`
Expected: PASS. If the `styles` row ordering assertion fails, inspect actual payload with `console.log(JSON.stringify(doc.layout.styles[headerRow]))` — the styles array is index-aligned with the `computedStyles` request parameter; fix the test helper, not the whitelist.

- [ ] **Step 5: Commit**

```bash
git add src/core/extract.ts test/extract.test.ts
git commit -m "Added bulk DOMSnapshot extraction with computed-style whitelist"
```

---

### Task 4: LayoutNode tree builder (`tree.ts` part 1)

**Files:**
- Create: `src/core/tree.ts`
- Test: `test/tree-build.test.ts`

**Interfaces:**
- Consumes: `RawSnapshot`, `STYLE_WHITELIST` from Task 3.
- Produces:
  - `interface Box { x: number; y: number; w: number; h: number }`
  - `interface LayoutNode { tag: string; id: string | null; classes: string[]; box: Box; styles: Record<string, string>; backendNodeId: number; attrs: Record<string, string>; text: string | null; textBoxes: Box[]; children: LayoutNode[]; warnings: string[] }`
  - `interface BuiltTree { root: LayoutNode; viewport: { width: number; height: number }; contentWidth: number; contentHeight: number }`
  - `buildTree(raw: RawSnapshot): BuiltTree` — root is the `<body>` element; text nodes fold into their parent's `text`/`textBoxes`.
  - `walk(node: LayoutNode, fn: (n: LayoutNode, parent: LayoutNode | null) => void): void`
  - `selectorOf(n: LayoutNode): string` — `tag#id.class1.class2` (max 3 classes).

- [ ] **Step 1: Write the failing test**

`test/tree-build.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tree-build.test.ts`
Expected: FAIL — cannot find `../src/core/tree.js`

- [ ] **Step 3: Implement the builder**

`src/core/tree.ts`:
```ts
import { STYLE_WHITELIST, type RawSnapshot } from './extract.js'

export interface Box { x: number; y: number; w: number; h: number }

export interface LayoutNode {
  tag: string
  id: string | null
  classes: string[]
  box: Box
  styles: Record<string, string>
  backendNodeId: number
  attrs: Record<string, string>
  text: string | null
  textBoxes: Box[]
  children: LayoutNode[]
  warnings: string[]
}

export interface BuiltTree {
  root: LayoutNode
  viewport: { width: number; height: number }
  contentWidth: number
  contentHeight: number
}

export function buildTree(raw: RawSnapshot): BuiltTree {
  const doc = raw.documents[0]
  const s = (i: number) => (i >= 0 ? raw.strings[i] : '')
  const { nodes, layout } = doc

  // layout row per DOM node index
  const layoutRow = new Map<number, number>()
  layout.nodeIndex.forEach((ni: number, row: number) => layoutRow.set(ni, row))

  const byIndex = new Map<number, LayoutNode>()
  let body: LayoutNode | null = null

  const count = nodes.parentIndex.length
  for (let i = 0; i < count; i++) {
    const row = layoutRow.get(i)
    const type = nodes.nodeType[i]
    const name = s(nodes.nodeName[i]).toLowerCase()

    // nearest ancestor that became a LayoutNode
    let parent: LayoutNode | null = null
    for (let p = nodes.parentIndex[i]; p >= 0; p = nodes.parentIndex[p]) {
      const found = byIndex.get(p)
      if (found) { parent = found; break }
    }

    if (type === 3 && row !== undefined && parent) {
      // text node: fold into parent
      const [x, y, w, h] = layout.bounds[row]
      const value = s(nodes.nodeValue[i]).trim()
      if (value) {
        parent.text = parent.text ? `${parent.text} ${value}` : value
        parent.textBoxes.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) })
      }
      continue
    }

    if (type !== 1 || row === undefined) continue // element nodes with layout only

    const attrs: Record<string, string> = {}
    const attrPairs: number[] = nodes.attributes[i] ?? []
    for (let a = 0; a < attrPairs.length; a += 2) attrs[s(attrPairs[a])] = s(attrPairs[a + 1])

    const styles: Record<string, string> = {}
    layout.styles[row].forEach((si: number, k: number) => { styles[STYLE_WHITELIST[k]] = s(si) })

    const [x, y, w, h] = layout.bounds[row]
    const node: LayoutNode = {
      tag: name,
      id: attrs['id'] ?? null,
      classes: (attrs['class'] ?? '').split(/\s+/).filter(Boolean),
      box: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) },
      styles,
      backendNodeId: nodes.backendNodeId[i],
      attrs,
      text: null,
      textBoxes: [],
      children: [],
      warnings: [],
    }
    byIndex.set(i, node)
    if (name === 'body') body = node
    else if (parent) parent.children.push(node)
  }

  if (!body) throw new Error('No <body> found in snapshot')
  return { root: body, viewport: raw.viewport, contentWidth: raw.contentWidth, contentHeight: raw.contentHeight }
}

export function walk(node: LayoutNode, fn: (n: LayoutNode, parent: LayoutNode | null) => void, parent: LayoutNode | null = null): void {
  fn(node, parent)
  for (const c of node.children) walk(c, fn, node)
}

export function selectorOf(n: LayoutNode): string {
  return n.tag + (n.id ? `#${n.id}` : '') + n.classes.slice(0, 3).map((c) => `.${c}`).join('')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tree-build.test.ts`
Expected: PASS (3 tests). Gotcha: `<html>` and `<head>` also have layout rows — the loop keys the tree off `body`, so anything before body (html) is simply never attached. If `header` appears under root twice or not at all, log `nodes.parentIndex` handling first.

- [ ] **Step 5: Commit**

```bash
git add src/core/tree.ts test/tree-build.test.ts
git commit -m "Added LayoutNode tree builder from DOMSnapshot"
```

---

### Task 5: LayoutTree text rendering (`tree.ts` part 2)

**Files:**
- Modify: `src/core/tree.ts` (append)
- Create: `fixtures/collapse/index.html`
- Test: `test/tree-render.test.ts`

**Interfaces:**
- Consumes: `LayoutNode`, `BuiltTree`, `selectorOf` from Task 4.
- Produces: `renderTree(tree: BuiltTree, opts?: { depth?: number; from?: LayoutNode }): string` — deterministic text; sibling collapse; inline `⚠` warnings (populated later by invariants); page-level `⚠H-OVERFLOW` on the root line when `contentWidth > viewport.width`.

- [ ] **Step 1: Write the collapse fixture**

`fixtures/collapse/index.html`:
```html
<!doctype html>
<html><head><style>
* { margin: 0; box-sizing: border-box; }
.grid { display: grid; grid-template-columns: repeat(3, 380px); gap: 20px; padding: 20px; }
.card { height: 220px; background: #ddd; }
.card.tall { height: 222px; }
</style></head>
<body><div class="grid">
<div class="card"></div><div class="card"></div><div class="card"></div>
<div class="card tall"></div><div class="card"></div><div class="card"></div>
</div></body></html>
```

- [ ] **Step 2: Write the failing test**

`test/tree-render.test.ts`:
```ts
import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { extract } from '../src/core/extract.js'
import { buildTree, renderTree } from '../src/core/tree.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

async function render(path: string) {
  return withPage(`${srv.url}${path}`, async (c) => renderTree(buildTree(await extract(c))))
}

test('renders geometry, layout mode, and nonzero padding', async () => {
  const text = await render('/basic/index.html')
  expect(text).toContain('body (0,0 1280x')
  expect(text).toContain('header#top (0,0 1280x64) flex row gap:16 pad:12,24')
  expect(text).toContain('  main (0,64 1280x400) grid cols:240,1fr')
  expect(text).toContain('    aside.sidebar (0,64 240x400)')
  expect(text).toContain('    section.content (240,64 1040x400) pad:32')
})

test('output is deterministic across two extractions', async () => {
  const a = await render('/basic/index.html')
  const b = await render('/basic/index.html')
  expect(a).toBe(b)
})

test('collapses repeated siblings, keeps deviants separate', async () => {
  const text = await render('/collapse/index.html')
  expect(text).toMatch(/div\.card ×\d+ \(~380x220\)/)
  expect(text).toContain('div.card.tall (420,20 380x222)')
  // collapsed run count: 3 identical before deviant, 2 after → ×3 and ×2
  expect(text).toMatch(/div\.card ×3/)
  expect(text).toMatch(/div\.card ×2/)
})

test('depth option truncates', async () => {
  const full = await render('/basic/index.html')
  const shallow = await withPage(`${srv.url}/basic/index.html`, async (c) =>
    renderTree(buildTree(await extract(c)), { depth: 1 }))
  expect(shallow.split('\n').length).toBeLessThan(full.split('\n').length)
  expect(shallow).toContain('…')
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/tree-render.test.ts`
Expected: FAIL — `renderTree` is not exported

- [ ] **Step 4: Implement rendering (append to `src/core/tree.ts`)**

```ts
const px = (v: string) => String(Math.round(parseFloat(v)) || 0)

function fourSide(styles: Record<string, string>, prefix: string): string | null {
  const [t, r, b, l] = ['top', 'right', 'bottom', 'left'].map((s) => px(styles[`${prefix}-${s}`] ?? '0'))
  if (t === '0' && r === '0' && b === '0' && l === '0') return null
  if (t === b && l === r) return t === l ? t : `${t},${l}`
  return `${t},${r},${b},${l}`
}

function layoutDesc(n: LayoutNode): string {
  const parts: string[] = []
  const d = n.styles['display'] ?? ''
  if (d.includes('flex')) {
    parts.push(`flex ${(n.styles['flex-direction'] ?? 'row').startsWith('column') ? 'column' : 'row'}`)
    const gap = px((n.styles['gap'] ?? '0').split(' ')[0])
    if (gap !== '0') parts.push(`gap:${gap}`)
  } else if (d.includes('grid')) {
    const cols = (n.styles['grid-template-columns'] ?? 'none')
      .split(' ').map((c) => (c.endsWith('px') ? px(c) : c)).join(',')
    parts.push(cols === 'none' ? 'grid' : `grid cols:${cols}`)
    const gap = px((n.styles['gap'] ?? '0').split(' ')[0])
    if (gap !== '0') parts.push(`gap:${gap}`)
  }
  const pad = fourSide(n.styles, 'padding')
  if (pad) parts.push(`pad:${pad}`)
  const pos = n.styles['position']
  if (pos && pos !== 'static') parts.push(pos + (n.styles['z-index'] !== 'auto' ? ` z:${n.styles['z-index']}` : ''))
  return parts.length ? ' ' + parts.join(' ') : ''
}

function sameShape(a: LayoutNode, b: LayoutNode): boolean {
  return selectorOf(a) === selectorOf(b) &&
    Math.abs(a.box.w - b.box.w) <= 2 && Math.abs(a.box.h - b.box.h) <= 2 &&
    a.warnings.length === 0 && b.warnings.length === 0
}

function renderNode(n: LayoutNode, depth: number, maxDepth: number, out: string[]): void {
  const indent = '  '.repeat(depth)
  const warn = n.warnings.map((w) => ` ⚠${w}`).join('')
  out.push(`${indent}${selectorOf(n)} (${n.box.x},${n.box.y} ${n.box.w}x${n.box.h})${layoutDesc(n)}${warn}`)
  if (depth >= maxDepth) {
    if (n.children.length) out.push(`${indent}  … ${n.children.length} children`)
    return
  }
  // collapse runs of same-shaped siblings
  for (let i = 0; i < n.children.length; ) {
    let j = i + 1
    while (j < n.children.length && sameShape(n.children[i], n.children[j])) j++
    const run = j - i
    if (run >= 2) {
      const c = n.children[i]
      out.push(`${'  '.repeat(depth + 1)}${selectorOf(c)} ×${run} (~${c.box.w}x${c.box.h})`)
    } else {
      renderNode(n.children[i], depth + 1, maxDepth, out)
    }
    i = j
  }
}

export function renderTree(tree: BuiltTree, opts: { depth?: number; from?: LayoutNode } = {}): string {
  const root = opts.from ?? tree.root
  const out: string[] = []
  renderNode(root, 0, opts.depth ?? Infinity, out)
  if (root === tree.root && tree.contentWidth > tree.viewport.width) {
    out[0] += ` ⚠H-OVERFLOW:+${tree.contentWidth - tree.viewport.width}px`
  }
  return out.join('\n')
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/tree-render.test.ts`
Expected: PASS (4 tests). If pinned strings mismatch, print the actual render (`console.log(text)`) and reconcile the *test* only when the discrepancy is browser truth (e.g. grid column resolution `240px` vs `240`), never by weakening determinism.

- [ ] **Step 6: Commit**

```bash
git add src/core/tree.ts test/tree-render.test.ts fixtures/collapse
git commit -m "Added deterministic LayoutTree text rendering with sibling collapse"
```

---

### Task 6: Invariants — overflow, bleed, zero-size (`invariants.ts` part 1)

**Files:**
- Create: `src/core/invariants.ts`
- Create: `fixtures/overflow-h/index.html`, `fixtures/bleed/index.html`, `fixtures/zero-size/index.html`
- Test: `test/invariants-1.test.ts`

**Interfaces:**
- Consumes: `BuiltTree`, `LayoutNode`, `walk`, `selectorOf` from Tasks 4–5.
- Produces:
  - `interface Violation { rule: 'viewport-overflow' | 'parent-bleed' | 'zero-size' | 'text-clip' | 'overlap' | 'tap-target'; selector: string; message: string; backendNodeId: number }`
  - `checkInvariants(tree: BuiltTree): Violation[]` — runs all registered checks, honors `data-bettercss-ignore`, and pushes short warning strings onto `node.warnings` so `renderTree` shows them inline.

- [ ] **Step 1: Write the fixtures**

`fixtures/overflow-h/index.html`:
```html
<!doctype html><html><head><style>
* { margin: 0; } .wide { width: 1400px; height: 50px; background: tomato; }
</style></head><body><div class="wide"></div></body></html>
```

`fixtures/bleed/index.html`:
```html
<!doctype html><html><head><style>
* { margin: 0; box-sizing: border-box; }
.parent { width: 200px; height: 100px; background: #eee; }
.child { width: 300px; height: 50px; background: tomato; }
.fine { width: 200px; height: 100px; overflow: auto; }
.big { width: 300px; height: 50px; }
</style></head><body>
<div class="parent"><div class="child"></div></div>
<div class="fine"><div class="big"></div></div>
</body></html>
```

`fixtures/zero-size/index.html`:
```html
<!doctype html><html><head><style>* { margin: 0; }</style></head><body>
<button style="width:0;height:0;padding:0;border:0">Buy</button>
<a href="#" style="display:block;width:100px;height:20px">fine link</a>
<button data-bettercss-ignore style="width:0;height:0;padding:0;border:0">ignored</button>
</body></html>
```

- [ ] **Step 2: Write the failing test**

`test/invariants-1.test.ts`:
```ts
import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { extract } from '../src/core/extract.js'
import { buildTree, renderTree } from '../src/core/tree.js'
import { checkInvariants } from '../src/core/invariants.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

async function violationsFor(path: string) {
  return withPage(`${srv.url}${path}`, async (c) => {
    const tree = buildTree(await extract(c))
    return { violations: checkInvariants(tree), tree }
  })
}

test('viewport-overflow: names the culprit and the amount', async () => {
  const { violations, tree } = await violationsFor('/overflow-h/index.html')
  const v = violations.find((v) => v.rule === 'viewport-overflow')!
  expect(v.selector).toBe('div.wide')
  expect(v.message).toContain('120px') // 1400 - 1280
  expect(renderTree(tree)).toContain('⚠H-OVERFLOW')
})

test('parent-bleed: flags static child exceeding parent, not scroll containers', async () => {
  const { violations } = await violationsFor('/bleed/index.html')
  const bleeds = violations.filter((v) => v.rule === 'parent-bleed')
  expect(bleeds).toHaveLength(1)
  expect(bleeds[0].selector).toBe('div.child')
  expect(bleeds[0].message).toContain('100px') // 300 - 200
})

test('zero-size: flags invisible interactive element, honors ignore attr', async () => {
  const { violations } = await violationsFor('/zero-size/index.html')
  const zeros = violations.filter((v) => v.rule === 'zero-size')
  expect(zeros).toHaveLength(1)
  expect(zeros[0].selector).toBe('button')
})

test('clean page has no violations', async () => {
  const { violations } = await violationsFor('/basic/index.html')
  expect(violations).toEqual([])
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/invariants-1.test.ts`
Expected: FAIL — cannot find `../src/core/invariants.js`

- [ ] **Step 4: Implement part 1**

`src/core/invariants.ts`:
```ts
import { selectorOf, walk, type BuiltTree, type LayoutNode } from './tree.js'

export interface Violation {
  rule: 'viewport-overflow' | 'parent-bleed' | 'zero-size' | 'text-clip' | 'overlap' | 'tap-target'
  selector: string
  message: string
  backendNodeId: number
}

const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary'])

const ignored = (n: LayoutNode) => 'data-bettercss-ignore' in n.attrs
const visible = (n: LayoutNode) =>
  n.styles['visibility'] !== 'hidden' && parseFloat(n.styles['opacity'] ?? '1') > 0

function report(out: Violation[], n: LayoutNode, rule: Violation['rule'], message: string, warning: string): void {
  out.push({ rule, selector: selectorOf(n), message, backendNodeId: n.backendNodeId })
  n.warnings.push(warning)
}

function viewportOverflow(tree: BuiltTree, out: Violation[]): void {
  const over = tree.contentWidth - tree.viewport.width
  if (over <= 0) return
  // culprit: deepest visible node extending furthest past the viewport edge
  let culprit: LayoutNode | null = null
  walk(tree.root, (n) => {
    if (ignored(n) || !visible(n)) return
    if (n.box.x + n.box.w > tree.viewport.width) {
      if (!culprit || n.box.x + n.box.w >= culprit.box.x + culprit.box.w) culprit = n
    }
  })
  const c = culprit ?? tree.root
  report(out, c, 'viewport-overflow',
    `page overflows viewport horizontally by ${over}px; widest element is ${selectorOf(c)} (right edge ${c.box.x + c.box.w}px > ${tree.viewport.width}px)`,
    `H-OVERFLOW:+${over}px`)
}

function parentBleed(tree: BuiltTree, out: Violation[]): void {
  walk(tree.root, (n, parent) => {
    if (!parent || ignored(n) || !visible(n)) return
    const pos = n.styles['position']
    if (pos === 'absolute' || pos === 'fixed') return // positioned children escape on purpose
    const scrolls = ['auto', 'scroll', 'hidden', 'clip'].includes(parent.styles['overflow-x'] ?? '')
    if (scrolls) return // parent manages its own overflow
    const padBox = {
      left: parent.box.x + Math.round(parseFloat(parent.styles['border-left-width'] ?? '0')),
      right: parent.box.x + parent.box.w - Math.round(parseFloat(parent.styles['border-right-width'] ?? '0')),
    }
    const overRight = n.box.x + n.box.w - padBox.right
    const overLeft = padBox.left - n.box.x
    const over = Math.max(overRight, overLeft)
    if (over > 1) {
      report(out, n, 'parent-bleed',
        `${selectorOf(n)} bleeds ${over}px outside ${selectorOf(parent)} (child ${n.box.w}px wide, parent ${parent.box.w}px)`,
        `BLEED:+${over}px`)
    }
  })
}

function zeroSize(tree: BuiltTree, out: Violation[]): void {
  walk(tree.root, (n) => {
    if (ignored(n) || !visible(n) || !INTERACTIVE.has(n.tag)) return
    if (n.box.w === 0 || n.box.h === 0) {
      report(out, n, 'zero-size', `interactive ${selectorOf(n)} has zero size (${n.box.w}x${n.box.h})`, 'ZERO-SIZE')
    } else if (n.box.x + n.box.w < 0 || n.box.y + n.box.h < 0 ||
               n.box.x > Math.max(tree.viewport.width, tree.contentWidth)) {
      report(out, n, 'zero-size', `interactive ${selectorOf(n)} is entirely off-screen at (${n.box.x},${n.box.y})`, 'OFF-SCREEN')
    }
  })
}

const CHECKS: Array<(tree: BuiltTree, out: Violation[]) => void> = [viewportOverflow, parentBleed, zeroSize]

export function checkInvariants(tree: BuiltTree): Violation[] {
  const out: Violation[] = []
  for (const check of CHECKS) check(tree, out)
  return out
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/invariants-1.test.ts`
Expected: PASS (4 tests). Note the `clean page` test guards against false positives — if `basic` trips `parent-bleed`, the padding-box math is wrong; fix the math, don't touch the fixture.

- [ ] **Step 6: Commit**

```bash
git add src/core/invariants.ts test/invariants-1.test.ts fixtures/overflow-h fixtures/bleed fixtures/zero-size
git commit -m "Added viewport-overflow, parent-bleed, and zero-size invariants"
```

---

### Task 7: Invariants — clip, overlap, tap targets (`invariants.ts` part 2)

**Files:**
- Modify: `src/core/invariants.ts`
- Create: `fixtures/clip/index.html`, `fixtures/overlap/index.html`, `fixtures/tap/index.html`
- Test: `test/invariants-2.test.ts`

**Interfaces:**
- Consumes/Produces: extends `CHECKS` in `invariants.ts`; `Violation.rule` values `'text-clip' | 'overlap' | 'tap-target'` become live. No signature changes.

- [ ] **Step 1: Write the fixtures**

`fixtures/clip/index.html`:
```html
<!doctype html><html><head><style>
* { margin: 0; font-family: monospace; }
.clip { width: 120px; overflow: hidden; white-space: nowrap; }
.ok { width: 120px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style></head><body>
<div class="clip">This text is definitely longer than 120 pixels of monospace</div>
<div class="ok">This text is definitely longer than 120 pixels of monospace</div>
</body></html>
```

`fixtures/overlap/index.html`:
```html
<!doctype html><html><head><style>
* { margin: 0; }
header { height: 64px; background: #eee; }
.oops { position: absolute; top: 10px; left: 10px; width: 200px; height: 100px; background: tomato; }
.modal { position: absolute; top: 10px; left: 400px; width: 200px; height: 100px; z-index: 10; background: teal; }
.under { position: absolute; top: 10px; left: 400px; width: 300px; height: 200px; background: #ccc; }
</style></head><body>
<header></header>
<div class="oops"></div>
<div class="under"></div>
<div class="modal"></div>
</body></html>
```

`fixtures/tap/index.html`:
```html
<!doctype html><html><head><style>* { margin: 0; padding: 0; }</style></head><body>
<a href="#" style="display:block;width:16px;height:16px;overflow:hidden">x</a>
<button style="display:block;width:48px;height:48px">ok</button>
</body></html>
```

- [ ] **Step 2: Write the failing test**

`test/invariants-2.test.ts`:
```ts
import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { extract } from '../src/core/extract.js'
import { buildTree } from '../src/core/tree.js'
import { checkInvariants } from '../src/core/invariants.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

async function violationsFor(path: string) {
  return withPage(`${srv.url}${path}`, async (c) => checkInvariants(buildTree(await extract(c))))
}

test('text-clip: flags hidden overflow without ellipsis opt-in only', async () => {
  const vs = (await violationsFor('/clip/index.html')).filter((v) => v.rule === 'text-clip')
  expect(vs).toHaveLength(1)
  expect(vs[0].selector).toBe('div.clip')
  expect(vs[0].message).toContain('clipped')
})

test('overlap: flags un-layered overlap, allows z-indexed modal', async () => {
  const vs = (await violationsFor('/overlap/index.html')).filter((v) => v.rule === 'overlap')
  expect(vs).toHaveLength(1)
  expect(vs[0].message).toContain('div.oops')
  expect(vs[0].message).toContain('header')
})

test('tap-target: flags sub-24px interactive elements', async () => {
  const vs = (await violationsFor('/tap/index.html')).filter((v) => v.rule === 'tap-target')
  expect(vs).toHaveLength(1)
  expect(vs[0].selector).toBe('a')
  expect(vs[0].message).toContain('16x16')
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/invariants-2.test.ts`
Expected: FAIL — 0 violations found for each rule (checks not implemented)

- [ ] **Step 4: Implement part 2 (append to `src/core/invariants.ts`, register in `CHECKS`)**

```ts
function textClip(tree: BuiltTree, out: Violation[]): void {
  walk(tree.root, (n) => {
    if (ignored(n) || !visible(n) || n.textBoxes.length === 0) return
    const clips = ['hidden', 'clip'].includes(n.styles['overflow-x'] ?? '')
    if (!clips || n.styles['text-overflow'] === 'ellipsis') return
    const padRight = Math.round(parseFloat(n.styles['padding-right'] ?? '0'))
    const innerRight = n.box.x + n.box.w - padRight
    const textRight = Math.max(...n.textBoxes.map((b) => b.x + b.w))
    if (textRight > innerRight + 1) {
      const snippet = (n.text ?? '').slice(0, 12)
      report(out, n, 'text-clip',
        `text "${snippet}…" clipped in ${selectorOf(n)}: text extends to ${textRight}px, container inner edge at ${innerRight}px, no text-overflow opt-in`,
        `CLIP:"${snippet}…"`)
    }
  })
}

// layering opt-in: positioned with explicit z-index, or transformed
const layered = (n: LayoutNode) =>
  ((n.styles['position'] ?? 'static') !== 'static' && (n.styles['z-index'] ?? 'auto') !== 'auto') ||
  (n.styles['transform'] ?? 'none') !== 'none' ||
  ['margin-top', 'margin-left'].some((m) => parseFloat(n.styles[m] ?? '0') < 0)

function overlap(tree: BuiltTree, out: Violation[]): void {
  // collect visible nodes with ancestry chains
  const entries: Array<{ n: LayoutNode; chain: Set<LayoutNode> }> = []
  const chainStack: LayoutNode[] = []
  const collect = (n: LayoutNode) => {
    chainStack.push(n)
    if (!ignored(n) && visible(n) && n.box.w > 0 && n.box.h > 0) {
      entries.push({ n, chain: new Set(chainStack) })
    }
    for (const c of n.children) collect(c)
    chainStack.pop()
  }
  collect(tree.root)

  // ponytail: O(n²) pair scan; spatial index if page size ever makes this slow
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j]
      if (a.chain.has(b.n) || b.chain.has(a.n)) continue // ancestor/descendant
      const ix = Math.min(a.n.box.x + a.n.box.w, b.n.box.x + b.n.box.w) - Math.max(a.n.box.x, b.n.box.x)
      const iy = Math.min(a.n.box.y + a.n.box.h, b.n.box.y + b.n.box.h) - Math.max(a.n.box.y, b.n.box.y)
      if (ix <= 4 || iy <= 4) continue // touching edges is not overlap
      // opt-in check on either element or its ancestors below the common ancestor
      const common = [...a.chain].filter((x) => b.chain.has(x))
      const commonSet = new Set(common)
      const optedIn = (e: { chain: Set<LayoutNode> }) =>
        [...e.chain].some((x) => !commonSet.has(x) && layered(x))
      if (optedIn(a) || optedIn(b)) continue
      report(out, b.n, 'overlap',
        `${selectorOf(b.n)} overlaps ${selectorOf(a.n)} by ${ix}x${iy}px with no layering opt-in (position+z-index, transform, or negative margin)`,
        `OVERLAP:${selectorOf(a.n)}`)
      j = entries.length // one report per element is enough signal
    }
  }
}

function tapTargets(tree: BuiltTree, out: Violation[]): void {
  walk(tree.root, (n) => {
    if (ignored(n) || !visible(n) || !INTERACTIVE.has(n.tag)) return
    if (n.box.w > 0 && n.box.h > 0 && (n.box.w < 24 || n.box.h < 24)) {
      report(out, n, 'tap-target', `interactive ${selectorOf(n)} is ${n.box.w}x${n.box.h}px — below the 24px minimum tap target`, `TAP:${n.box.w}x${n.box.h}`)
    }
  })
}
```

And update the registry line:
```ts
const CHECKS: Array<(tree: BuiltTree, out: Violation[]) => void> = [
  viewportOverflow, parentBleed, zeroSize, textClip, overlap, tapTargets,
]
```

- [ ] **Step 5: Run tests — new AND all previous (regression)**

Run: `npx vitest run`
Expected: ALL PASS. Watch the `clean page` test from Task 6 — the overlap check is the most false-positive-prone; if `basic` trips it, tighten `layered()` before touching thresholds.

- [ ] **Step 6: Commit**

```bash
git add src/core/invariants.ts test/invariants-2.test.ts fixtures/clip fixtures/overlap fixtures/tap
git commit -m "Added text-clip, overlap, and tap-target invariants"
```

---

### Task 8: Cascade tracing (`explain.ts`)

**Files:**
- Create: `src/core/explain.ts`
- Create: `fixtures/cascade/index.html`, `fixtures/cascade/reset.css`, `fixtures/cascade/sidebar.css`, `fixtures/cascade/main.css`
- Test: `test/explain.test.ts`

**Interfaces:**
- Consumes: `withPage` from Task 2.
- Produces:
  - `interface CascadeEntry { value: string; selector: string; specificity: string; important: boolean; file: string; line: number; status: 'winner' | 'overridden'; reason: string | null }`
  - `interface Explanation { selector: string; property: string; computed: string; declaredWinner: string | null; layoutNote: string | null; entries: CascadeEntry[] }`
  - `explain(client: any, selector: string, property: string): Promise<Explanation>`
  - `renderExplanation(e: Explanation): string` — the `✓/✗` text block from the spec.
  - `resolveNode(client: any, selector: string): Promise<number>` — nodeId lookup shared with Task 10; throws with nearest-match suggestions when the selector matches nothing.

- [ ] **Step 1: Write the fixtures**

`fixtures/cascade/reset.css`:
```css
div { width: 100%; }
```

`fixtures/cascade/sidebar.css`:
```css
.sidebar { width: 300px; }
```

`fixtures/cascade/main.css`:
```css
.grid { display: grid; grid-template-columns: 240px 1fr; }
```

`fixtures/cascade/index.html`:
```html
<!doctype html><html><head>
<link rel="stylesheet" href="reset.css">
<link rel="stylesheet" href="sidebar.css">
<link rel="stylesheet" href="main.css">
</head><body>
<main class="grid"><div class="sidebar"></div><div class="other"></div></main>
</body></html>
```

- [ ] **Step 2: Write the failing test**

`test/explain.test.ts`:
```ts
import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { explain, renderExplanation } from '../src/core/explain.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

test('traces winner with file:line, losers with reasons', async () => {
  const e = await withPage(`${srv.url}/cascade/index.html`, (c) => explain(c, '.sidebar', 'width'))
  expect(e.computed).toBe('240px')
  const winner = e.entries.find((x) => x.status === 'winner')!
  expect(winner.value).toBe('300px')
  expect(winner.file).toContain('sidebar.css')
  expect(winner.line).toBe(1)
  const loser = e.entries.find((x) => x.status === 'overridden')!
  expect(loser.value).toBe('100%')
  expect(loser.file).toContain('reset.css')
  expect(loser.reason).toContain('specificity')
  // declared 300px but computed 240px → layout constraint note
  expect(e.layoutNote).toContain('grid')
})

test('renderExplanation produces the ✓/✗ block', async () => {
  const e = await withPage(`${srv.url}/cascade/index.html`, (c) => explain(c, '.sidebar', 'width'))
  const text = renderExplanation(e)
  expect(text).toContain('.sidebar width = 240px')
  expect(text).toMatch(/✓ width: 300px\s+.*sidebar\.css:1/)
  expect(text).toMatch(/✗ width: 100%\s+.*reset\.css:1/)
})

test('unknown selector throws with suggestions', async () => {
  await expect(withPage(`${srv.url}/cascade/index.html`, (c) => explain(c, '.sidbar', 'width')))
    .rejects.toThrow(/No element matches '\.sidbar'/)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/explain.test.ts`
Expected: FAIL — cannot find `../src/core/explain.js`

- [ ] **Step 4: Implement `explain.ts`**

`src/core/explain.ts`:
```ts
export interface CascadeEntry {
  value: string
  selector: string
  specificity: string
  important: boolean
  file: string
  line: number
  status: 'winner' | 'overridden'
  reason: string | null
}

export interface Explanation {
  selector: string
  property: string
  computed: string
  declaredWinner: string | null
  layoutNote: string | null
  entries: CascadeEntry[]
}

interface SheetInfo { sourceURL: string; startLine: number; sourceMapURL: string | null }

async function collectSheets(client: any): Promise<Map<string, SheetInfo>> {
  const sheets = new Map<string, SheetInfo>()
  client.CSS.styleSheetAdded(({ header }: any) => {
    sheets.set(header.styleSheetId, {
      sourceURL: header.sourceURL || '<style>',
      startLine: header.startLine,
      sourceMapURL: header.sourceMapURL || null,
    })
  })
  await client.DOM.enable()
  await client.CSS.enable() // fires styleSheetAdded for existing sheets
  await new Promise((r) => setTimeout(r, 100)) // let events drain
  return sheets
}

export async function resolveNode(client: any, selector: string): Promise<number> {
  const { root } = await client.DOM.getDocument({ depth: -1 })
  const { nodeId } = await client.DOM.querySelector({ nodeId: root.nodeId, selector }).catch(() => ({ nodeId: 0 }))
  if (nodeId) return nodeId
  // suggestions: all class/id selectors present on the page
  const { result } = await client.Runtime.evaluate({
    expression: `[...new Set([...document.querySelectorAll('[class],[id]')].flatMap(e =>
      [...e.classList].map(c => '.' + c).concat(e.id ? ['#' + e.id] : [])))].slice(0, 20).join(' ')`,
    returnByValue: true,
  })
  throw new Error(`No element matches '${selector}'. Selectors on this page include: ${result.value}`)
}

const spec = (s: any) => (s?.specificity ? `(${s.specificity.a},${s.specificity.b},${s.specificity.c})` : '(?)')
const specRank = (s: any) => (s?.specificity ? s.specificity.a * 1e6 + s.specificity.b * 1e3 + s.specificity.c : 0)

export async function explain(client: any, selector: string, property: string): Promise<Explanation> {
  const sheets = await collectSheets(client)
  const nodeId = await resolveNode(client, selector)

  const { computedStyle } = await client.CSS.getComputedStyleForNode({ nodeId })
  const computed = computedStyle.find((p: any) => p.name === property)?.value ?? '(none)'

  const { matchedCSSRules = [], inline } = await client.CSS.getMatchedStylesForNode({ nodeId })
    .then((r: any) => ({ matchedCSSRules: r.matchedCSSRules, inline: r.inlineStyle }))

  type Raw = CascadeEntry & { order: number; rank: number }
  const raws: Raw[] = []

  matchedCSSRules.forEach((m: any, order: number) => {
    if (m.rule.origin !== 'regular') return // skip user-agent rules
    const decl = m.rule.style.cssProperties.find((p: any) => p.name === property && !p.disabled && p.text)
    if (!decl) return
    const matched = m.rule.selectorList.selectors[m.matchingSelectors[0]]
    const info = sheets.get(m.rule.styleSheetId)
    const range = decl.range ?? m.rule.style.range
    raws.push({
      value: decl.value.replace(/\s*!important/, ''),
      selector: matched?.text ?? m.rule.selectorList.text,
      specificity: spec(matched),
      important: Boolean(decl.important),
      file: info?.sourceURL ?? '(unknown)',
      line: (info?.startLine ?? 0) + (range?.startLine ?? 0) + 1,
      status: 'overridden',
      reason: null,
      order,
      rank: specRank(matched),
    })
  })

  if (inline?.cssProperties?.some((p: any) => p.name === property && p.text)) {
    const decl = inline.cssProperties.find((p: any) => p.name === property)
    raws.push({
      value: decl.value, selector: '(inline style)', specificity: '(inline)',
      important: Boolean(decl.important), file: '(inline)', line: 0,
      status: 'overridden', reason: null, order: Number.MAX_SAFE_INTEGER, rank: Number.MAX_SAFE_INTEGER,
    })
  }

  // cascade: important first, then specificity, then source order (later wins)
  raws.sort((a, b) =>
    Number(b.important) - Number(a.important) || b.rank - a.rank || b.order - a.order)

  const entries = raws.map((r, i) => {
    const { order: _o, rank: _r, ...entry } = r
    if (i === 0) return { ...entry, status: 'winner' as const }
    const w = raws[0]
    const reason = w.important && !r.important ? 'lost: !important beats it'
      : w.rank !== r.rank ? `lost: lower specificity ${r.specificity} vs ${w.specificity}`
      : 'lost: earlier in source order'
    return { ...entry, status: 'overridden' as const, reason }
  })

  const declaredWinner = entries[0]?.value ?? null
  const layoutNote = declaredWinner !== null && declaredWinner !== computed
    ? `computed ${computed} differs from declared ${declaredWinner} — layout constraints override (parent grid/flex track sizing, min/max, or stretch)`
    : null

  return { selector, property, computed, declaredWinner, layoutNote, entries }
}

export function renderExplanation(e: Explanation): string {
  const lines = [`${e.selector} ${e.property} = ${e.computed}`]
  for (const x of e.entries) {
    const mark = x.status === 'winner' ? '✓' : '✗'
    const src = x.file === '(inline)' ? '(inline style)' : `${x.file.split('/').pop()}:${x.line}`
    const note = x.status === 'winner' ? (e.layoutNote ? ` — ${e.layoutNote}` : '') : ` — ${x.reason}`
    lines.push(`  ${mark} ${e.property}: ${x.value}${x.important ? ' !important' : ''}   ${src} (${x.selector} ${x.specificity})${note}`)
  }
  if (e.entries.length === 0) lines.push(`  (no author rule sets ${e.property}; value is inherited or the default)`)
  return lines.join('\n')
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/explain.test.ts`
Expected: PASS (3 tests). Two known CDP quirks to check if it fails: (1) `matchedCSSRules` order is least→most specific per the protocol — our sort makes us independent of it; (2) `decl.range` is only present for declarations physically in the stylesheet text (not shorthand expansions) — the `?? m.rule.style.range` fallback covers it.

- [ ] **Step 6: Commit**

```bash
git add src/core/explain.ts test/explain.test.ts fixtures/cascade
git commit -m "Added cascade tracing with winner/loser reasons and file:line sources"
```

---

### Task 9: Source-map resolution (`explain.ts` + `sourcemap.ts`)

**Files:**
- Create: `src/core/sourcemap.ts`
- Modify: `src/core/explain.ts` (resolve `file:line` through source map when present)
- Create: `fixtures/sourcemap/input.css` + built artifacts (one-time esbuild run, committed)
- Test: `test/sourcemap.test.ts`

**Interfaces:**
- Produces:
  - `parseSourceMap(json: string): SourceMap` and `originalPosition(map: SourceMap, line: number, column: number): { source: string; line: number } | null` (0-indexed inputs, 1-indexed output line).
  - `explain()` now returns original `file:line` when the stylesheet has a source map; falls back silently to generated position otherwise.

- [ ] **Step 1: Write the fixture and build it once**

`fixtures/sourcemap/input.css`:
```css
/* original source file */
body { margin: 0; }

h1 {
  color: rgb(200, 0, 0);
  font-size: 32px;
}
```

Build (one-time; commit the outputs):
```bash
npx esbuild fixtures/sourcemap/input.css --outfile=fixtures/sourcemap/built.css --sourcemap --minify
```

`fixtures/sourcemap/index.html`:
```html
<!doctype html><html><head><link rel="stylesheet" href="built.css"></head>
<body><h1>Mapped</h1></body></html>
```

- [ ] **Step 2: Write the failing test**

`test/sourcemap.test.ts`:
```ts
import { afterAll, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { explain } from '../src/core/explain.js'
import { parseSourceMap, originalPosition } from '../src/core/sourcemap.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

test('decodes VLQ mappings from the committed map', () => {
  const map = parseSourceMap(readFileSync('fixtures/sourcemap/built.css.map', 'utf8'))
  expect(map.sources.some((s) => s.includes('input.css'))).toBe(true)
  // minified output is one line; color decl maps back to input.css line 5
  const pos = originalPosition(map, 0, 20) // any column inside the h1 rule
  expect(pos?.source).toContain('input.css')
})

test('explain resolves through the source map to input.css', async () => {
  const e = await withPage(`${srv.url}/sourcemap/index.html`, (c) => explain(c, 'h1', 'color'))
  const winner = e.entries.find((x) => x.status === 'winner')!
  expect(winner.file).toContain('input.css')
  expect(winner.line).toBe(5) // the color declaration's line in the ORIGINAL file
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/sourcemap.test.ts`
Expected: FAIL — cannot find `../src/core/sourcemap.js`

- [ ] **Step 4: Implement the decoder**

`src/core/sourcemap.ts`:
```ts
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
```

- [ ] **Step 5: Wire into `explain.ts`**

In `collectSheets`, nothing changes. In `explain()`, after building `raws`, add source-map resolution (before sorting). Add near the top of the file:

```ts
import { originalPosition, parseSourceMap, type SourceMap } from './sourcemap.js'

const mapCache = new Map<string, SourceMap | null>()

async function loadMap(sheetURL: string, mapURL: string): Promise<SourceMap | null> {
  const abs = new URL(mapURL, sheetURL).href
  if (!mapCache.has(abs)) {
    try {
      const json = abs.startsWith('data:')
        ? Buffer.from(abs.split(',')[1], 'base64').toString()
        : await (await fetch(abs)).text()
      mapCache.set(abs, parseSourceMap(json))
    } catch { mapCache.set(abs, null) }
  }
  return mapCache.get(abs)!
}
```

Then inside the `matchedCSSRules.forEach` push, replace the `file`/`line` fields with resolved values — change the loop to build the entry, then before `raws.push(...)`:

```ts
// resolve through source map when the sheet has one
// (decl range is 0-indexed within the sheet; header startLine offsets inline <style>)
```

Because the loop callback is sync, restructure: collect rule data in the forEach, then a `for … of` with `await` resolves maps:

```ts
for (const r of raws) {
  const info = [...sheets.values()].find((s) => s.sourceURL === r.file)
  if (!info?.sourceMapURL || r.line === 0) continue
  const map = await loadMap(info.sourceURL, info.sourceMapURL)
  const orig = map && originalPosition(map, r.line - 1 - info.startLine, 0)
  if (orig) { r.file = orig.source; r.line = orig.line }
}
```

Note: `originalPosition` here is called with column 0 as an approximation; for exact columns store `range.startColumn` on the raw entry alongside `line` and pass it through. Do that: add `col: range?.startColumn ?? 0` to the raw entry and use it in the call.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/sourcemap.test.ts && npx vitest run test/explain.test.ts`
Expected: BOTH PASS (source-map test resolves to `input.css:5`; cascade test still passes — its sheets have no maps, fallback path).

- [ ] **Step 7: Commit**

```bash
git add src/core/sourcemap.ts src/core/explain.ts test/sourcemap.test.ts fixtures/sourcemap
git commit -m "Added source-map resolution for cascade traces"
```

---

### Task 10: Element deep-dive (`inspect.ts`)

**Files:**
- Create: `src/core/inspect.ts`
- Test: `test/inspect.test.ts`

**Interfaces:**
- Consumes: `resolveNode`, `explain`, `renderExplanation` from Tasks 8–9.
- Produces: `inspect(client: any, selector: string): Promise<string>` — text report: box model (content/padding/border/margin per side), non-default computed styles (diffed against a fresh element of the same tag), stacking-context reason, and `explain` summaries for `width` and `height`.

- [ ] **Step 1: Write the failing test**

`test/inspect.test.ts`:
```ts
import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { inspect } from '../src/core/inspect.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

test('reports box model, non-default styles, and size explanation', async () => {
  const text = await withPage(`${srv.url}/basic/index.html`, (c) => inspect(c, '.content'))
  expect(text).toContain('section.content')
  expect(text).toContain('padding: 32')          // box model side
  expect(text).toContain('height: 400px')        // non-default computed style
  expect(text).not.toContain('cursor:')          // default styles excluded
  expect(text).toContain('width = 1040px')       // explain summary embedded
})

test('reports stacking context reason when present', async () => {
  const text = await withPage(`${srv.url}/overlap/index.html`, (c) => inspect(c, '.modal'))
  expect(text).toMatch(/stacking context: yes \(position \+ z-index\)/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/inspect.test.ts`
Expected: FAIL — cannot find `../src/core/inspect.js`

- [ ] **Step 3: Implement `inspect.ts`**

`src/core/inspect.ts`:
```ts
import { explain, renderExplanation, resolveNode } from './explain.js'

const NON_DEFAULTS = `((sel) => {
  const el = document.querySelector(sel)
  const probe = document.createElement(el.tagName)
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const cs = getComputedStyle(el), ds = getComputedStyle(probe)
  const out = {}
  for (const p of cs) {
    if (p === 'display') { out[p] = cs.getPropertyValue(p); continue }
    if (cs.getPropertyValue(p) !== ds.getPropertyValue(p)) out[p] = cs.getPropertyValue(p)
  }
  probe.remove()
  return out
})`

function stackingReason(styles: Record<string, string>): string | null {
  if (styles['position'] !== 'static' && styles['z-index'] !== 'auto') return 'position + z-index'
  if (styles['transform'] && styles['transform'] !== 'none') return 'transform'
  if (parseFloat(styles['opacity'] ?? '1') < 1) return 'opacity < 1'
  if (styles['isolation'] === 'isolate') return 'isolation: isolate'
  if (styles['filter'] && styles['filter'] !== 'none') return 'filter'
  return null
}

const side = (q: number[], i: number[]) => [
  Math.round(i[1] - q[1]), Math.round(q[2] - i[2]),   // top, right
  Math.round(q[5] - i[5]), Math.round(i[0] - q[0]),   // bottom, left
]

export async function inspect(client: any, selector: string): Promise<string> {
  const nodeId = await resolveNode(client, selector)

  const { result } = await client.Runtime.evaluate({
    expression: `${NON_DEFAULTS}(${JSON.stringify(selector)})`, returnByValue: true,
  })
  const styles: Record<string, string> = result.value ?? {}

  const { model } = await client.DOM.getBoxModel({ nodeId })
  const [pt, pr, pb, pl] = side(model.padding, model.content)
  const [bt, br, bb, bl] = side(model.border, model.padding)
  const [mt, mr, mb, ml] = side(model.margin, model.border)

  const desc = await client.DOM.describeNode({ nodeId })
  const tag = desc.node.localName
  const idAttr = desc.node.attributes?.includes('id')
    ? '#' + desc.node.attributes[desc.node.attributes.indexOf('id') + 1] : ''
  const cls = desc.node.attributes?.includes('class')
    ? '.' + desc.node.attributes[desc.node.attributes.indexOf('class') + 1].split(/\s+/).join('.') : ''

  const reason = stackingReason(styles)
  const lines = [
    `${tag}${idAttr}${cls}  content ${Math.round(model.width)}x${Math.round(model.height)}`,
    `  padding: ${pt} ${pr} ${pb} ${pl} | border: ${bt} ${br} ${bb} ${bl} | margin: ${mt} ${mr} ${mb} ${ml}`,
    `  stacking context: ${reason ? `yes (${reason})` : 'no'}`,
    '',
    '  non-default styles:',
    ...Object.entries(styles).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `    ${k}: ${v}`),
    '',
  ]
  for (const prop of ['width', 'height'] as const) {
    lines.push(renderExplanation(await explain(client, selector, prop)).split('\n').map((l) => '  ' + l).join('\n'))
  }
  return lines.join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/inspect.test.ts`
Expected: PASS (2 tests). Gotcha: `DOM.getBoxModel` quads are `[x1,y1,x2,y2,x3,y3,x4,y4]` clockwise from top-left; the `side()` math assumes axis-aligned boxes (fine — v1 has no transforms in fixtures). Note: `explain()` re-enables CSS per call; CDP tolerates repeated enables.

- [ ] **Step 5: Commit**

```bash
git add src/core/inspect.ts test/inspect.test.ts
git commit -m "Added single-element inspection with box model and non-default styles"
```

---

### Task 11: Snapshots and structural diff (`snapshot.ts`)

**Files:**
- Create: `src/core/snapshot.ts`
- Create: `fixtures/diff/before.html`, `fixtures/diff/after.html`
- Test: `test/snapshot.test.ts`

**Interfaces:**
- Consumes: LayoutTree text format from Task 5 (parses it back).
- Produces:
  - `saveSnapshot(text: string, name: string, dir?: string): string` — writes `<dir ?? '.bettercss'>/<name>.tree`, returns the path.
  - `loadSnapshot(name: string, dir?: string): string`
  - `diffTrees(oldText: string, newText: string): DiffEntry[]` where `interface DiffEntry { kind: 'moved' | 'resized' | 'appeared' | 'disappeared'; key: string; detail: string }`
  - `renderDiff(entries: DiffEntry[]): string` — one line per change, `(no layout changes)` when empty.

- [ ] **Step 1: Write the fixtures**

`fixtures/diff/before.html`:
```html
<!doctype html><html><head><style>
* { margin: 0; box-sizing: border-box; }
header { display: flex; padding: 12px 24px; height: 64px; }
nav { margin-left: auto; width: 316px; height: 24px; background: #eee; }
footer { height: 40px; }
</style></head><body>
<header id="top"><nav></nav></header><footer></footer>
</body></html>
```

`fixtures/diff/after.html` — same but `padding: 12px 32px;` (nav shifts left 8px) and no `<footer>`.

- [ ] **Step 2: Write the failing test**

`test/snapshot.test.ts`:
```ts
import { afterAll, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveFixtures } from './helpers/server.js'
import { withPage, shutdownChrome } from '../src/core/connect.js'
import { extract } from '../src/core/extract.js'
import { buildTree, renderTree } from '../src/core/tree.js'
import { saveSnapshot, loadSnapshot, diffTrees, renderDiff } from '../src/core/snapshot.js'

const srv = await serveFixtures('fixtures')
afterAll(async () => { srv.close(); await shutdownChrome() })

const render = (path: string) =>
  withPage(`${srv.url}${path}`, async (c) => renderTree(buildTree(await extract(c))))

test('save/load round-trips', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bettercss-test-'))
  const text = await render('/diff/before.html')
  const file = saveSnapshot(text, 'before', dir)
  expect(file).toBe(join(dir, 'before.tree'))
  expect(loadSnapshot('before', dir)).toBe(text)
})

test('diff reports moved, resized nothing falsely, and disappeared', async () => {
  const before = await render('/diff/before.html')
  const after = await render('/diff/after.html')
  const entries = diffTrees(before, after)
  const moved = entries.find((e) => e.kind === 'moved' && e.key.includes('nav'))!
  expect(moved.detail).toContain('-8') // nav x shifted left by 8
  expect(entries.find((e) => e.kind === 'disappeared' && e.key.includes('footer'))).toBeTruthy()
  expect(entries.filter((e) => e.kind === 'resized')).toHaveLength(0)
})

test('identical trees diff empty', async () => {
  const a = await render('/diff/before.html')
  expect(diffTrees(a, a)).toEqual([])
  expect(renderDiff([])).toBe('(no layout changes)')
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/snapshot.test.ts`
Expected: FAIL — cannot find `../src/core/snapshot.js`

- [ ] **Step 4: Implement `snapshot.ts`**

`src/core/snapshot.ts`:
```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
  return readFileSync(join(dir, `${name}.tree`), 'utf8')
}

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
    if (collapsed) continue
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/snapshot.test.ts`
Expected: PASS (3 tests). The `LINE` regex must match exactly what `renderTree` emits — if a parse-miss drops nodes, diff the regex against real render output first.

- [ ] **Step 6: Commit**

```bash
git add src/core/snapshot.ts test/snapshot.test.ts fixtures/diff
git commit -m "Added layout snapshots with structural diff"
```

---

### Task 12: CLI (`cli.ts`)

**Files:**
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: everything from `src/core/*`.
- Produces: `bettercss <layout|inspect|explain|check|snapshot|diff> <url> [args] [--selector S] [--property P] [--depth N] [--name NAME] [--dir DIR] [--port N]`. `check` exits 1 when violations exist; everything else exits 0 on success. `check`'s output appends the winning `width` rule (`explain`) for `viewport-overflow`, `parent-bleed`, and `text-clip` violations.

- [ ] **Step 1: Write the failing test**

`test/cli.test.ts` (drives the CLI as a subprocess via tsx — the real code path):
```ts
import { afterAll, expect, test } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { serveFixtures } from './helpers/server.js'

const run = promisify(execFile)
const srv = await serveFixtures('fixtures')
afterAll(() => srv.close())

const cli = (...args: string[]) =>
  run('npx', ['tsx', 'src/cli.ts', ...args], { encoding: 'utf8' })

test('layout prints the tree', async () => {
  const { stdout } = await cli('layout', `${srv.url}/basic/index.html`)
  expect(stdout).toContain('header#top (0,0 1280x64)')
}, 60_000)

test('check exits 1 with violations and names a suspect rule', async () => {
  const err = await cli('check', `${srv.url}/overflow-h/index.html`).catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout).toContain('viewport-overflow')
  expect(err.stdout).toContain('div.wide')
  expect(err.stdout).toMatch(/suspect: width: 1400px/)
}, 60_000)

test('check exits 0 on a clean page', async () => {
  const { stdout } = await cli('check', `${srv.url}/basic/index.html`)
  expect(stdout).toContain('no violations')
}, 60_000)

test('explain traces the cascade', async () => {
  const { stdout } = await cli('explain', `${srv.url}/cascade/index.html`, '--selector', '.sidebar', '--property', 'width')
  expect(stdout).toContain('✓ width: 300px')
}, 60_000)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — tsx cannot find `src/cli.ts`

- [ ] **Step 3: Implement `cli.ts`**

`src/cli.ts`:
```ts
#!/usr/bin/env node
import { shutdownChrome, withPage } from './core/connect.js'
import { extract } from './core/extract.js'
import { buildTree, renderTree } from './core/tree.js'
import { checkInvariants, type Violation } from './core/invariants.js'
import { explain, renderExplanation } from './core/explain.js'
import { inspect } from './core/inspect.js'
import { diffTrees, loadSnapshot, renderDiff, saveSnapshot } from './core/snapshot.js'

const USAGE = `bettercss <command> <url> [options]
  layout    <url> [--selector S] [--depth N]   print the LayoutTree
  inspect   <url> --selector S                 deep-dive one element
  explain   <url> --selector S --property P    trace a property to its source rule
  check     <url>                              run invariants (exit 1 on violations)
  snapshot  <url> --name NAME [--dir DIR]      lock current LayoutTree to a .tree file
  diff      <url> --name NAME [--dir DIR]      diff current layout vs snapshot
  options: --port N (attach to Chrome at port N instead of 9222/headless)`

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i]
  }
  return out
}

const SUSPECT_RULES = new Set(['viewport-overflow', 'parent-bleed', 'text-clip'])

async function main(): Promise<number> {
  const [cmd, url] = process.argv.slice(2)
  const f = flags(process.argv.slice(4))
  if (!cmd || !url) { console.log(USAGE); return 2 }
  const opts = { port: f.port ? Number(f.port) : undefined }

  const output = await withPage(url, async (client) => {
    switch (cmd) {
      case 'layout': {
        const tree = buildTree(await extract(client))
        checkInvariants(tree) // populate inline ⚠ warnings
        return renderTree(tree, { depth: f.depth ? Number(f.depth) : undefined })
      }
      case 'inspect': return inspect(client, f.selector)
      case 'explain': return renderExplanation(await explain(client, f.selector, f.property))
      case 'check': {
        const violations = checkInvariants(buildTree(await extract(client)))
        if (!violations.length) return 'no violations'
        const lines: string[] = []
        for (const v of violations) {
          lines.push(`${v.rule}: ${v.message}`)
          if (SUSPECT_RULES.has(v.rule)) {
            const e = await explain(client, v.selector, 'width').catch(() => null)
            const w = e?.entries.find((x) => x.status === 'winner')
            if (w) lines.push(`  suspect: width: ${w.value} @ ${w.file.split('/').pop()}:${w.line}`)
          }
        }
        process.exitCode = 1
        return lines.join('\n')
      }
      case 'snapshot': {
        const tree = buildTree(await extract(client))
        checkInvariants(tree)
        return `saved ${saveSnapshot(renderTree(tree), f.name, f.dir)}`
      }
      case 'diff': {
        const tree = buildTree(await extract(client))
        checkInvariants(tree)
        return renderDiff(diffTrees(loadSnapshot(f.name, f.dir), renderTree(tree)))
      }
      default: return USAGE
    }
  }, opts)

  console.log(output)
  return process.exitCode ?? 0
}

main()
  .catch((err) => { console.error(err.message); process.exitCode = 2 })
  .finally(() => shutdownChrome())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS (4 tests). Each CLI invocation launches its own headless Chrome (subprocess) — slower than the other suites; the 60 s timeouts cover it.

- [ ] **Step 5: Full regression**

Run: `npx vitest run`
Expected: ALL test files PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "Added CLI mirroring the six core commands"
```

---

### Task 13: MCP server (`mcp.ts`) + README

**Files:**
- Create: `src/mcp.ts`
- Create: `README.md`
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: everything from `src/core/*`.
- Produces: MCP stdio server `bettercss` with tools `layout`, `inspect`, `explain`, `check`, `snapshot`, `diff` — same parameters as the CLI, each returning one text content block. `layout`/`check`/`snapshot`/`diff` results end with a `note: page was still loading at the 10s cap` line when `pageWasBusy` is true.

- [ ] **Step 1: Write the failing test**

`test/mcp.test.ts` (real MCP client over stdio — the actual protocol):
```ts
import { afterAll, expect, test } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { serveFixtures } from './helpers/server.js'

const srv = await serveFixtures('fixtures')
const client = new Client({ name: 'test', version: '0' })
await client.connect(new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp.ts'] }))
afterAll(async () => { await client.close(); srv.close() })

test('lists all six tools', async () => {
  const { tools } = await client.listTools()
  expect(tools.map((t) => t.name).sort())
    .toEqual(['check', 'diff', 'explain', 'inspect', 'layout', 'snapshot'])
})

test('layout tool returns the tree', async () => {
  const res = await client.callTool({ name: 'layout', arguments: { url: `${srv.url}/basic/index.html` } })
  const text = (res.content as any)[0].text
  expect(text).toContain('header#top (0,0 1280x64)')
}, 60_000)

test('explain tool traces cascade', async () => {
  const res = await client.callTool({
    name: 'explain',
    arguments: { url: `${srv.url}/cascade/index.html`, selector: '.sidebar', property: 'width' },
  })
  expect((res.content as any)[0].text).toContain('✓ width: 300px')
}, 60_000)

test('check tool reports violations', async () => {
  const res = await client.callTool({ name: 'check', arguments: { url: `${srv.url}/overflow-h/index.html` } })
  expect((res.content as any)[0].text).toContain('viewport-overflow')
}, 60_000)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mcp.test.ts`
Expected: FAIL — transport cannot start (`src/mcp.ts` missing)

- [ ] **Step 3: Implement `mcp.ts`**

`src/mcp.ts`:
```ts
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { pageWasBusy, withPage } from './core/connect.js'
import { extract } from './core/extract.js'
import { buildTree, renderTree } from './core/tree.js'
import { checkInvariants } from './core/invariants.js'
import { explain, renderExplanation } from './core/explain.js'
import { inspect } from './core/inspect.js'
import { diffTrees, loadSnapshot, renderDiff, saveSnapshot } from './core/snapshot.js'

const server = new McpServer({ name: 'bettercss', version: '0.1.0' })

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const url = z.string().describe('Page URL (usually your dev server)')
const port = z.number().optional().describe('Chrome debugging port (default: 9222 or auto-launched headless)')

function page<T>(u: string, p: number | undefined, fn: (client: any) => Promise<string>) {
  return withPage(u, async (client) => {
    let out = await fn(client)
    if (pageWasBusy(client)) out += '\nnote: page was still loading at the 10s cap; results may be early'
    return text(out)
  }, { port: p })
}

server.tool('layout', 'Compact deterministic layout tree of the rendered page: positions, sizes, layout modes, inline ⚠ warnings. THE ground-truth view — read this before and after CSS changes.',
  { url, port, selector: z.string().optional().describe('Scope to this element'), depth: z.number().optional().describe('Max tree depth') },
  ({ url: u, port: p, selector, depth }) => page(u, p, async (client) => {
    const tree = buildTree(await extract(client))
    checkInvariants(tree)
    let from
    if (selector) {
      const { walk, selectorOf } = await import('./core/tree.js')
      walk(tree.root, (n) => { if (!from && (selectorOf(n) === selector || n.id === selector.replace('#', ''))) from = n })
      if (!from) return `No element matching '${selector}' in the layout tree. Run layout without a selector to see what exists.`
    }
    return renderTree(tree, { depth, from })
  }))

server.tool('inspect', 'Deep-dive ONE element: box model, every non-default computed style, stacking context, and why it has its width/height.',
  { url, port, selector: z.string().describe('CSS selector of the element') },
  ({ url: u, port: p, selector }) => page(u, p, (client) => inspect(client, selector)))

server.tool('explain', 'Trace one CSS property to its source: which rule wins (file:line, source-mapped), which rules lost and why (specificity/order/importance), and whether layout constraints override the declared value.',
  { url, port, selector: z.string(), property: z.string().describe("e.g. 'width'") },
  ({ url: u, port: p, selector, property }) => page(u, p, async (client) =>
    renderExplanation(await explain(client, selector, property))))

server.tool('check', 'Run layout invariants (overflow, bleed, clipped text, unintended overlap, zero-size/tiny interactive elements). Violations are ALWAYS bugs — fix them.',
  { url, port },
  ({ url: u, port: p }) => page(u, p, async (client) => {
    const violations = checkInvariants(buildTree(await extract(client)))
    return violations.length
      ? violations.map((v) => `${v.rule}: ${v.message}`).join('\n')
      : 'no violations'
  }))

server.tool('snapshot', 'Lock the current layout as a named .tree snapshot for later diffing. Do this when the page looks CORRECT.',
  { url, port, name: z.string(), dir: z.string().optional().describe('Snapshot dir (default .bettercss)') },
  ({ url: u, port: p, name, dir }) => page(u, p, async (client) => {
    const tree = buildTree(await extract(client))
    checkInvariants(tree)
    return `saved ${saveSnapshot(renderTree(tree), name, dir)}`
  }))

server.tool('diff', 'Structural diff of the current layout vs a named snapshot: what moved/resized/appeared/disappeared, in px. Run after every CSS change to see its actual effect.',
  { url, port, name: z.string(), dir: z.string().optional() },
  ({ url: u, port: p, name, dir }) => page(u, p, async (client) => {
    const tree = buildTree(await extract(client))
    checkInvariants(tree)
    return renderDiff(diffTrees(loadSnapshot(name, dir), renderTree(tree)))
  }))

await server.connect(new StdioServerTransport())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/mcp.test.ts`
Expected: PASS (4 tests). If the SDK's `server.tool(name, description, schema, handler)` overload signature differs in the installed version, check `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` (Read the Source) and adjust — do not downgrade the SDK.

- [ ] **Step 5: Write README.md**

```markdown
# bettercss

Hard ground truth for CSS. Extracts the browser's actual layout — positions,
boxes, cascade — as deterministic, diffable text, so coding agents stop
guessing what rendered.

## Install

npm install && npm run build
Requires Chrome. Attaches to a running Chrome at port 9222, else launches headless.

## MCP (live agent loop)

Add to `.mcp.json`:

{
  "mcpServers": {
    "bettercss": { "command": "node", "args": ["/path/to/better_css/dist/mcp.js"] }
  }
}

Tools: `layout`, `inspect`, `explain`, `check`, `snapshot`, `diff`.

## CLI (CI / scripts)

npx bettercss check http://localhost:3000            # invariants, exit 1 on violations
npx bettercss layout http://localhost:3000           # the layout tree
npx bettercss explain http://localhost:3000 --selector .sidebar --property width
npx bettercss snapshot http://localhost:3000 --name home
npx bettercss diff http://localhost:3000 --name home

## Escape hatch

`data-bettercss-ignore` on an element skips it in all invariant checks.
```

- [ ] **Step 6: Full regression + build check**

Run: `npx vitest run && npm run build`
Expected: ALL PASS; tsc emits `dist/` cleanly.

- [ ] **Step 7: Commit**

```bash
git add src/mcp.ts test/mcp.test.ts README.md
git commit -m "Added MCP server exposing the six ground-truth tools"
```

---

## Self-Review (completed at plan time)

1. **Spec coverage:** extraction (T3–4), LayoutTree format incl. collapse/determinism/inline warnings (T5), all 6 invariants + escape hatch (T6–7), cascade trace w/ file:line + specificity reasons + layout-constraint note (T8), source maps (T9), inspect (T10), snapshot/diff (T11), CLI (T12), MCP + suspect-rule reporting in `check` + busy-page note (T12–13). Spec's `diff` cause-naming is covered by `check`+`explain` composition rather than automatic per-diff-entry explains — deliberate v1 trim: the old page is gone by diff time, so "cause" can only name the *current* winner; the agent gets that via one `explain` call on the moved element.
2. **Placeholder scan:** none — every step has full code, exact commands, expected outcomes.
3. **Type consistency:** `Violation.rule` union matches both invariant tasks; `withPage`/`pageWasBusy` signatures consistent T2→T12/13; `renderTree(tree, { depth, from })` consistent T5→T13; `saveSnapshot/loadSnapshot(name, dir)` consistent T11→T12/13; `resolveNode` shared T8→T10.
