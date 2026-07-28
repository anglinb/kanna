import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { buildRepoBrowseUrl } from "../shared/git-url"
import type { StoreState } from "./events"
import {
  probeWorkingTree,
  resolveWorkingTreeLocation,
  type WorkingTreeLocation,
  type WorkingTreeProbe,
  type WorkingTreeScan,
} from "./diff-store"

/**
 * Tracks, per project, whether the working tree is dirty and which paths are
 * dirty — the input to the sidebar's "this chat is relevant to your
 * uncommitted work" dot, which intersects these paths with the files a chat
 * actually touched (`ChatRecord.touchedPaths`) — plus the repo name and branch
 * behind the sidebar's `repo/branch` label.
 *
 * Entirely in-memory and derived: nothing is persisted, so a restart just
 * repopulates lazily. Reads are synchronous because the sidebar snapshot
 * builder can't await git.
 *
 * Three update paths, none of which sweeps `git status` across projects:
 *
 * 1. **Turn end** (`refreshForProject`) — a finished turn is the likeliest
 *    moment for the dirty set to have changed. One `git status` for one
 *    project.
 * 2. **The tick** (`start`) — stats `<gitDir>/index` and `<gitDir>/HEAD` per
 *    project and runs the real probe only when that stamp changed. A commit
 *    always rewrites the index and a checkout rewrites HEAD, so this catches
 *    the case that leaves dots stale: committing outside Kanna. At idle it
 *    spawns zero processes.
 * 3. **`DiffStore.onWorkingTreeProbe`** — free; `performRefresh` already lists
 *    every dirty path. Keeps the client's active project current and clears the
 *    dot immediately when a commit goes through Kanna's git panel.
 *
 * A plain hand edit touches no git metadata and so is missed by (2) until the
 * next turn ends or the client refreshes that project's diff. The dot is a
 * hint, not a guarantee, and it errs toward being one probe stale rather than
 * toward inventing state.
 *
 * Repo labels ride along on the same passes but cover *every* project with a
 * live chat, not just the dot candidates: the label is on screen for all of
 * them. They're cheap enough to afford that — the repo root comes from the
 * already-cached location, and the branch is one read of `<gitDir>/HEAD`
 * rather than a `git` subprocess. HEAD is half the stamp, so a checkout
 * anywhere already wakes the tick that re-reads it.
 */
const PROBE_TICK_INTERVAL_MS = 30_000

interface ProjectProbeEntry {
  /** Cached because resolving it costs two git invocations. */
  location: WorkingTreeLocation | null
  /** Combined mtime of the git dir's `index` and `HEAD`; "" when unreadable. */
  stamp: string
  /**
   * Mtime of `HEAD` as of the last repo-label read; "" when unreadable.
   *
   * Gated separately from `stamp` because the two go stale on different events
   * and `stamp` is banked at a moment that would strand the label:
   *
   * - `git status` rewrites the index as a side effect (its stat cache), so
   *   `applyProbe` re-reads `stamp` *after* probing to keep a probe from
   *   re-triggering itself. Anyone who supplies a probe from outside
   *   (`recordExternalProbe`) banks a stamp for a label read that never
   *   happened — a checkout followed by a git-panel refresh would then leave
   *   the sidebar naming the old branch until the next unrelated commit.
   * - `git status` never touches HEAD, so this half is stable at idle and can
   *   safely be banked from *before* the label read: if HEAD moves while we're
   *   reading it, the cost is one redundant re-read next tick rather than a
   *   label frozen at the wrong branch forever.
   */
  labelStamp: string
}

/** Identity of the repo a project sits in, for the sidebar's `repo/branch` label. */
export interface ProjectRepoLabel {
  /**
   * Basename of the repo root — which is *not* the project's folder name when
   * the project is a subdirectory of the repo.
   */
  repoName: string
  /** Absent on a detached HEAD, where there is no branch to name. */
  branchName?: string
  /** Owner segment of the `origin` remote; absent when there is no origin. */
  repoOwner?: string
  /**
   * Where `origin` lives as a browsable https page, when it resolves to one.
   * Derived here rather than client-side because the client never sees the
   * remote URL, and the *host* is the part that can't be guessed from
   * `owner/repo` — assuming github.com would send half the world's repos to a
   * 404.
   */
  repoUrl?: string
}

function probesEqual(left: WorkingTreeProbe | undefined, right: WorkingTreeProbe) {
  if (!left || left.dirty !== right.dirty || left.paths.size !== right.paths.size) return false
  for (const dirtyPath of right.paths) {
    if (!left.paths.has(dirtyPath)) return false
  }
  return true
}

