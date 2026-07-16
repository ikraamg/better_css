import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { withPage } from './connect.js'
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

// HEAD's ancestors, newest first, HEAD itself excluded (the caller already knows HEAD's
// state — that's the "current bad state" the walk is comparing against). Linear walk only
// (--first-parent): a throwaway/scripted history is linear, and layout states can flicker
// commit-to-commit, so bisect would be unsound here anyway (contract's own reasoning).
function ancestors(repoRoot: string, maxCommits: number): CommitInfo[] {
  const out = git(repoRoot, ['log', '--first-parent', '--skip=1', '-n', String(maxCommits), `--format=%H${SEP}%h${SEP}%s${SEP}%ar${SEP}%an`])
  if (!out) return []
  return out.split('\n').map((line) => {
    const [full, short, subject, date, author] = line.split(SEP)
    return { sha: full, short, subject, date, author }
  })
}

// Tracks worktrees currently checked out by an in-flight blame() call, so a SIGINT mid-walk
// still gets them cleaned up (safety bar: the user's repo must never be left with a stray
// `git worktree add --detach` entry). One process-wide handler, armed once.
const activeWorktrees = new Set<{ repoRoot: string; path: string }>()
let sigintArmed = false

function removeWorktree(repoRoot: string, path: string): void {
  try { execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', path], { stdio: 'pipe' }) } catch {}
  try { execFileSync('git', ['-C', repoRoot, 'worktree', 'prune'], { stdio: 'pipe' }) } catch {}
  try { rmSync(path, { recursive: true, force: true }) } catch {}
}

function armSigintCleanup(): void {
  if (sigintArmed) return
  sigintArmed = true
  process.on('SIGINT', () => {
    for (const wt of activeWorktrees) removeWorktree(wt.repoRoot, wt.path)
    activeWorktrees.clear()
    process.exit(130)
  })
}

interface CheckResult { violations: Violation[]; tree: string }

// Serves `dir` and runs the same check the rest of bettercss runs, scoped to one page and
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
      return { violations, tree: renderTree(tree) }
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

function foundOutput(culprit: CommitInfo, goodTree: string, badTree: string, badViolations: Violation[], goodKeys: Set<string>): string {
  const introduced = badViolations.filter((v) => !goodKeys.has(keyOf(v)))
  const delta = renderDiff(diffTrees(goodTree, badTree))
  const violLines = introduced.map((v) => `${v.rule}: ${v.message}`).join('\n')
  return `broken by ${culprit.short} "${culprit.subject}" (${culprit.date}, ${culprit.author})\n${delta}\nviolations introduced:\n${violLines}`
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

  // Current bad state: `root` on disk IS HEAD's working tree already — no checkout needed,
  // and reading it never touches the user's repo.
  const current = await checkAt(rootAbs, page, opts.selector, opts.viewport, opts.port)
  if (current.violations.length === 0) return { output: 'nothing to blame — page is clean', dirty: false }
  const badKeys = keysOf(current.violations)

  const commits = ancestors(repoRoot, maxCommits)
  const scratch = mkdtempSync(join(tmpdir(), 'bettercss-blame-'))
  armSigintCleanup()
  try {
    let prevInfo: CommitInfo = { sha: 'HEAD', short: 'HEAD', subject: '', date: '', author: '' }
    let prevTree = current.tree
    let prevViolations = current.violations
    let examined = 0

    for (const commit of commits) {
      examined++
      const wtPath = join(scratch, commit.short)
      git(repoRoot, ['worktree', 'add', '--detach', wtPath, commit.sha])
      const handle = { repoRoot, path: wtPath }
      activeWorktrees.add(handle)
      let result: CheckResult
      try {
        result = await checkAt(join(wtPath, relOffset), page, opts.selector, opts.viewport, opts.port)
      } finally {
        activeWorktrees.delete(handle)
        removeWorktree(repoRoot, wtPath)
      }

      const keys = keysOf(result.violations)
      if (!sameState(badKeys, keys)) {
        // This commit is GOOD — the culprit is the previous (newer) one, already established bad.
        const culprit = prevInfo.sha === 'HEAD' ? commitInfo(repoRoot, git(repoRoot, ['rev-parse', 'HEAD'])) : prevInfo
        return { output: foundOutput(culprit, result.tree, prevTree, prevViolations, keys), dirty: true }
      }
      prevInfo = commit
      prevTree = result.tree
      prevViolations = result.violations
    }
    return { output: `still broken ${examined} commits back — raise --max-commits`, dirty: true }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
    try { execFileSync('git', ['-C', repoRoot, 'worktree', 'prune'], { stdio: 'pipe' }) } catch {}
  }
}
