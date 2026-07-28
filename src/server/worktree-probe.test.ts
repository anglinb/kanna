import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"
import { createEmptyState, type StoreState } from "./events"
import { deriveSidebarData } from "./read-models"
import { extractRemoteOwner, WorktreeProbe } from "./worktree-probe"
import { TurnFileTracker } from "./worktree-snapshot"

/**
 * The exact seam server.ts wires: turn start snapshots the tree, turn end
 * records the delta and then reprobes. Returns the in-flight promises so tests
 * can await work the production hooks deliberately fire and forget.
 */
function wireTurnTracking(store: EventStore, probe: WorktreeProbe) {
  const turnStarted: Array<Promise<void>> = []
  const turnEnded: Array<Promise<void>> = []
  const tracker = new TurnFileTracker({
    resolveChatPath: (chatId) => {
      const chat = store.state.chatsById.get(chatId)
      const project = chat ? store.state.projectsById.get(chat.projectId) : undefined
      return project?.localPath ?? null
    },
    recordPaths: (chatId, paths) => store.recordFilesTouched(chatId, paths),
  })
  store.onTurnStarted = (chatId) => {
    turnStarted.push(tracker.beginTurn(chatId))
  }
  store.onTurnEnded = (chatId) => {
    turnEnded.push(tracker.endTurn(chatId).then(() => probe.refreshForChat(chatId)))
  }
  return { tracker, turnStarted, turnEnded }
}

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
    expect(probe.getStates().get("project-1")).toEqual({ dirty: false, paths: new Set() })

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await probe.refreshForChat("chat-1")

    const recorded = probe.getStates().get("project-1")
    expect(recorded?.dirty).toBe(true)
    expect([...(recorded?.paths ?? [])]).toEqual(["app.txt"])
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

    expect(probe.getStates().get("project-1")).toEqual({ dirty: false, paths: new Set() })
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

    probe.recordExternalProbe("project-1", { dirty: true, paths: ["a.txt"] })

    expect(probe.getStates().get("project-1")).toEqual({ dirty: true, paths: new Set(["a.txt"]) })
    expect(changes).toBe(1)
  })

  test("a project that is not a repo reports not dirty", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-plain-"))
    tempDirs.push(root)
    const state = createState(root, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await probe.refreshForChat("chat-1")

    expect(probe.getStates().get("project-1")).toEqual({ dirty: false, paths: new Set() })
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
    const { turnStarted, turnEnded } = wireTurnTracking(store, probe)

    // An agent edits a file during its turn.
    await store.recordTurnStarted(chat.id)
    await Promise.all(turnStarted)
    await writeFile(path.join(repoRoot, "app.txt"), "changed by agent\n", "utf8")
    await store.recordTurnFinished(chat.id)
    await Promise.all(turnEnded)

    expect(broadcasts).toBeGreaterThan(0)
    expect(store.state.chatsById.get(chat.id)?.touchedPaths).toEqual(["app.txt"])
    const flagged = deriveSidebarData(store.state, new Map(), { workingTrees: probe.getStates() })
    expect(flagged.projectGroups[0]?.chats[0]?.uncommittedWork).toBe(true)

    // Committing externally clears it on the next tick.
    await run(["git", "commit", "-am", "external"], repoRoot)
    await tick(probe)

    const cleared = deriveSidebarData(store.state, new Map(), { workingTrees: probe.getStates() })
    expect(cleared.projectGroups[0]?.chats[0]?.uncommittedWork).toBeUndefined()
  })

  test("a chat that touched none of the dirty files is not flagged", async () => {
    // The case the old timestamp rule got wrong: this chat ran, and the tree is
    // dirty, but somebody else's file is what's outstanding.
    const repoRoot = await createRepo()
    const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-data-"))
    tempDirs.push(dataDir)

    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(repoRoot)
    const chat = await store.createChat(project.id)

    const probe = new WorktreeProbe(() => store.state, () => {})
    const { turnStarted, turnEnded } = wireTurnTracking(store, probe)

    await store.recordTurnStarted(chat.id)
    await Promise.all(turnStarted)
    await writeFile(path.join(repoRoot, "mine.txt"), "this chat's work\n", "utf8")
    await store.recordTurnFinished(chat.id)
    await Promise.all(turnEnded)

    // That work lands; someone else's edit is what stays outstanding.
    await run(["git", "add", "."], repoRoot)
    await run(["git", "commit", "-m", "land it"], repoRoot)
    await writeFile(path.join(repoRoot, "theirs.txt"), "another agent\n", "utf8")
    await probe.refreshForChat(chat.id)

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

  test("picks up the origin owner, and survives a repo with no origin", async () => {
    // The owner qualifies the repo in the sidebar's branch tooltip; a repo with
    // no remote simply has none, which must not disturb the rest of the label.
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await probe.refreshForChat("chat-1")
    expect(probe.getRepoLabels().get("project-1")?.repoOwner).toBeUndefined()

    await run(["git", "remote", "add", "origin", "git@github.com:acme/widgets.git"], repoRoot)
    // A remote alone doesn't move HEAD or the index, so the stamp is unchanged —
    // re-read explicitly rather than via the tick, which is stamp-gated.
    await probe.refreshForChat("chat-1")

    expect(probe.getRepoLabels().get("project-1")?.repoOwner).toBe("acme")
  })

  test("resolves the origin to a browsable page, host and all", async () => {
    // The client never sees the remote URL, and the host is the part it can't
    // reconstruct from `owner/repo` — so "Open on GitHub" is only correct
    // because this ran.
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await probe.refreshForChat("chat-1")
    expect(probe.getRepoLabels().get("project-1")?.repoUrl).toBeUndefined()

    await run(["git", "remote", "add", "origin", "git@github.com:acme/widgets.git"], repoRoot)
    await probe.refreshForChat("chat-1")

    expect(probe.getRepoLabels().get("project-1")?.repoUrl).toBe("https://github.com/acme/widgets")
  })

  test("leaves a local-path remote without a page, rather than inventing one", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await run(["git", "remote", "add", "origin", "/srv/git/widgets.git"], repoRoot)
    await probe.refreshForChat("chat-1")

    const label = probe.getRepoLabels().get("project-1")
    expect(label?.repoUrl).toBeUndefined()
    // And the rest of the label is undisturbed by the remote it couldn't use.
    expect(label?.repoName).toBe(path.basename(repoRoot))
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

  test("a probe supplied from outside doesn't freeze the branch label", async () => {
    // The git panel's refresh hands us a scan for free (`recordExternalProbe`),
    // which banks a fresh stamp so the tick doesn't redo the same scan. That
    // stamp must not also count as a *label* read: a checkout followed by a
    // panel refresh would otherwise leave the sidebar naming the old branch
    // until some unrelated commit moved the index — while the git panel, which
    // reads the branch itself, showed the new one.
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await tick(probe)
    expect(probe.getRepoLabels().get("project-1")?.branchName).toBe("main")

    await run(["git", "checkout", "-b", "feature/side-quest"], repoRoot)
    probe.recordExternalProbe("project-1", { dirty: false, paths: [] })
    // Fire-and-forget by design; let its stamp write land before the tick.
    await new Promise((resolve) => setTimeout(resolve, 20))
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
    // A missing label alone can't say this — it also covers every project the
    // probe hasn't reached yet — so the answer is tracked separately.
    expect(probe.getProjectsWithoutRepo().has("project-1")).toBe(true)
  })

  test("nothing is claimed about a project the probe has not looked at", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    expect(probe.getProjectsWithoutRepo().has("project-1")).toBe(false)

    await probe.refreshForChat("chat-1")

    expect(probe.getProjectsWithoutRepo().has("project-1")).toBe(false)
  })

  test("learning a folder is not a repo is itself a broadcast", async () => {
    // There is no label to drop, so the repo-label path stays quiet — but the
    // sidebar has just learned it can offer to initialize the folder.
    const plainDir = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-plain-"))
    tempDirs.push(plainDir)
    const state = createState(plainDir, { lastTurnEndedAt: 1 })
    let changes = 0
    const probe = new WorktreeProbe(() => state, () => {
      changes += 1
    })

    await probe.refreshForChat("chat-1")

    expect(changes).toBe(1)
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
    expect(sidebar.projectGroups[0]?.hasGitRepo).toBe(true)
  })

  test("the sidebar snapshot states a folder is not a repo, but only once probed", async () => {
    const plainDir = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-plain-"))
    tempDirs.push(plainDir)
    const state = createState(plainDir, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    const unprobed = deriveSidebarData(state, new Map(), {
      repoLabels: probe.getRepoLabels(),
      projectsWithoutRepo: probe.getProjectsWithoutRepo(),
    })
    expect(unprobed.projectGroups[0]?.hasGitRepo).toBeUndefined()

    await probe.refreshForChat("chat-1")

    const probed = deriveSidebarData(state, new Map(), {
      repoLabels: probe.getRepoLabels(),
      projectsWithoutRepo: probe.getProjectsWithoutRepo(),
    })
    expect(probed.projectGroups[0]?.hasGitRepo).toBe(false)
  })
})

describe("extractRemoteOwner", () => {
  test("reads the owner out of every remote URL shape git writes", () => {
    expect(extractRemoteOwner("git@github.com:acme/widgets.git")).toBe("acme")
    expect(extractRemoteOwner("ssh://git@github.com/acme/widgets.git")).toBe("acme")
    expect(extractRemoteOwner("https://github.com/acme/widgets.git")).toBe("acme")
    expect(extractRemoteOwner("https://github.com/acme/widgets")).toBe("acme")
  })

  test("is host-agnostic, including nested group paths", () => {
    // GitLab subgroups: the owner is whatever sits directly above the repo.
    expect(extractRemoteOwner("https://gitlab.com/acme/tools/widgets.git")).toBe("tools")
    expect(extractRemoteOwner("git@git.internal:acme/widgets.git")).toBe("acme")
  })

  test("has no owner to give for a local or ownerless remote", () => {
    expect(extractRemoteOwner("/srv/git/widgets.git")).toBeUndefined()
    expect(extractRemoteOwner(undefined)).toBeUndefined()
  })
})