/**
 * Current branch straight out of `<gitDir>/HEAD`, which is either
 * `ref: refs/heads/<branch>` or a raw commit sha (detached). Reading the file
 * beats `git symbolic-ref` here: this runs for every project on every tick, and
 * a subprocess per project per 30s is a real cost for a label.
 */
async function readHeadBranch(gitDir: string) {
  const head = await readFile(path.join(gitDir, "HEAD"), "utf8").catch(() => null)
  if (head === null) return undefined
  const trimmed = head.trim()
  if (!trimmed.startsWith("ref:")) return undefined
  const ref = trimmed.slice("ref:".length).trim()
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref
  return branch.length > 0 ? branch : undefined
}

/**
 * The `url` of the `origin` remote out of a git config file. Same trade as
 * `readHeadBranch`: one file read per project beats `git config --get` on every
 * pass. Hand-rolled rather than a general INI parser because we want exactly
 * one key out of one section.
 */
function extractOriginUrl(config: string): string | undefined {
  let inOrigin = false
  for (const rawLine of config.split("\n")) {
    const line = rawLine.trim()
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/u.test(line)
      continue
    }
    if (!inOrigin) continue
    const match = /^url\s*=\s*(.+)$/u.exec(line)
    if (match?.[1]) return match[1].trim()
  }
  return undefined
}

/**
 * The account/org a remote URL belongs to — the segment before the repo in
 * `owner/repo`. Host-agnostic on purpose (GitHub, GitLab and self-hosted all
 * shape the path the same way), but it does require a *host*: a bare local path
 * like `/srv/git/widgets.git` has directories, not an owner, and calling one
 * "git" would put a lie in the tooltip. No owner is always a valid answer — the
 * label just shows the repo unqualified.
 */
export function extractRemoteOwner(remoteUrl: string | undefined): string | undefined {
  if (!remoteUrl) return undefined
  // `git@host:owner/repo.git` — scp syntax, which is not a parseable URL.
  const scp = /^[^/@]+@[^/:]+:(?<path>.+)$/u.exec(remoteUrl)
  let rawPath = scp?.groups?.path
  if (rawPath === undefined) {
    try {
      rawPath = new URL(remoteUrl).pathname
    } catch {
      return undefined
    }
  }
  const segments = rawPath.replace(/\.git$/u, "").split("/").filter((segment) => segment.length > 0)
  return segments.length >= 2 ? segments[segments.length - 2] : undefined
}

/**
 * A linked worktree's git dir holds no `config` of its own — the remotes live
 * in the common dir it points at, named by a `commondir` file beside HEAD.
 */
async function resolveCommonDir(gitDir: string) {
  const commonDir = await readFile(path.join(gitDir, "commondir"), "utf8").catch(() => null)
  const trimmed = commonDir?.trim()
  return trimmed ? path.resolve(gitDir, trimmed) : gitDir
}

/** One config read, both readings of `origin` — the owner and the browse URL. */
async function readOrigin(gitDir: string): Promise<{ repoOwner?: string, repoUrl?: string }> {
  const configPath = path.join(await resolveCommonDir(gitDir), "config")
  const config = await readFile(configPath, "utf8").catch(() => null)
  if (config === null) return {}
  const originUrl = extractOriginUrl(config)
  return {
    repoOwner: extractRemoteOwner(originUrl),
    repoUrl: buildRepoBrowseUrl(originUrl)?.url,
  }
}

export class WorktreeProbe {
  private readonly entries = new Map<string, ProjectProbeEntry>()
  private readonly probes = new Map<string, WorkingTreeProbe>()
  /** Absent for projects that aren't in a repo (or haven't been resolved yet). */
  private readonly repoLabels = new Map<string, ProjectRepoLabel>()
  /**
   * Projects a resolution pass has looked at and found *not* to be in a repo.
   *
   * A missing repo label can't say this on its own — it also covers every
   * project we haven't reached yet — and the difference matters to anything
   * that would offer to `git init` a folder: doing it off "no label" would
   * flash the offer at every repo in the sidebar for the first pass after boot.
   */
  private readonly noRepoProjects = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private batchDepth = 0
  private batchedChange = false

  constructor(
    private readonly getState: () => StoreState,
    private readonly onChange: () => void
  ) {}

  /** Synchronous snapshot for the sidebar builder. */
  getStates(): ReadonlyMap<string, WorkingTreeProbe> {
    return this.probes
  }

