import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"
import { createEmptyState, type StoreState } from "./events"
import { deriveSidebarData } from "./read-models"
import { WorktreeProbe } from "./worktree-probe"

async function run(command: string[], cwd: string) {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr || stdout || `Command failed: ${command.join(" ")}`)
  }
  return stdout
}

const tempDirs: string[] = []

async function createRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-"))
  tempDirs.push(root)
  await run(["git", "init", "-b", "main"], root)
  await run(["git", "config", "user.email", "kanna@example.com"], root)
  await run(["git", "config", "user.name", "Kanna"], root)
  await writeFile(path.join(root, "app.txt"), "base\n", "utf8")
  await run(["git", "add", "."], root)
  await run(["git", "commit", "-m", "init"], root)
  return root
}

/** State with one project and one chat that has finished a turn (so it's a tick candidate). */
function createState(localPath: string, options?: { lastTurnEndedAt?: number }): StoreState {
  const state = createEmptyState()
  state.projectsById.set("project-1", {
    id: "project-1",
    localPath,
    title: "Project",
    createdAt: 1,
    updatedAt: 1,
  })
  state.projectIdsByPath.set(localPath, "project-1")
  state.chatsById.set("chat-1", {
    id: "chat-1",
    projectId: "project-1",
    title: "Chat",
    createdAt: 1,
    updatedAt: 1,
    unread: false,
    provider: "claude",
    planMode: false,
    autoPlan: false,
    sessionToken: null,
    lastTurnOutcome: null,
    ...(options?.lastTurnEndedAt === undefined ? {} : { lastTurnEndedAt: options.lastTurnEndedAt }),
  })
  return state
}

/** The tick is private; exercise it the way the interval would. */
function tick(probe: WorktreeProbe) {
  return (probe as unknown as { tick: () => Promise<void> }).tick()
}

describe("WorktreeProbe", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("refreshForChat records the project's dirty state", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    expect(probe.getStates().get("project-1")).toBeUndefined()
    await probe.refreshForChat("chat-1")
    expect(probe.getStates().get("project-1")).toEqual({ dirty: false })

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await probe.refreshForChat("chat-1")

    const recorded = probe.getStates().get("project-1")
    expect(recorded?.dirty).toBe(true)
    expect(recorded?.dirtySinceMs).toBeGreaterThan(0)
  })

  test("onChange fires only when the probe result actually changes", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    let changes = 0
    const probe = new WorktreeProbe(() => state, () => {
      changes += 1
    })

    await probe.refreshForChat("chat-1")
    expect(changes).toBe(1)

    // Same clean result twice — no rebroadcast.
    await probe.refreshForChat("chat-1")
    expect(changes).toBe(1)

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await probe.refreshForChat("chat-1")
    expect(changes).toBe(2)
  })

  test("a probe does not re-trigger itself on the next tick", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    let changes = 0
    const probe = new WorktreeProbe(() => state, () => {
      changes += 1
    })

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await probe.refreshForChat("chat-1")
    const afterFirst = changes

    // The stamp was re-read after probing, so a quiet repo produces no work.
    await tick(probe)
    await tick(probe)
    expect(changes).toBe(afterFirst)
  })

  test("the tick notices a commit made outside Kanna and clears the dirty state", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await probe.refreshForChat("chat-1")
    expect(probe.getStates().get("project-1")?.dirty).toBe(true)

    // Commit behind Kanna's back — this rewrites .git/index, which is exactly
    // the signal the stat tick watches for.
    await run(["git", "commit", "-am", "external"], repoRoot)
    await tick(probe)

    expect(probe.getStates().get("project-1")).toEqual({ dirty: false })
  })

  test("the tick skips projects whose chats never finished a turn", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot)
    const probe = new WorktreeProbe(() => state, () => {})

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await tick(probe)

    // No chat can qualify for the dot, so the project is never probed.
    expect(probe.getStates().get("project-1")).toBeUndefined()
  })

  test("the tick skips deleted projects", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    state.projectsById.get("project-1")!.deletedAt = 2
    const probe = new WorktreeProbe(() => state, () => {})

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await tick(probe)

    expect(probe.getStates().get("project-1")).toBeUndefined()
  })

  test("recordExternalProbe accepts a result computed elsewhere", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    let changes = 0
    const probe = new WorktreeProbe(() => state, () => {
      changes += 1
    })

    // A real mtime, not a synthetic small number: the anchor floor discards
    // anything older than a week, and epoch-1970 would be silently dropped.
    const mtimeMs = Date.now() - 60_000
    probe.recordExternalProbe("project-1", { dirty: true, files: [{ path: "a.txt", mtimeMs }] })

    expect(probe.getStates().get("project-1")).toEqual({ dirty: true, dirtySinceMs: mtimeMs })
    expect(changes).toBe(1)
  })

  test("a project that is not a repo reports not dirty", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-plain-"))
    tempDirs.push(root)
    const state = createState(root, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await probe.refreshForChat("chat-1")

    expect(probe.getStates().get("project-1")).toEqual({ dirty: false })
  })
})

