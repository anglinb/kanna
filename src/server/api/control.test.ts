import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "../event-store"
import {
  addProject,
  assertMaySpawn,
  ControlError,
  createChat,
  listChats,
  listProjects,
  reloadFromDisk,
  sendMessage,
  type ControlDeps,
} from "./control"

async function withStore<T>(run: (store: EventStore, dataDir: string) => Promise<T>) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-control-"))
  const store = new EventStore(dataDir)
  await store.initialize()
  try {
    return await run(store, dataDir)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
}

interface SendCall {
  chatId?: string
  projectId?: string
  content: string
  agentOrigin?: { chatId: string }
}

function makeDeps(store: EventStore, options: { activeChatIds?: string[] } = {}) {
  const sends: SendCall[] = []
  const cancelled: string[] = []
  const closed: string[] = []
  const tracked: string[] = []
  let broadcasts = 0

  const deps: ControlDeps = {
    store,
    appSettings: { getSnapshot: () => ({ transcript: { windowAssistantMessages: 50 } }) as never },
    agent: {
      getActiveStatuses: () =>
        new Map((options.activeChatIds ?? []).map((chatId) => [chatId, "running" as const])),
      getDrainingChatIds: () => new Set(),
      async send(command, options) {
        let chatId = command.chatId
        if (!chatId) {
          const created = await store.createChat(command.projectId!, { agentOrigin: options?.agentOrigin })
          chatId = created.id
        }
        sends.push({
          chatId: command.chatId,
          projectId: command.projectId,
          content: command.content,
          agentOrigin: options?.agentOrigin,
        })
        return { chatId }
      },
      async cancel(chatId) {
        cancelled.push(chatId)
      },
      async closeChat(chatId) {
        closed.push(chatId)
      },
    },
    broadcast: () => {
      broadcasts += 1
    },
    analytics: {
      track: (event) => {
        tracked.push(event)
      },
    },
  }

  return { deps, sends, cancelled, closed, tracked, broadcastCount: () => broadcasts }
}

