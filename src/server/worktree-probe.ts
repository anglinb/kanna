import { stat } from "node:fs/promises"
import path from "node:path"
import type { StoreState } from "./events"
import {
  probeWorkingTree,
  resolveWorkingTreeLocation,
  type WorkingTreeLocation,
  type WorkingTreeProbe,
} from "./diff-store"

/**
 * Tracks, per project, whether the working tree is dirty and roughly when that
 * started — the input to the sidebar's "this chat is relevant to your
 * uncommitted work" dot (`lastTurnEndedAt > dirtySinceMs`).
 *
 * Entirely in-memory and derived: nothing is persisted, so a restart just
 * repopulates lazily. Reads are synchronous because the sidebar snapshot
 * builder can't await git.
 *
 * Three update paths, none of which sweeps `git status` across projects:
 *
 * 1. **Turn end** (`refreshForProject`) — the only event that both dirties a
 *    tree and advances `lastTurnEndedAt`, so the only one that can *create* a
 *    dot. One `git status` for one project.
 * 2. **The tick** (`start`) — stats `<gitDir>/index` and `<gitDir>/HEAD` per
 *    project and runs the real probe only when that stamp changed. A commit
 *    always rewrites the index and a checkout rewrites HEAD, so this catches
 *    the case that leaves dots stale: committing outside Kanna. At idle it
 *    spawns zero processes.
 * 3. **`DiffStore.onWorkingTreeProbe`** — free; `performRefresh` already stats
 *    every dirty file. Keeps the client's active project current and clears the
 *    dot immediately when a commit goes through Kanna's git panel.
 *
 * A plain hand edit touches no git metadata and so is missed by (2), but under
 * the dot's rule a hand edit moves `dirtySinceMs` to *now*, which can only
 * remove dots from chats whose turns predate it — never add a wrong one.
 */
const PROBE_TICK_INTERVAL_MS = 30_000

interface ProjectProbeEntry {
  /** Cached because resolving it costs two git invocations. */
  location: WorkingTreeLocation | null
  /** Combined mtime of the git dir's `index` and `HEAD`; "" when unreadable. */
  stamp: string
}

function probesEqual(left: WorkingTreeProbe | undefined, right: WorkingTreeProbe) {
  return left?.dirty === right.dirty && left?.dirtySinceMs === right.dirtySinceMs
}

export class WorktreeProbe {
  private readonly entries = new Map<string, ProjectProbeEntry>()
  private readonly probes = new Map<string, WorkingTreeProbe>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(
    private readonly getState: () => StoreState,
    private readonly onChange: () => void
  ) {}

  /** Synchronous snapshot for the sidebar builder. */
  getStates(): ReadonlyMap<string, WorkingTreeProbe> {
    return this.probes
  }

  start() {
    if (this.timer) return
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
  recordExternalProbe(projectId: string, probe: WorkingTreeProbe) {
    void this.applyProbe(projectId, probe)
  }

  /** Full probe for a single project. Called when one of its turns ends. */
  async refreshForProject(projectId: string) {
    const project = this.getState().projectsById.get(projectId)
    if (!project || project.deletedAt) return

    const entry = await this.ensureEntry(projectId, project.localPath)
    if (!entry.location) {
      await this.applyProbe(projectId, { dirty: false })
      return
    }
    await this.applyProbe(projectId, await probeWorkingTree(entry.location.repoRoot))
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
      for (const projectId of this.getCandidateProjectIds()) {
        const project = this.getState().projectsById.get(projectId)
        if (!project) continue
        const entry = await this.ensureEntry(projectId, project.localPath)
        if (!entry.location) continue

        const stamp = await this.readStamp(entry.location.gitDir)
        // An unreadable stamp falls through to a full probe rather than being
        // skipped — better one wasted `git status` than a silently stuck dot.
        if (stamp !== "" && stamp === entry.stamp) continue

        await this.applyProbe(projectId, await probeWorkingTree(entry.location.repoRoot))
      }
    } finally {
      this.ticking = false
    }
  }

  /**
   * Projects with at least one live chat that has finished a turn. A chat can
   * only dot if `lastTurnEndedAt` is set, so anything else is wasted work.
   */
  private getCandidateProjectIds() {
    const state = this.getState()
    const projectIds = new Set<string>()
    for (const chat of state.chatsById.values()) {
      if (chat.deletedAt || chat.lastTurnEndedAt == null) continue
      if (projectIds.has(chat.projectId)) continue
      const project = state.projectsById.get(chat.projectId)
      if (!project || project.deletedAt) continue
      projectIds.add(chat.projectId)
    }
    return projectIds
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
    }
    this.entries.set(projectId, entry)
    return entry
  }

  private async applyProbe(projectId: string, probe: WorkingTreeProbe) {
    // Publish before the stamp read so `getStates()` is correct the moment this
    // returns control — `recordExternalProbe` doesn't await us.
    const changed = !probesEqual(this.probes.get(projectId), probe)
    this.probes.set(projectId, probe)
    if (changed) {
      this.onChange()
    }

    // Re-read *after* probing so a probe can never trigger itself next tick.
    const entry = this.entries.get(projectId)
    if (entry?.location) {
      entry.stamp = await this.readStamp(entry.location.gitDir)
    }
  }

  private async readStamp(gitDir: string) {
    const [index, head] = await Promise.all([
      stat(path.join(gitDir, "index")).then((info) => info.mtimeMs).catch(() => null),
      stat(path.join(gitDir, "HEAD")).then((info) => info.mtimeMs).catch(() => null),
    ])
    if (index === null && head === null) return ""
    return `${index ?? ""}:${head ?? ""}`
  }
}
