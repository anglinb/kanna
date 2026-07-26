import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
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

    probe.recordExternalProbe("project-1", { dirty: true, dirtySinceMs: 1_234 })

    expect(probe.getStates().get("project-1")).toEqual({ dirty: true, dirtySinceMs: 1_234 })
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
})