describe("control", () => {
  test("addProject reports whether the path was already open", async () => {
    await withStore(async (store, dataDir) => {
      const { deps } = makeDeps(store)
      const projectPath = path.join(dataDir, "proj")

      const first = await addProject(deps, { localPath: projectPath, title: "Proj" })
      expect(first.created).toBe(true)

      const second = await addProject(deps, { localPath: projectPath })
      expect(second.created).toBe(false)
      expect(second.project.id).toBe(first.project.id)
      expect(listProjects(deps).projects).toHaveLength(1)
    })
  })

  test("listChats scopes to a project and excludes archived chats by default", async () => {
    await withStore(async (store, dataDir) => {
      const { deps } = makeDeps(store)
      const a = await store.openProject(path.join(dataDir, "a"))
      const b = await store.openProject(path.join(dataDir, "b"))
      const inA = await store.createChat(a.id)
      await store.createChat(b.id)
      const archived = await store.createChat(a.id)
      await store.archiveChat(archived.id)

      const listed = listChats(deps, { projectId: a.id })
      expect(listed.chats.map((chat) => chat.id)).toEqual([inA.id])
      expect(listChats(deps, { projectId: a.id, includeArchived: true }).total).toBe(2)
      expect(listChats(deps, {}).total).toBe(2)
    })
  })

  test("listChats rejects a non-positive limit and caps at the maximum", async () => {
    await withStore(async (store, dataDir) => {
      const { deps } = makeDeps(store)
      const project = await store.openProject(path.join(dataDir, "a"))
      await store.createChat(project.id)

      expect(() => listChats(deps, { limit: 0 })).toThrow(ControlError)
      expect(listChats(deps, { limit: 10_000 }).chats).toHaveLength(1)
    })
  })

  test("an agent-created chat is marked with the chat that created it", async () => {
    await withStore(async (store, dataDir) => {
      const { deps, sends } = makeDeps(store)
      const project = await store.openProject(path.join(dataDir, "a"))
      const caller = await store.createChat(project.id)

      const created = await createChat(
        deps,
        { projectId: project.id, content: "do the thing" },
        { chatId: caller.id }
      )

      expect(created.started).toBe(true)
      expect(created.chat.createdByChatId).toBe(caller.id)
      expect(sends[0]?.agentOrigin).toEqual({ chatId: caller.id })
      expect(store.getChat(created.chat.id)?.agentOrigin).toEqual({ chatId: caller.id })
    })
  })

  test("an empty chat created by an agent is marked too", async () => {
    await withStore(async (store, dataDir) => {
      const { deps, sends } = makeDeps(store)
      const project = await store.openProject(path.join(dataDir, "a"))
      const caller = await store.createChat(project.id)

      const created = await createChat(deps, { projectId: project.id }, { chatId: caller.id })

      expect(created.started).toBe(false)
      expect(sends).toHaveLength(0)
      expect(created.chat.createdByChatId).toBe(caller.id)
    })
  })

  test("a human caller leaves no agent origin", async () => {
    await withStore(async (store, dataDir) => {
      const { deps } = makeDeps(store)
      const project = await store.openProject(path.join(dataDir, "a"))

      const created = await createChat(deps, { projectId: project.id, content: "hi" })

      expect(created.chat.createdByChatId).toBeNull()
    })
  })

  describe("fan-out guard", () => {
    test("an agent-created chat cannot create another", async () => {
      await withStore(async (store, dataDir) => {
        const { deps } = makeDeps(store)
        const project = await store.openProject(path.join(dataDir, "a"))
        const root = await store.createChat(project.id)
        const spawned = await store.createChat(project.id, { agentOrigin: { chatId: root.id } })

        await expect(
          createChat(deps, { projectId: project.id, content: "go deeper" }, { chatId: spawned.id })
        ).rejects.toThrow(/started by an agent/)
      })
    })

    test("an agent-created chat cannot send to another chat", async () => {
      await withStore(async (store, dataDir) => {
        const { deps } = makeDeps(store)
        const project = await store.openProject(path.join(dataDir, "a"))
        const root = await store.createChat(project.id)
        const spawned = await store.createChat(project.id, { agentOrigin: { chatId: root.id } })
        const target = await store.createChat(project.id)

        await expect(
          sendMessage(deps, { chatId: target.id, content: "hi" }, { chatId: spawned.id })
        ).rejects.toThrow(/started by an agent/)
      })
    })

    test("an agent cannot send to its own chat", async () => {
      await withStore(async (store, dataDir) => {
        const { deps } = makeDeps(store)
        const project = await store.openProject(path.join(dataDir, "a"))
        const caller = await store.createChat(project.id)

        await expect(
          sendMessage(deps, { chatId: caller.id, content: "again" }, { chatId: caller.id })
        ).rejects.toThrow(/its own chat/)
      })
    })

    test("a human-created chat may spawn, and the guard is a no-op without a caller", async () => {
      await withStore(async (store, dataDir) => {
        const { deps, sends } = makeDeps(store)
        const project = await store.openProject(path.join(dataDir, "a"))
        const root = await store.createChat(project.id)
        const target = await store.createChat(project.id)

        const sent = await sendMessage(deps, { chatId: target.id, content: "hi" }, { chatId: root.id })
        expect(sent.chatId).toBe(target.id)
        expect(sends).toHaveLength(1)

        expect(() => assertMaySpawn(deps, undefined, target.id)).not.toThrow()
      })
    })

    test("forking an agent-created chat carries the marker over", async () => {
      await withStore(async (store, dataDir) => {
        const { deps } = makeDeps(store)
        const project = await store.openProject(path.join(dataDir, "a"))
        const root = await store.createChat(project.id)
        const spawned = await store.createChat(project.id, { agentOrigin: { chatId: root.id } })
        await store.setChatProvider(spawned.id, "claude")
        await store.setSessionToken(spawned.id, "session-1")

        const fork = await store.forkChat(spawned.id)

        expect(fork.agentOrigin).toEqual({ chatId: root.id })
        expect(() => assertMaySpawn(deps, { chatId: fork.id })).toThrow(ControlError)
      })
    })

    test("the guard survives a restart, since the marker is persisted", async () => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-control-restart-"))
      try {
        const first = new EventStore(dataDir)
        await first.initialize()
        const project = await first.openProject(path.join(dataDir, "a"))
        const root = await first.createChat(project.id)
        const spawned = await first.createChat(project.id, { agentOrigin: { chatId: root.id } })

        const reloaded = new EventStore(dataDir)
        await reloaded.initialize()
        const { deps } = makeDeps(reloaded)

        expect(reloaded.getChat(spawned.id)?.agentOrigin).toEqual({ chatId: root.id })
        expect(() => assertMaySpawn(deps, { chatId: spawned.id })).toThrow(ControlError)
      } finally {
        await rm(dataDir, { recursive: true, force: true })
      }
    })
  })

  test("missing chats and projects surface as 404s", async () => {
    await withStore(async (store) => {
      const { deps } = makeDeps(store)
      await expect(createChat(deps, { projectId: "nope", content: "hi" })).rejects.toMatchObject({ status: 404 })
      await expect(sendMessage(deps, { chatId: "nope", content: "hi" })).rejects.toMatchObject({ status: 404 })
    })
  })
})