/**
 * The seam `server.ts` wires up: a turn ending drives a probe, and the probe
 * feeds the sidebar row. Unit tests cover each half; this covers the join.
 */
describe("WorktreeProbe integration", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("a finished turn flags the chat's sidebar row as uncommitted work", async () => {
    const repoRoot = await createRepo()
    const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-data-"))
    tempDirs.push(dataDir)

    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(repoRoot)
    const chat = await store.createChat(project.id)

    let broadcasts = 0
    const probe = new WorktreeProbe(() => store.state, () => {
      broadcasts += 1
    })
    // Mirrors server.ts.
    const turnEnded: Array<Promise<void>> = []
    store.onTurnEnded = (chatId) => {
      turnEnded.push(probe.refreshForChat(chatId))
    }

    // An agent edits a file, then the turn ends.
    await writeFile(path.join(repoRoot, "app.txt"), "changed by agent\n", "utf8")
    await store.recordTurnFinished(chat.id)
    await Promise.all(turnEnded)

    expect(broadcasts).toBeGreaterThan(0)
    const flagged = deriveSidebarData(store.state, new Map(), { workingTrees: probe.getStates() })
    expect(flagged.projectGroups[0]?.chats[0]?.uncommittedWork).toBe(true)

    // Committing externally clears it on the next tick.
    await run(["git", "commit", "-am", "external"], repoRoot)
    await tick(probe)

    const cleared = deriveSidebarData(store.state, new Map(), { workingTrees: probe.getStates() })
    expect(cleared.projectGroups[0]?.chats[0]?.uncommittedWork).toBeUndefined()
  })

  test("a chat whose turn predates the dirt is not flagged", async () => {
    const repoRoot = await createRepo()
    const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-data-"))
    tempDirs.push(dataDir)

    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(repoRoot)
    const older = await store.createChat(project.id)
    await store.recordTurnFinished(older.id)

    // Dirt appears strictly after that turn ended. Stamped explicitly rather
    // than slept for: filesystem mtime granularity is a whole second on some
    // filesystems, so a real delay would be both slow and racy.
    await writeFile(path.join(repoRoot, "app.txt"), "changed later\n", "utf8")
    const turnEndedAt = store.state.chatsById.get(older.id)?.lastTurnEndedAt ?? 0
    const dirtiedAt = new Date(turnEndedAt + 5_000)
    await utimes(path.join(repoRoot, "app.txt"), dirtiedAt, dirtiedAt)

    const probe = new WorktreeProbe(() => store.state, () => {})
    await probe.refreshForChat(older.id)

    const sidebar = deriveSidebarData(store.state, new Map(), { workingTrees: probe.getStates() })
    expect(sidebar.projectGroups[0]?.chats[0]?.uncommittedWork).toBeUndefined()
  })

  test("labels a project with its repo name and branch", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await probe.refreshForChat("chat-1")

    expect(probe.getRepoLabels().get("project-1")).toEqual({
      repoName: path.basename(repoRoot),
      branchName: "main",
    })
  })

  test("the tick labels projects with no finished turn, without running git status", async () => {
    const repoRoot = await createRepo()
    // No lastTurnEndedAt: this project can never show the dot, but its label is
    // still on screen, so the label must not depend on being a dot candidate.
    const state = createState(repoRoot)
    const probe = new WorktreeProbe(() => state, () => {})

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await tick(probe)

    expect(probe.getRepoLabels().get("project-1")?.branchName).toBe("main")
    expect(probe.getStates().get("project-1")).toBeUndefined()
  })

  test("the tick picks up a branch switch made outside Kanna", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await tick(probe)
    expect(probe.getRepoLabels().get("project-1")?.branchName).toBe("main")

    await run(["git", "checkout", "-b", "feature/side-quest"], repoRoot)
    await tick(probe)

    expect(probe.getRepoLabels().get("project-1")?.branchName).toBe("feature/side-quest")
  })

  test("a detached HEAD keeps the repo name and drops the branch", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await run(["git", "checkout", "--detach", "HEAD"], repoRoot)
    await probe.refreshForChat("chat-1")

    const label = probe.getRepoLabels().get("project-1")
    expect(label?.repoName).toBe(path.basename(repoRoot))
    expect(label?.branchName).toBeUndefined()
  })

  test("a project inside a repo is labelled with the repo root, not its own folder", async () => {
    const repoRoot = await createRepo()
    const nested = path.join(repoRoot, "packages", "ui")
    await mkdir(nested, { recursive: true })
    const state = createState(nested, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await probe.refreshForChat("chat-1")

    expect(probe.getRepoLabels().get("project-1")?.repoName).toBe(path.basename(repoRoot))
  })

  test("a project that is not in a repo gets no label", async () => {
    const plainDir = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-plain-"))
    tempDirs.push(plainDir)
    const state = createState(plainDir, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await probe.refreshForChat("chat-1")

    expect(probe.getRepoLabels().get("project-1")).toBeUndefined()
  })

  test("one refresh is one broadcast even when label and dirty state both change", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    let changes = 0
    const probe = new WorktreeProbe(() => state, () => {
      changes += 1
    })

    // First pass sets both the label and the probe — one broadcast, not two.
    await probe.refreshForChat("chat-1")
    expect(changes).toBe(1)

    // A checkout that also dirties the tree still coalesces.
    await run(["git", "checkout", "-b", "next"], repoRoot)
    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await probe.refreshForChat("chat-1")
    expect(changes).toBe(2)
  })

  test("the sidebar snapshot carries the repo label", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})
    await probe.refreshForChat("chat-1")

    const sidebar = deriveSidebarData(state, new Map(), { repoLabels: probe.getRepoLabels() })

    expect(sidebar.projectGroups[0]?.repoName).toBe(path.basename(repoRoot))
    expect(sidebar.projectGroups[0]?.branchName).toBe("main")
  })
})

