#!/usr/bin/env node
import { parseViewport, shutdownChrome, withPage } from './core/connect.js'
import { extract } from './core/extract.js'
import { buildTree, findNode, renderTree } from './core/tree.js'
import { checkInvariants, renderViolations } from './core/invariants.js'
import { explain, renderExplanation } from './core/explain.js'
import { inspect } from './core/inspect.js'
import { diffTrees, loadSnapshot, renderDiff, saveSnapshot } from './core/snapshot.js'

const USAGE = `bettercss <command> <url> [options]
  layout    <url> [--selector S] [--depth N]   print the LayoutTree (budgeted to 400 lines unless --depth is given)
  inspect   <url> --selector S                 deep-dive one element
  explain   <url> --selector S --property P    trace a property to its source rule
  check     <url>                              run invariants (exit 1 on violations)
  snapshot  <url> --name NAME [--dir DIR]      lock current LayoutTree to a .tree file
  diff      <url> --name NAME [--dir DIR]      diff current layout vs snapshot
  options: --port N (attach to Chrome at port N instead of 9222/headless)
           --viewport WxH (emulated viewport size, e.g. 1280x800)`

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i]
  }
  return out
}

const REQUIRED: Record<string, string[]> = {
  inspect: ['selector'],
  explain: ['selector', 'property'],
  snapshot: ['name'],
  diff: ['name'],
}

async function main(): Promise<number> {
  const [cmd, url] = process.argv.slice(2)
  const f = flags(process.argv.slice(4))
  if (!cmd || !url) { console.error(USAGE); return 2 }
  if (!['layout', 'inspect', 'explain', 'check', 'snapshot', 'diff'].includes(cmd)) {
    console.error(USAGE)
    return 2
  }
  for (const name of REQUIRED[cmd] ?? []) {
    if (!f[name]) {
      console.error(`${cmd} requires --${name}\n\n${USAGE}`)
      return 2
    }
  }
  for (const name of ['depth', 'port']) {
    if (f[name] !== undefined && Number.isNaN(Number(f[name]))) {
      console.error(`--${name} must be a number, got '${f[name]}'`)
      return 2
    }
  }
  let viewport: { width: number; height: number } | undefined
  if (f.viewport !== undefined) {
    try { viewport = parseViewport(f.viewport) }
    catch (err) { console.error((err as Error).message); return 2 }
  }
  const opts = { port: f.port ? Number(f.port) : undefined, viewport }

  const output = await withPage(url, async (client) => {
    switch (cmd) {
      case 'layout': {
        const tree = buildTree(await extract(client))
        checkInvariants(tree) // populate inline ⚠ warnings
        const from = f.selector ? findNode(tree, f.selector) : undefined
        if (f.selector && !from) throw new Error(`No element matching '${f.selector}' in the layout tree.`)
        const depth = f.depth ? Number(f.depth) : undefined
        return renderTree(tree, { depth, from, budget: depth === undefined ? 400 : undefined })
      }
      case 'inspect': return inspect(client, f.selector)
      case 'explain': return renderExplanation(await explain(client, f.selector, f.property))
      case 'check': {
        const violations = checkInvariants(buildTree(await extract(client)))
        if (violations.length) process.exitCode = 1
        return renderViolations(client, violations)
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
  return Number(process.exitCode ?? 0)
}

main()
  .then((code) => { process.exitCode = code })
  .catch((err) => { console.error(err.message); process.exitCode = 2 })
  .finally(() => shutdownChrome())