describe("reloadFromDisk", () => {
  test("re-reads the store and pushes the result to clients", async () => {
    await withStore(async (store, dataDir) => {
      const { deps, broadcastCount } = makeDeps(store)
      const project = await store.openProject(path.join(dataDir, "a"))

      const other = new EventStore(dataDir)
      await other.initialize()
      const added = await other.createChat(project.id)

      const result = await reloadFromDisk(deps)

      expect(store.getChat(added.id)).not.toBeNull()
      expect(result.chats).toBe(1)
      expect(result.projects).toBe(1)
      expect(broadcastCount()).toBe(1)
    })
  })

  test("releases the harness session of a chat that vanished from disk", async () => {
    await withStore(async (store, dataDir) => {
      const project = await store.openProject(path.join(dataDir, "a"))
      const kept = await store.createChat(project.id)
      const vanished = await store.createChat(project.id)
      await store.compact()

      // Both are mid-turn when the reload lands.
      const { deps, cancelled, closed } = makeDeps(store, { activeChatIds: [kept.id, vanished.id] })

      const snapshotPath = path.join(dataDir, "snapshot.json")
      const snapshot = JSON.parse(await Bun.file(snapshotPath).text()) as { chats: { id: string }[] }
      snapshot.chats = snapshot.chats.filter((entry) => entry.id !== vanished.id)
      await Bun.write(snapshotPath, JSON.stringify(snapshot))

      const result = await reloadFromDisk(deps)

      // The chat that is gone gets the same treatment deleting it would give:
      // stop the turn, then release the session. The other is left running.
      expect(result.droppedChatIds).toEqual([vanished.id])
      expect(cancelled).toEqual([vanished.id])
      expect(closed).toEqual([vanished.id])
      expect(result.activeChatIds).toEqual([kept.id])
    })
  })

  test("a refused reload is a 409 and changes nothing", async () => {
    await withStore(async (store, dataDir) => {
      const project = await store.openProject(path.join(dataDir, "a"))
      const chat = await store.createChat(project.id)
      await store.compact()
      const { deps, cancelled, closed, broadcastCount } = makeDeps(store, { activeChatIds: [chat.id] })

      await Bun.write(path.join(dataDir, "snapshot.json"), "{ not json")

      await expect(reloadFromDisk(deps)).rejects.toMatchObject({ status: 409 })
      expect(store.getChat(chat.id)).not.toBeNull()
      // No session torn down, no snapshot pushed, on a reload that never ran.
      expect(cancelled).toEqual([])
      expect(closed).toEqual([])
      expect(broadcastCount()).toBe(0)
    })
  })
})