  /** Synchronous snapshot for the sidebar builder. */
  getRepoLabels(): ReadonlyMap<string, ProjectRepoLabel> {
    return this.repoLabels
  }

  /** Synchronous snapshot for the sidebar builder — see `noRepoProjects`. */
  getProjectsWithoutRepo(): ReadonlySet<string> {
    return this.noRepoProjects
  }

  start() {
    if (this.timer) return
    // Kick one pass immediately: without it every project's label reads as a
    // bare folder name for the first tick interval after boot.
    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, PROBE_TICK_INTERVAL_MS)
    // Don't hold the process open just to poll git metadata.
    this.timer.unref?.()
  }

  stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Record a probe supplied by someone who already did the filesystem work
   * (see `DiffStore.onWorkingTreeProbe`). Also refreshes the stamp so the tick
   * doesn't immediately redo the same scan.
   */
  recordExternalProbe(projectId: string, scan: WorkingTreeScan) {
    void this.applyProbe(projectId, scan)
  }

  /** Full probe for a single project. Called when one of its turns ends. */
  async refreshForProject(projectId: string) {
    const project = this.getState().projectsById.get(projectId)
    if (!project || project.deletedAt) return

    await this.batchChanges(async () => {
      const entry = await this.ensureEntry(projectId, project.localPath)
      if (!entry.location) {
        this.applyRepoLabel(projectId, null)
        await this.applyProbe(projectId, { dirty: false, paths: [] })
        return
      }
      // Banked before the read, never after — see `labelStamp`.
      entry.labelStamp = (await this.readStamp(entry.location.gitDir)).head
      this.applyRepoLabel(projectId, await this.readRepoLabel(entry.location))
      await this.applyProbe(projectId, await probeWorkingTree(entry.location.repoRoot))
    })
  }

  async refreshForChat(chatId: string) {
    const chat = this.getState().chatsById.get(chatId)
    if (!chat) return
    await this.refreshForProject(chat.projectId)
  }

  private async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      const { labelled, dirtyCandidates } = this.getTickProjectIds()
      for (const projectId of labelled) {
        const project = this.getState().projectsById.get(projectId)
        if (!project) continue
        await this.batchChanges(async () => {
          const entry = await this.ensureEntry(projectId, project.localPath)
          if (!entry.location) {
            this.applyRepoLabel(projectId, null)
            return
          }

          const stamp = await this.readStamp(entry.location.gitDir)
          // A checkout rewrites HEAD, so this covers every branch switch.
          if (stamp.head === "" || stamp.head !== entry.labelStamp || !this.repoLabels.has(projectId)) {
            // Banked before the read, never after — see `labelStamp`.
            entry.labelStamp = stamp.head
            this.applyRepoLabel(projectId, await this.readRepoLabel(entry.location))
          }

          // An unreadable stamp falls through to a full probe rather than being
          // skipped — better one wasted `git status` than a silently stuck dot.
          const changed = stamp.combined === "" || stamp.combined !== entry.stamp
          if (!changed || !dirtyCandidates.has(projectId)) {
            // Label-only projects never reach `applyProbe`, so bank the stamp
            // here or every tick would re-read a HEAD that hasn't moved.
            entry.stamp = stamp.combined
            return
          }

          await this.applyProbe(projectId, await probeWorkingTree(entry.location.repoRoot))
        })
      }
    } finally {
      this.ticking = false
    }
  }

  /**
   * Two nested sets, in one pass over the chats:
   *
   * - `labelled` — projects with a live chat, i.e. everything the sidebar can
   *   put a `repo/branch` label on. Only cheap work runs for these.
   * - `dirtyCandidates` — of those, the ones with a chat that finished a turn.
   *   A chat can only dot if `lastTurnEndedAt` is set, so running `git status`
   *   for any other project is wasted work.
   */
  private getTickProjectIds() {
    const state = this.getState()
    const labelled = new Set<string>()
    const dirtyCandidates = new Set<string>()
    for (const chat of state.chatsById.values()) {
      if (chat.deletedAt) continue
      const project = state.projectsById.get(chat.projectId)
      if (!project || project.deletedAt) continue
      labelled.add(chat.projectId)
      if (chat.lastTurnEndedAt != null) dirtyCandidates.add(chat.projectId)
    }
    return { labelled, dirtyCandidates }
  }

  private async ensureEntry(projectId: string, localPath: string) {
    const existing = this.entries.get(projectId)
    // A null location is retried rather than cached forever: a folder can become
    // a repo later (`git init` through Kanna), and re-resolving costs two
    // `rev-parse` calls only for the rare project that isn't a repo yet.
    if (existing?.location) return existing
    const entry: ProjectProbeEntry = {
      location: await resolveWorkingTreeLocation(localPath),
      stamp: existing?.stamp ?? "",
      labelStamp: existing?.labelStamp ?? "",
    }
    this.entries.set(projectId, entry)
    // Notified separately from the repo label: a folder that has never been a
    // repo has no label to drop, so `applyRepoLabel(null)` sees nothing change
    // and stays quiet — but the sidebar has just learned something about it.
    if (this.noRepoProjects.has(projectId) !== !entry.location) {
      if (entry.location) this.noRepoProjects.delete(projectId)
      else this.noRepoProjects.add(projectId)
      this.notifyChanged()
    }
    return entry
  }

  /**
   * One pass over a project can move both its repo label and its dirty state —
   * a branch switch typically moves both — and the sidebar only needs one
   * broadcast for that. Coalesces the notifications; nested batches collapse
   * into the outermost.
   */
  private async batchChanges<T>(run: () => Promise<T>): Promise<T> {
    this.batchDepth += 1
    try {
      return await run()
    } finally {
      this.batchDepth -= 1
      if (this.batchDepth === 0 && this.batchedChange) {
        this.batchedChange = false
        this.onChange()
      }
    }
  }

  private notifyChanged() {
    if (this.batchDepth > 0) {
      this.batchedChange = true
      return
    }
    this.onChange()
  }

  private async readRepoLabel(location: WorkingTreeLocation): Promise<ProjectRepoLabel> {
    const [branchName, origin] = await Promise.all([
      readHeadBranch(location.gitDir),
      readOrigin(location.gitDir),
    ])
    return {
      repoName: path.basename(location.repoRoot),
      ...(branchName ? { branchName } : {}),
      ...(origin.repoOwner ? { repoOwner: origin.repoOwner } : {}),
      ...(origin.repoUrl ? { repoUrl: origin.repoUrl } : {}),
    }
  }

  /** `null` means "not in a repo" — the label is dropped, not blanked. */
  private applyRepoLabel(projectId: string, label: ProjectRepoLabel | null) {
    const previous = this.repoLabels.get(projectId)
    if (!label) {
      if (!previous) return
      this.repoLabels.delete(projectId)
      this.notifyChanged()
      return
    }
    if (
      previous?.repoName === label.repoName
      && previous.branchName === label.branchName
      && previous.repoOwner === label.repoOwner
      && previous.repoUrl === label.repoUrl
    ) return
    this.repoLabels.set(projectId, label)
    this.notifyChanged()
  }

  private async applyProbe(projectId: string, scan: WorkingTreeScan) {
    // A scan *is* the probe now — the reading is a set of paths, so there is
    // no state to carry between passes and nothing to go stale. (This used to
    // fold scans into a per-path "first seen dirty" ledger to derive a
    // `dirtySinceMs`; a single file left uncommitted overnight then flagged
    // every chat that had run since, whether or not it touched that file.)
    const probe: WorkingTreeProbe = { dirty: scan.dirty, paths: new Set(scan.paths) }
    // Publish before the stamp read so `getStates()` is correct the moment this
    // returns control — `recordExternalProbe` doesn't await us.
    const changed = !probesEqual(this.probes.get(projectId), probe)
    this.probes.set(projectId, probe)
    if (changed) {
      this.notifyChanged()
    }

    // Re-read *after* probing so a probe can never trigger itself next tick.
    // Deliberately leaves `labelStamp` alone: this runs for probes computed
    // elsewhere too, and banking HEAD here would tell the tick a label had been
    // read that never was.
    const entry = this.entries.get(projectId)
    if (entry?.location) {
      entry.stamp = (await this.readStamp(entry.location.gitDir)).combined
    }
  }

  /**
   * Both readings of the git dir's mtimes in one pair of stats: `combined`
   * gates the dirty probe, `head` gates the repo label. See `labelStamp` for
   * why the label can't ride on the combined one. `""` means unreadable, which
   * every caller treats as "assume changed".
   */
  private async readStamp(gitDir: string): Promise<{ combined: string, head: string }> {
    const [index, head] = await Promise.all([
      stat(path.join(gitDir, "index")).then((info) => info.mtimeMs).catch(() => null),
      stat(path.join(gitDir, "HEAD")).then((info) => info.mtimeMs).catch(() => null),
    ])
    return {
      combined: index === null && head === null ? "" : `${index ?? ""}:${head ?? ""}`,
      head: head === null ? "" : String(head),
    }
  }
}
