import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import path from "node:path"
import { LOG_PREFIX } from "../shared/branding"
import { resolveWorkingTreeLocation, runGit, type WorkingTreeLocation } from "./diff-store"

/**
 * Which files a chat actually changed, by snapshotting the working tree at each
 * turn boundary and diffing the two trees.
 *
 * The point is to answer "did this chat touch anything that's still
 * uncommitted?" without a clock. The old answer compared the chat's last turn
 * end against a per-project "when did the tree get dirty" timestamp, which is a
 * proxy for authorship rather than a measurement of it: one file left
 * uncommitted overnight flagged every chat that had run since, and none of them
 * had necessarily touched it.
 *
 * Snapshots measure the filesystem, so they don't care *how* a file changed —
 * an Edit tool, `sed -i` inside a Bash call, a formatter on save, or a subagent
 * all land in the diff identically. Parsing tool calls would see only the first.
 *
 * The trees are written with `git write-tree` against a throwaway index, so the
 * user's index is never touched and nothing is committed, staged, or moved. No
 * refs are created either: we need the tree only long enough to diff it, and
 * loose objects are not pruned anywhere near that fast. (If per-chat diffs or
 * turn-level revert ever want the trees kept, add refs then — the recorded
 * paths don't change.)
 */

/** Per-chat pre-turn trees, plus a location cache so `git rev-parse` runs once per project. */
export class TurnFileTracker {
  private readonly pendingTrees = new Map<string, Promise<string | null>>()
  private readonly locations = new Map<string, Promise<WorkingTreeLocation | null>>()

  constructor(
    private readonly options: {
      /** Absolute project path for a chat, or null when it can't be resolved. */
      resolveChatPath: (chatId: string) => string | null
      /** Persist the paths a turn changed. Never called with an empty list. */
      recordPaths: (chatId: string, paths: string[]) => Promise<void>
    }
  ) {}

  /**
   * Snapshot before the turn runs. Fire-and-forget: the capture races the
   * agent's first tool call, which is fine — a file the agent changes before
   * the snapshot lands simply shows up as pre-existing dirt rather than as this
   * turn's work. Blocking the turn on a `git add -A` would be the worse trade.
   *
   * Returns the capture promise so tests can wait for a deterministic baseline;
   * production callers ignore it.
   */
  beginTurn(chatId: string): Promise<void> {
    const localPath = this.options.resolveChatPath(chatId)
    if (!localPath) return Promise.resolve()
    const capture = this.captureTree(localPath)
    this.pendingTrees.set(chatId, capture)
    return capture.then(() => undefined, () => undefined)
  }

  /**
   * Snapshot after the turn and record the delta. A missing pre-tree (server
   * restarted mid-turn, project isn't a repo, capture failed) records nothing
   * rather than guessing — a chat with no recorded paths is simply never
   * flagged, which is the safe direction.
   */
  async endTurn(chatId: string): Promise<void> {
    const pending = this.pendingTrees.get(chatId)
    this.pendingTrees.delete(chatId)
    if (!pending) return
    const localPath = this.options.resolveChatPath(chatId)
    if (!localPath) return

    try {
      const [preTree, postTree] = await Promise.all([pending, this.captureTree(localPath)])
      if (!preTree || !postTree || preTree === postTree) return
      const paths = await this.diffTrees(localPath, preTree, postTree)
      if (paths.length > 0) await this.options.recordPaths(chatId, paths)
    } catch (error) {
      // Never let file tracking break a turn's completion path.
      console.warn(`${LOG_PREFIX} turn file tracking failed for chat ${chatId}:`, error)
    }
  }

  /** Drops a chat's pending tree without recording anything. */
  forget(chatId: string): void {
    this.pendingTrees.delete(chatId)
  }

  private locationFor(localPath: string): Promise<WorkingTreeLocation | null> {
    const cached = this.locations.get(localPath)
    if (cached) return cached
    const resolved = resolveWorkingTreeLocation(localPath)
    this.locations.set(localPath, resolved)
    return resolved
  }

  /**
   * The whole worktree as a tree object, untracked files included and
   * `.gitignore` respected — `git add -A` decides both for us, so the snapshot
   * matches what `git status` reports as dirty.
   */
  private async captureTree(localPath: string): Promise<string | null> {
    const location = await this.locationFor(localPath)
    if (!location) return null

    const indexPath = path.join(location.gitDir, `kanna-snapshot-index-${randomUUID()}`)
    const env = { ...process.env, GIT_INDEX_FILE: indexPath }
    try {
      // Seed from HEAD so `add -A` only has to hash what actually differs.
      // Without this every snapshot re-hashes the entire worktree. Failure is
      // fine and expected on an unborn HEAD (a repo with no commits yet).
      await runGit(["read-tree", "HEAD"], location.repoRoot, { env })
      const added = await runGit(["add", "-A", "--", "."], location.repoRoot, { env })
      if (added.exitCode !== 0) return null
      const written = await runGit(["write-tree"], location.repoRoot, { env })
      if (written.exitCode !== 0) return null
      return written.stdout.trim() || null
    } finally {
      await rm(indexPath, { force: true }).catch(() => undefined)
    }
  }

  /**
   * `--no-renames` on purpose: a rename should yield *both* names, since either
   * one can be the path that later shows up dirty.
   */
  private async diffTrees(localPath: string, fromTree: string, toTree: string): Promise<string[]> {
    const location = await this.locationFor(localPath)
    if (!location) return []
    const diff = await runGit(
      ["diff", "--name-only", "--no-renames", fromTree, toTree],
      location.repoRoot,
    )
    if (diff.exitCode !== 0) return []
    return diff.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
  }
}
