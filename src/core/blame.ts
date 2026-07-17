import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { shutdownChrome, withPage } from './connect.js'
import { extract } from './extract.js'
import { buildTree, renderTree } from './tree.js'
import { checkInvariants, type Violation } from './invariants.js'
import { diffTrees, renderDiff } from './snapshot.js'
import { serveFixtures } from './serve.js'

export interface BlameOpts {
  selector?: string
  maxCommits?: number // default 25
  viewport?: { width: number; height: number }
  port?: number
}

interface CommitInfo { sha: string; short: string; subject: string; date: string; author: string }

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim()
}

// git -C resolves the repo root even when --root points at a subdirectory of the repo
// (contract: "works when root is a subdirectory of the repo").
function repoRootOf(dir: string): string {
  try {
    return git(dir, ['rev-parse', '--show-toplevel'])
  } catch {
    throw new Error(`'${dir}' is not inside a git repository — blame needs git history to walk`)
  }
}

const SEP = '\x1f' // unit separator: never appears in a commit subject/author

function commitInfo(repoRoot: string, sha: string): CommitInfo {
  const [full, short, subject, date, author] = git(repoRoot, ['log', '-1', `--format=%H${SEP}%h${SEP}%s${SEP}%ar${SEP}%an`, sha]).split(SEP)
  return { sha: full, short, subject, date, author }
}

// HEAD's ancestors, newest first — HEAD itself included only when the working tree has
// uncommitted changes (the disk state the caller measured isn't HEAD's committed state
// then, so HEAD must be walked like any other commit). Linear walk only (--first-parent):
// a throwaway/scripted history is linear, and layout states can flicker commit-to-commit,
// so bisect would be unsound here anyway (contract's own reasoning).
function ancestors(repoRoot: string, maxCommits: number, includeHead: boolean): CommitInfo[] {
  const out = git(repoRoot, ['log', '--first-parent', `--skip=${includeHead ? 0 : 1}`, '-n', String(maxCommits), `--format=%H${SEP}%h${SEP}%s${SEP}%ar${SEP}%an`])
  if (!out) return []
  return out.split('\n').map((line) => {
    const [full, short, subject, date, author] = line.split(SEP)
    return { sha: full, short, subject, date, author }
  })
}