/**
 * The anchor has to survive operations that rewrite the working tree without
 * changing what is dirty. `git pull --rebase --autostash` is the one that bit
 * us: it pops the stash, rewriting still-dirty files, so their mtimes jump to
 * now. Reading mtimes fresh each time made dirtySinceMs leap forward past
 * chats that were correctly flagged before the pull.
 */
describe("WorktreeProbe dirty-since ledger", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  const NOON = 1_800_000_000_000

  function probeWith(onChange = () => {}) {
    const state = createEmptyState()
    return new WorktreeProbe(() => state, onChange)
  }

  test("keeps the first-seen time when a path's mtime later churns", async () => {
    const probe = probeWith()

    probe.recordExternalProbe("p", { dirty: true, files: [{ path: "app.txt", mtimeMs: NOON }] })
    expect(probe.getStates().get("p")?.dirtySinceMs).toBe(NOON)

    // The pull: same path, same content, brand-new mtime.
    probe.recordExternalProbe("p", { dirty: true, files: [{ path: "app.txt", mtimeMs: NOON + 30 * 60_000 }] })

    expect(probe.getStates().get("p")?.dirtySinceMs).toBe(NOON)
  })

  test("a chat flagged before a pull stays flagged after it", async () => {
    const probe = probeWith()
    const turnEndedAt = NOON + 5 * 60_000

    probe.recordExternalProbe("p", { dirty: true, files: [{ path: "app.txt", mtimeMs: NOON }] })
    const beforePull = probe.getStates().get("p")!
    expect(turnEndedAt > beforePull.dirtySinceMs!).toBe(true)

    probe.recordExternalProbe("p", { dirty: true, files: [{ path: "app.txt", mtimeMs: NOON + 30 * 60_000 }] })
    const afterPull = probe.getStates().get("p")!

    // The whole point of the ledger.
    expect(turnEndedAt > afterPull.dirtySinceMs!).toBe(true)
  })

  test("a newly dirtied path cannot pull the anchor backwards", async () => {
    const probe = probeWith()

    probe.recordExternalProbe("p", { dirty: true, files: [{ path: "a.txt", mtimeMs: NOON }] })
    probe.recordExternalProbe("p", {
      dirty: true,
      files: [{ path: "a.txt", mtimeMs: NOON }, { path: "b.txt", mtimeMs: NOON + 60_000 }],
    })

    // Oldest still wins; the new file just joins the episode.
    expect(probe.getStates().get("p")?.dirtySinceMs).toBe(NOON)
  })

  test("a path that goes clean drops out of the anchor", async () => {
    const probe = probeWith()

    probe.recordExternalProbe("p", {
      dirty: true,
      files: [{ path: "old.txt", mtimeMs: NOON }, { path: "new.txt", mtimeMs: NOON + 60_000 }],
    })
    // old.txt was committed; only new.txt is still dirty.
    probe.recordExternalProbe("p", { dirty: true, files: [{ path: "new.txt", mtimeMs: NOON + 60_000 }] })

    expect(probe.getStates().get("p")?.dirtySinceMs).toBe(NOON + 60_000)
  })

  test("a clean tree clears the ledger, so a re-dirtied path starts a new episode", async () => {
    const probe = probeWith()

    probe.recordExternalProbe("p", { dirty: true, files: [{ path: "app.txt", mtimeMs: NOON }] })
    probe.recordExternalProbe("p", { dirty: false, files: [] })
    expect(probe.getStates().get("p")).toEqual({ dirty: false })

    probe.recordExternalProbe("p", { dirty: true, files: [{ path: "app.txt", mtimeMs: NOON + 60_000 }] })

    expect(probe.getStates().get("p")?.dirtySinceMs).toBe(NOON + 60_000)
  })

  test("ignores first-seen times older than the anchor floor", async () => {
    const probe = probeWith()
    const stale = Date.now() - 30 * 24 * 60 * 60 * 1000
    const recent = Date.now()

    probe.recordExternalProbe("p", {
      dirty: true,
      files: [{ path: "stale.txt", mtimeMs: stale }, { path: "recent.txt", mtimeMs: recent }],
    })

    // A long-lived scratch file must not pin the anchor weeks back.
    expect(probe.getStates().get("p")?.dirtySinceMs).toBe(recent)
  })

  test("dirty with every path stale reports no anchor at all", async () => {
    const probe = probeWith()
    const stale = Date.now() - 30 * 24 * 60 * 60 * 1000

    probe.recordExternalProbe("p", { dirty: true, files: [{ path: "stale.txt", mtimeMs: stale }] })

    expect(probe.getStates().get("p")).toEqual({ dirty: true })
  })
})