function removeWorktree(repoRoot: string, path: string): void {
  try { execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', path], { stdio: 'pipe' }) } catch {}
  try { execFileSync('git', ['-C', repoRoot, 'worktree', 'prune'], { stdio: 'pipe' }) } catch {}
  try { rmSync(path, { recursive: true, force: true }) } catch {}
}

interface CheckResult { violations: Violation[]; tree: string; misses: string[] }

// Serves `dir` and runs the same check the rest of csstruth runs, scoped to one page and
// (if given) filtered to a selector's subtree — same substring convention fix.ts's
// --selector uses, so a page:selector pair means the same thing across both commands.
async function checkAt(dir: string, page: string, selector: string | undefined, viewport: { width: number; height: number } | undefined, port: number | undefined): Promise<CheckResult> {
  const srv = await serveFixtures(dir)
  try {
    const url = `${srv.url}/${page.replace(/^\/+/, '')}`
    return await withPage(url, async (client) => {
      const tree = buildTree(await extract(client))
      let violations = checkInvariants(tree)
      if (selector) violations = violations.filter((v) => v.selector.includes(selector))
      return { violations, tree: renderTree(tree), misses: srv.misses }
    }, { port, viewport })
  } finally {
    srv.close()
  }
}

// "Same state" as the current bad state = the same SET of (rule, selector) pairs — px
// amounts are deliberately excluded from the key: a bleed can drift a few px across
// unrelated commits (e.g. a sibling's margin nudging layout) without being a different bug.
const keyOf = (v: Violation): string => `${v.rule} ${v.selector}`
const keysOf = (vs: Violation[]): Set<string> => new Set(vs.map(keyOf))
const sameState = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((k) => b.has(k))

// The good-vs-bad layout delta plus the violations the bad side introduced — shared by
// the named-commit verdict and the uncommitted-changes verdict.
function deltaBlock(goodTree: string, badTree: string, badViolations: Violation[], goodKeys: Set<string>): string {
  const introduced = badViolations.filter((v) => !goodKeys.has(keyOf(v)))
  const delta = renderDiff(diffTrees(goodTree, badTree))
  return `${delta}\nviolations introduced:\n${introduced.map((v) => `${v.rule}: ${v.message}`).join('\n')}`
}

// Finds which commit introduced the CURRENT layout violation(s) on `page` (contract: v1 is
// STATIC roots only — a plain file tree served as-is; a dev-server/build-step project needs
// a build step per checkout this doesn't run — out of scope for v1, --serve CMD is the named
// future hook). Walks HEAD's ancestors newest→oldest (linear, capped at maxCommits), each in
// its own detached `git worktree add` under a scratch temp dir, until it finds the first
// commit whose violation state differs from HEAD's — the culprit is the commit right after it.
export async function blame(root: string, page: string, opts: BlameOpts): Promise<{ output: string; dirty: boolean }> {
  const maxCommits = opts.maxCommits ?? 25
  // realpath, not just resolve: git rev-parse --show-toplevel resolves symlinks (e.g. macOS's
  // /var -> /private/var), and a symlink-unaware relOffset below would climb back out of the
  // worktree checkout to the ORIGINAL repo dir instead — comparing HEAD's content against itself.
  const rootAbs = realpathSync(resolve(root))
  const repoRoot = repoRootOf(rootAbs)
  const relOffset = relative(repoRoot, rootAbs) // '' when root IS the repo root
  // Uncommitted changes under --root mean the disk state the caller sees is NOT HEAD's
  // committed state — HEAD joins the walk (so an uncommitted breakage is never pinned on
  // an innocent commit) and every verdict carries a note.
  const hasUncommitted = git(rootAbs, ['status', '--porcelain', '--', '.']) !== ''

  // Current bad state: `root` on disk IS the working tree — no checkout needed, and
  // reading it never touches the user's repo.
  const current = await checkAt(rootAbs, page, opts.selector, opts.viewport, opts.port)
  // A resource that 404s from --root 404s identically in EVERY historical comparison —
  // the verdict below could be confidently wrong, so warn before it.
  const prefix =
    (current.misses.length ? `warning: ${current.misses.length} linked resources failed to load from --root (${current.misses.join(', ')}) — if they live outside --root, point --root at the repo root\n` : '') +
    (hasUncommitted ? 'note: working tree has uncommitted changes\n' : '')
  if (current.violations.length === 0) return { output: `${prefix}nothing to blame — page is clean`, dirty: false }
  const badKeys = keysOf(current.violations)

  const commits = ancestors(repoRoot, maxCommits, hasUncommitted)
  const scratch = mkdtempSync(join(tmpdir(), 'csstruth-blame-'))

  // SIGINT mid-walk: clean up synchronously (worktree + scratch), then either defer to
  // another SIGINT listener (the MCP server's graceful shutdown — it kills Chrome and
  // exits 0) or, in the CLI where no one else will, kill Chrome and exit 130 ourselves
  // (process.exit skips cli.ts's .finally(shutdownChrome)). Armed per-walk and ALWAYS
  // disarmed in the finally — a process-lifetime handler would race MCP's shutdown on
  // every later SIGINT.
  let interrupted = false
  let activeWorktree: string | null = null
  const cleanupCheckouts = () => {
    if (activeWorktree) removeWorktree(repoRoot, activeWorktree)
    activeWorktree = null
    try { rmSync(scratch, { recursive: true, force: true }) } catch {}
  }
  const onSigint = () => {
    interrupted = true
    cleanupCheckouts()
    if (process.listeners('SIGINT').length > 1) return
    // terminal: latches connect.ts against relaunches — the walk's in-flight checkAt would
    // otherwise relaunch Chrome behind this kill and process.exit would abandon it.
    void shutdownChrome({ terminal: true }).finally(() => process.exit(130))
  }
  process.on('SIGINT', onSigint)

  try {
    // sentinel: the previous (newer) state examined is the DISK state, not yet any commit
    let prevInfo: CommitInfo | null = null
    let prevTree = current.tree
    let prevViolations = current.violations
    let examined = 0

    for (const commit of commits) {
      if (interrupted) break
      examined++
      const wtPath = join(scratch, commit.short)
      git(repoRoot, ['worktree', 'add', '--detach', wtPath, commit.sha])
      activeWorktree = wtPath
      let result: CheckResult
      try {
        result = await checkAt(join(wtPath, relOffset), page, opts.selector, opts.viewport, opts.port)
      } finally {
        activeWorktree = null
        removeWorktree(repoRoot, wtPath)
      }

      const keys = keysOf(result.violations)
      if (!sameState(badKeys, keys)) {
        // This commit is GOOD — whatever was examined just before it (newer) broke the page.
        const block = deltaBlock(result.tree, prevTree, prevViolations, keys)
        if (prevInfo === null) {
          // First walked entry is already good. With uncommitted changes that entry is HEAD
          // itself, so the breakage was never committed; otherwise the walk started at
          // HEAD~1 and HEAD (== the disk state) is the culprit.
          if (hasUncommitted) return { output: `${prefix}broken by uncommitted changes in your working tree (not any commit)\n${block}`, dirty: true }
          prevInfo = commitInfo(repoRoot, git(repoRoot, ['rev-parse', 'HEAD']))
        }
        return { output: `${prefix}broken by ${prevInfo.short} "${prevInfo.subject}" (${prevInfo.date}, ${prevInfo.author})\n${block}`, dirty: true }
      }
      prevInfo = commit
      prevTree = result.tree
      prevViolations = result.violations
    }
    // Reached the end of history (fewer commits exist than the cap), still bad the whole
    // way — raising --max-commits wouldn't help, there's nothing further back to walk.
    const verdict = commits.length < maxCommits
      ? 'the page was never good in this history'
      : `still broken ${examined} commits back — raise --max-commits`
    return { output: `${prefix}${verdict}`, dirty: true }
  } finally {
    process.removeListener('SIGINT', onSigint)
    cleanupCheckouts()
    try { execFileSync('git', ['-C', repoRoot, 'worktree', 'prune'], { stdio: 'pipe' }) } catch {}
  }
}
