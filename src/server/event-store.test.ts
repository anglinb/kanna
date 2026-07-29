import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { TranscriptEntry } from "../shared/types"
import type { SnapshotFile } from "./events"
import { EventStore } from "./event-store"

const originalRuntimeProfile = process.env.KANNA_RUNTIME_PROFILE
const tempDirs: string[] = []

afterEach(async () => {
  if (originalRuntimeProfile === undefined) {
    delete process.env.KANNA_RUNTIME_PROFILE
  } else {
    process.env.KANNA_RUNTIME_PROFILE = originalRuntimeProfile
  }

  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createTempDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "kanna-event-store-"))
  tempDirs.push(dir)
  return dir
}

function entry(kind: "user_prompt" | "assistant_text", createdAt: number, extra: Record<string, unknown> = {}): TranscriptEntry {
  const base = { _id: `${kind}-${createdAt}`, createdAt }
  if (kind === "user_prompt") {
    return { ...base, kind, content: String(extra.content ?? "") }
  }
  return { ...base, kind, text: String(extra.content ?? extra.text ?? "") }
}

describe("EventStore", () => {
  test("uses the runtime profile for the default data dir", () => {
    process.env.KANNA_RUNTIME_PROFILE = "dev"

    const store = new EventStore()

    expect(store.dataDir).toEndWith("/.kanna-dev/data")
  })

  test("migrates legacy snapshot and messages log transcripts into per-chat files", async () => {
    const dataDir = await createTempDataDir()
    const snapshotPath = join(dataDir, "snapshot.json")
    const messagesLogPath = join(dataDir, "messages.jsonl")
    const chatId = "chat-1"

    const snapshot: SnapshotFile = {
      v: 2,
      generatedAt: 10,
      projects: [{
        id: "project-1",
        localPath: "/tmp/project",
        title: "Project",
        createdAt: 1,
        updatedAt: 5,
      }],
      chats: [{
        id: chatId,
        projectId: "project-1",
        title: "Chat",
        createdAt: 1,
        updatedAt: 5,
        unread: false,
        provider: null,
        planMode: false,
        autoPlan: false,
        sessionToken: null,
        lastTurnOutcome: null,
      }],
      messages: [{
        chatId,
        entries: [
          entry("user_prompt", 100, { content: "hello" }),
        ],
      }],
    }

    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8")
    await writeFile(messagesLogPath, `${JSON.stringify({
      v: 2,
      type: "message_appended",
      timestamp: 101,
      chatId,
      entry: entry("assistant_text", 101, { content: "world" }),
    })}\n`, "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    const progress: string[] = []
    const migrated = await store.migrateLegacyTranscripts((message) => {
      progress.push(message)
    })

    expect(migrated).toBe(true)
    expect(progress.some((message) => message.includes("transcript migration detected"))).toBe(true)
    expect(progress.at(-1)).toContain("transcript migration complete")
    expect(store.getMessages(chatId)).toEqual([
      entry("user_prompt", 100, { content: "hello" }),
      entry("assistant_text", 101, { text: "world" }),
    ])

    const migratedSnapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as SnapshotFile
    expect(migratedSnapshot.messages).toBeUndefined()
    expect(await readFile(messagesLogPath, "utf8")).toBe("")
    expect(await readFile(join(dataDir, "transcripts", `${chatId}.jsonl`), "utf8")).toContain('"kind":"assistant_text"')
  })

  test("appends new transcript entries only to the per-chat transcript file", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 200, { content: "hello" }))
    await store.appendMessage(chat.id, entry("assistant_text", 201, { content: "world" }))
    await store.compact()

    expect(store.getMessages(chat.id)).toEqual([
      entry("user_prompt", 200, { content: "hello" }),
      entry("assistant_text", 201, { text: "world" }),
    ])
    expect(await readFile(join(dataDir, "messages.jsonl"), "utf8")).toBe("")

    const snapshot = JSON.parse(await readFile(join(dataDir, "snapshot.json"), "utf8")) as SnapshotFile
    expect(snapshot.messages).toBeUndefined()
    expect(existsSync(join(dataDir, "transcripts", `${chat.id}.jsonl`))).toBe(true)
  })

  test("getTranscriptPath points at the per-chat transcript file", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 200, { content: "hello" }))

    expect(store.getTranscriptPath(chat.id)).toBe(join(dataDir, "transcripts", `${chat.id}.jsonl`))
    expect(existsSync(store.getTranscriptPath(chat.id))).toBe(true)
  })

  test("persists queued messages across restart and removes promoted entries", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    const first = await store.enqueueMessage(chat.id, {
      content: "first queued",
      attachments: [],
      provider: "codex",
      model: "gpt-5.4",
      planMode: false,
      autoPlan: false,
    })
    const second = await store.enqueueMessage(chat.id, {
      content: "second queued",
      attachments: [],
      provider: "claude",
      model: "claude-sonnet-4-6",
      planMode: true,
      autoPlan: false,
    })

    expect(store.getQueuedMessages(chat.id).map((message) => message.content)).toEqual([
      "first queued",
      "second queued",
    ])

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getQueuedMessages(chat.id).map((message) => message.content)).toEqual([
      "first queued",
      "second queued",
    ])

    await reloaded.removeQueuedMessage(chat.id, first.id)
    expect(reloaded.getQueuedMessages(chat.id).map((message) => message.id)).toEqual([second.id])
  })

  test("marks chats unread on completed turns and clears unread when marked read", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    expect(store.getChat(chat.id)?.unread).toBe(false)

    await store.recordTurnFinished(chat.id)
    expect(store.getChat(chat.id)?.unread).toBe(true)

    await store.setChatReadState(chat.id, false)
    expect(store.getChat(chat.id)?.unread).toBe(false)

    await store.recordTurnFailed(chat.id, "boom")
    expect(store.getChat(chat.id)?.unread).toBe(true)

    await store.recordTurnCancelled(chat.id)
    expect(store.getChat(chat.id)?.unread).toBe(true)

    await store.compact()

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getChat(chat.id)?.unread).toBe(true)
  })

  test("stores and resolves a read anchor across restart", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    expect(store.getChatReadAnchor(chat.id)).toBeNull()

    await store.appendMessage(chat.id, entry("user_prompt", 200, { content: "hello" }))
    await store.appendMessage(chat.id, entry("assistant_text", 201, { content: "world" }))
    await store.appendMessage(chat.id, entry("assistant_text", 202, { content: "again" }))

    await store.setChatReadAnchor(chat.id, "user_prompt-200", false)

    expect(store.getChatReadAnchor(chat.id)).toEqual({
      messageId: "user_prompt-200",
      atEnd: false,
    })

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getChatReadAnchor(chat.id)).toEqual({
      messageId: "user_prompt-200",
      atEnd: false,
    })
  })

  test("survives compaction", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.appendMessage(chat.id, entry("user_prompt", 200, { content: "hello" }))
    await store.setChatReadAnchor(chat.id, "user_prompt-200", true)
    await store.appendMessage(chat.id, entry("assistant_text", 201, { content: "world" }))

    await store.compact()

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getChatReadAnchor(chat.id)).toEqual({
      messageId: "user_prompt-200",
      atEnd: true,
    })
  })

  test("resolves a read anchor to null when the anchored message is gone", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.appendMessage(chat.id, entry("user_prompt", 200, { content: "hello" }))
    await store.setChatReadAnchor(chat.id, "missing-entry", false)

    expect(store.getChat(chat.id)?.readAnchor?.messageId).toBe("missing-entry")
    expect(store.getChatReadAnchor(chat.id)).toBeNull()
  })

  test("skips redundant read anchor writes", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 200, { content: "hello" }))

    const chatsLogPath = join(dataDir, "chats.jsonl")
    const countAnchorEvents = async () => {
      const contents = await readFile(chatsLogPath, "utf8")
      return contents.split("\n").filter((line) => line.includes("chat_read_anchor_set")).length
    }

    await store.setChatReadAnchor(chat.id, "user_prompt-200", false)
    expect(await countAnchorEvents()).toBe(1)

    // Same anchor + same atEnd -> no second event.
    await store.setChatReadAnchor(chat.id, "user_prompt-200", false)
    expect(await countAnchorEvents()).toBe(1)

    // Flipping atEnd alone is still a real change.
    await store.setChatReadAnchor(chat.id, "user_prompt-200", true)
    expect(await countAnchorEvents()).toBe(2)
  })

  test("preserves read state after a finished turn across restart", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.recordTurnFinished(chat.id)
    await store.setChatReadState(chat.id, false)

    expect(store.getChat(chat.id)?.unread).toBe(false)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getChat(chat.id)?.unread).toBe(false)
  })

  test("preserves read state after a failed turn across restart", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.recordTurnFailed(chat.id, "boom")
    await store.setChatReadState(chat.id, false)

    expect(store.getChat(chat.id)?.unread).toBe(false)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getChat(chat.id)?.unread).toBe(false)
  })

  test("prefers mark-read over turn completion when replay timestamps tie", async () => {
    const dataDir = await createTempDataDir()
    const chatsLogPath = join(dataDir, "chats.jsonl")
    const turnsLogPath = join(dataDir, "turns.jsonl")
    const projectId = "project-1"
    const chatId = "chat-1"
    const timestamp = 100

    await writeFile(chatsLogPath, [
      JSON.stringify({
        v: 2,
        type: "chat_created",
        timestamp,
        chatId,
        projectId,
        title: "Chat",
      }),
      JSON.stringify({
        v: 2,
        type: "chat_read_state_set",
        timestamp,
        chatId,
        unread: false,
      }),
      "",
    ].join("\n"), "utf8")
    await writeFile(turnsLogPath, [
      JSON.stringify({
        v: 2,
        type: "turn_finished",
        timestamp,
        chatId,
      }),
      "",
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    expect(store.getChat(chatId)?.unread).toBe(false)
  })

  test("loads chats without unread from older snapshots as read", async () => {
    const dataDir = await createTempDataDir()
    const snapshotPath = join(dataDir, "snapshot.json")

    const snapshot = {
      v: 2,
      generatedAt: 10,
      projects: [{
        id: "project-1",
        localPath: "/tmp/project",
        title: "Project",
        createdAt: 1,
        updatedAt: 5,
      }],
      chats: [{
        id: "chat-1",
        projectId: "project-1",
        title: "Chat",
        createdAt: 1,
        updatedAt: 5,
        provider: null,
        planMode: false,
        autoPlan: false,
        sessionToken: null,
        lastTurnOutcome: null,
      }],
    }

    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    expect(store.getChat("chat-1")?.unread).toBe(false)
  })

  test("persists sidebar project order across restart and compaction", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const first = await store.openProject("/tmp/project-a")
    const second = await store.openProject("/tmp/project-b")

    await store.setSidebarProjectOrder([second.id, first.id])
    expect(store.getSidebarProjectOrder()).toEqual([second.id, first.id])
    expect(JSON.parse(await readFile(join(dataDir, "sidebar-order.json"), "utf8"))).toEqual([second.id, first.id])

    await store.compact()

    const snapshot = JSON.parse(await readFile(join(dataDir, "snapshot.json"), "utf8")) as SnapshotFile
    expect(snapshot.sidebarProjectOrder).toBeUndefined()

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getSidebarProjectOrder()).toEqual([second.id, first.id])
  })

  test("renames a project sidebar title without changing project metadata or local path", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    await store.renameProjectSidebarTitle(project.id, "Sidebar Name")

    expect(store.getProject(project.id)?.title).toBe("project")
    expect(store.getProject(project.id)?.sidebarTitle).toBe("Sidebar Name")
    expect(store.getProject(project.id)?.localPath).toBe("/tmp/project")
    expect(store.state.projectIdsByPath.get("/tmp/project")).toBe(project.id)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getProject(project.id)?.title).toBe("project")
    expect(reloaded.getProject(project.id)?.sidebarTitle).toBe("Sidebar Name")
    expect(reloaded.getProject(project.id)?.localPath).toBe("/tmp/project")
    expect(reloaded.state.projectIdsByPath.get("/tmp/project")).toBe(project.id)

    await reloaded.renameProjectSidebarTitle(project.id, "")
    expect(reloaded.getProject(project.id)?.title).toBe("project")
    expect(reloaded.getProject(project.id)?.sidebarTitle).toBeUndefined()
    expect(reloaded.getProject(project.id)?.localPath).toBe("/tmp/project")
  })

  test("migrates legacy sidebar project order from existing snapshots and project logs", async () => {
    const dataDir = await createTempDataDir()
    const snapshotPath = join(dataDir, "snapshot.json")
    const projectsLogPath = join(dataDir, "projects.jsonl")

    const snapshot: SnapshotFile = {
      v: 2,
      generatedAt: 10,
      projects: [
        {
          id: "project-1",
          localPath: "/tmp/project-a",
          title: "Project A",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "project-2",
          localPath: "/tmp/project-b",
          title: "Project B",
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      chats: [],
      sidebarProjectOrder: ["project-1"],
    }

    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8")
    await writeFile(projectsLogPath, [
      JSON.stringify({
        v: 2,
        type: "sidebar_project_order_set",
        timestamp: 20,
        projectIds: ["project-2", "project-1"],
      }),
      "",
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    expect(store.getSidebarProjectOrder()).toEqual(["project-2", "project-1"])
    expect(JSON.parse(await readFile(join(dataDir, "sidebar-order.json"), "utf8"))).toEqual(["project-2", "project-1"])
  })

  test("ignores an invalid sidebar order file without resetting store state", async () => {
    const dataDir = await createTempDataDir()
    await writeFile(join(dataDir, "sidebar-order.json"), "{not-json", "utf8")

    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const store = new EventStore(dataDir)
      await store.initialize()

      const project = await store.openProject("/tmp/project")

      const reloaded = new EventStore(dataDir)
      await reloaded.initialize()

      expect(reloaded.getProject(project.id)?.localPath).toBe("/tmp/project")
      expect(reloaded.getSidebarProjectOrder()).toEqual([])
    } finally {
      console.warn = originalWarn
    }
  })

  test("prunes stale empty chats after five minutes", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    const staleNow = chat.createdAt + 5 * 60 * 1000

    const pruned = await store.pruneStaleEmptyChats({ now: staleNow })

    expect(pruned).toEqual([chat.id])
    expect(store.getChat(chat.id)).toBeNull()
  })

  test("does not prune recent empty chats", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    const pruned = await store.pruneStaleEmptyChats({ now: chat.createdAt + 5 * 60 * 1000 - 1 })

    expect(pruned).toEqual([])
    expect(store.getChat(chat.id)?.id).toBe(chat.id)
  })

  test("does not prune chats once they have transcript messages", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", chat.createdAt + 1, { content: "hello" }))

    const pruned = await store.pruneStaleEmptyChats({ now: chat.createdAt + 5 * 60 * 1000 })

    expect(pruned).toEqual([])
    expect(store.getChat(chat.id)?.id).toBe(chat.id)
  })

  test("does not prune stale chats that are currently active", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    const pruned = await store.pruneStaleEmptyChats({
      now: chat.createdAt + 5 * 60 * 1000,
      activeChatIds: [chat.id],
    })

    expect(pruned).toEqual([])
    expect(store.getChat(chat.id)?.id).toBe(chat.id)
  })

  test("does not prune stale chats with protected draft state", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    const pruned = await store.pruneStaleEmptyChats({
      now: chat.createdAt + 5 * 60 * 1000,
      protectedChatIds: [chat.id],
    })

    expect(pruned).toEqual([])
    expect(store.getChat(chat.id)?.id).toBe(chat.id)
  })

  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

  test("auto-archives chats thirty days behind the latest chat activity", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const old = await store.createChat(project.id)
    await store.appendMessage(old.id, entry("user_prompt", old.createdAt + 1, { content: "old" }))
    const oldActivityAt = store.getChat(old.id)!.lastMessageAt!
    // A fresh chat moves the activity anchor forward past the window.
    const fresh = await store.createChat(project.id)
    await store.appendMessage(fresh.id, entry("user_prompt", oldActivityAt + THIRTY_DAYS_MS, { content: "fresh" }))

    const archived = await store.autoArchiveStaleChats({ now: oldActivityAt + THIRTY_DAYS_MS + 1 })

    expect(archived).toEqual([old.id])
    // Archived, not deleted — still retrievable. The anchor chat is untouched.
    expect(store.getChat(old.id)?.archivedAt).toBeGreaterThan(0)
    expect(store.getChat(fresh.id)?.archivedAt).toBeUndefined()
  })

  test("measures staleness against the latest chat, not the clock — an idle month archives nothing", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", chat.createdAt + 1, { content: "hello" }))
    const lastActivityAt = store.getChat(chat.id)!.lastMessageAt!

    // Back from a long vacation: wall clock far past the window, but this is
    // the newest chat, so it anchors the reference and nothing is stale.
    const archived = await store.autoArchiveStaleChats({ now: lastActivityAt + 10 * THIRTY_DAYS_MS })

    expect(archived).toEqual([])
    expect(store.getChat(chat.id)?.archivedAt).toBeUndefined()
  })

  test("does not auto-archive chats within thirty days of the latest activity", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const old = await store.createChat(project.id)
    await store.appendMessage(old.id, entry("user_prompt", old.createdAt + 1, { content: "old" }))
    const oldActivityAt = store.getChat(old.id)!.lastMessageAt!
    const fresh = await store.createChat(project.id)
    await store.appendMessage(fresh.id, entry("user_prompt", oldActivityAt + THIRTY_DAYS_MS - 1, { content: "fresh" }))

    const archived = await store.autoArchiveStaleChats({ now: oldActivityAt + THIRTY_DAYS_MS - 1 })

    expect(archived).toEqual([])
  })

  test("leaves stale empty chats for the prune sweep instead of archiving them", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const empty = await store.createChat(project.id) // never messaged
    const fresh = await store.createChat(project.id)
    await store.appendMessage(fresh.id, entry("user_prompt", empty.createdAt + THIRTY_DAYS_MS + 1, { content: "fresh" }))

    const archived = await store.autoArchiveStaleChats({ now: empty.createdAt + THIRTY_DAYS_MS + 1 })

    expect(archived).toEqual([])
    expect(store.getChat(empty.id)?.archivedAt).toBeUndefined()
  })

  test("skips active/protected chats and already-archived chats when auto-archiving", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const active = await store.createChat(project.id)
    await store.appendMessage(active.id, entry("user_prompt", active.createdAt + 1, { content: "a" }))
    const protectedChat = await store.createChat(project.id)
    await store.appendMessage(protectedChat.id, entry("user_prompt", protectedChat.createdAt + 1, { content: "b" }))
    const alreadyArchived = await store.createChat(project.id)
    await store.appendMessage(alreadyArchived.id, entry("user_prompt", alreadyArchived.createdAt + 1, { content: "c" }))
    await store.archiveChat(alreadyArchived.id)
    // Fresh anchor far past the window so the others would otherwise qualify.
    const fresh = await store.createChat(project.id)
    await store.appendMessage(fresh.id, entry("user_prompt", active.createdAt + THIRTY_DAYS_MS + 2, { content: "d" }))

    const archived = await store.autoArchiveStaleChats({
      now: active.createdAt + THIRTY_DAYS_MS + 2,
      activeChatIds: [active.id],
      protectedChatIds: [protectedChat.id],
    })

    expect(archived).toEqual([])
  })

  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000

  test("hard-deletes chats ninety days behind the latest activity, archived or not", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const plain = await store.createChat(project.id)
    await store.appendMessage(plain.id, entry("user_prompt", plain.createdAt + 1, { content: "a" }))
    const archivedChat = await store.createChat(project.id)
    await store.appendMessage(archivedChat.id, entry("user_prompt", archivedChat.createdAt + 1, { content: "b" }))
    await store.archiveChat(archivedChat.id)
    // Fresh chat anchors the reference past the window. Measure from whichever
    // of the two is newer: they are created back-to-back off the real clock, so
    // anchoring to `plain` alone leaves `archivedChat` one millisecond short of
    // the window whenever the clock ticks between the two createChat calls.
    const stalePoint =
      Math.max(store.getChat(plain.id)!.lastMessageAt!, store.getChat(archivedChat.id)!.lastMessageAt!) +
      NINETY_DAYS_MS
    const fresh = await store.createChat(project.id)
    await store.appendMessage(fresh.id, entry("user_prompt", stalePoint, { content: "c" }))

    const deleted = await store.deleteStaleChats({ now: stalePoint + 1 })

    expect(deleted.sort()).toEqual([plain.id, archivedChat.id].sort())
    expect(store.getChat(plain.id)).toBeNull()
    expect(store.getChat(archivedChat.id)).toBeNull()
    expect(store.getChat(fresh.id)?.id).toBe(fresh.id)
  })

  test("measures deletion against the latest chat, not the clock — an idle year deletes nothing", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", chat.createdAt + 1, { content: "hello" }))
    const lastActivityAt = store.getChat(chat.id)!.lastMessageAt!

    const deleted = await store.deleteStaleChats({ now: lastActivityAt + 5 * NINETY_DAYS_MS })

    expect(deleted).toEqual([])
    expect(store.getChat(chat.id)?.id).toBe(chat.id)
  })

  test("does not hard-delete active or protected stale chats", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const active = await store.createChat(project.id)
    const protectedChat = await store.createChat(project.id)
    // Fresh anchor far past the window so the others would otherwise qualify.
    const fresh = await store.createChat(project.id)
    await store.appendMessage(fresh.id, entry("user_prompt", active.createdAt + NINETY_DAYS_MS + 1, { content: "c" }))

    const deleted = await store.deleteStaleChats({
      now: active.createdAt + NINETY_DAYS_MS + 1,
      activeChatIds: [active.id],
      protectedChatIds: [protectedChat.id],
    })

    expect(deleted).toEqual([])
    expect(store.getChat(active.id)?.id).toBe(active.id)
    expect(store.getChat(protectedChat.id)?.id).toBe(protectedChat.id)
  })

  test("auto plan defaults to false and survives a replay", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    // A chat that never saw a chat_auto_plan_set event — i.e. every chat in a
    // log written before Auto Plan existed — reads as Full Access.
    expect(store.requireChat(chat.id).autoPlan).toBe(false)

    await store.setAutoPlan(chat.id, true)
    expect(store.requireChat(chat.id).autoPlan).toBe(true)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(chat.id).autoPlan).toBe(true)
  })

  test("forks a chat with copied transcript and pending fork session token", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const source = await store.createChat(project.id)
    await store.setChatProvider(source.id, "claude")
    await store.setPlanMode(source.id, true)
    await store.setAutoPlan(source.id, true)
    await store.setSessionToken(source.id, "session-1")
    await store.appendMessage(source.id, entry("user_prompt", source.createdAt + 1, { content: "analyze this" }))
    await store.appendMessage(source.id, entry("assistant_text", source.createdAt + 2, { text: "done" }))

    const forked = await store.forkChat(source.id)

    expect(forked.id).not.toBe(source.id)
    expect(forked.title).toBe("Fork: New Chat")
    expect(forked.provider).toBe("claude")
    expect(forked.planMode).toBe(true)
    expect(forked.autoPlan).toBe(true)
    expect(forked.sessionToken).toBeNull()
    expect(forked.pendingForkSessionToken).toBe("session-1")
    expect(forked.lastTurnOutcome).toBeNull()
    // The fork inherits the copied conversation's recency, so it shows up in
    // recency-driven sidebar sections instead of reading as an empty draft.
    expect(forked.lastMessageAt).toBe(source.createdAt + 2)
    expect(forked.hasMessages).toBe(true)
    expect(store.getMessages(forked.id)).toEqual(store.getMessages(source.id))
  })

  test("lastAgentMessageAt tracks agent entries mid-turn, ignoring user prompts", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 1_000, { content: "plan this" }))
    // The user's own prompt is not agent activity.
    expect(store.requireChat(chat.id).lastAgentMessageAt).toBeUndefined()

    await store.appendMessage(chat.id, entry("assistant_text", 2_000, { text: "here's the plan" }))
    expect(store.requireChat(chat.id).lastAgentMessageAt).toBe(2_000)

    // No turn ended (the chat is parked waiting on plan approval), so this is
    // the only timestamp that reflects how fresh the chat actually is.
    expect(store.requireChat(chat.id).lastTurnEndedAt).toBeUndefined()
    expect(store.requireChat(chat.id).lastMessageAt).toBe(1_000)

    // A later user prompt doesn't drag the agent timestamp backwards.
    await store.appendMessage(chat.id, entry("user_prompt", 3_000, { content: "go" }))
    expect(store.requireChat(chat.id).lastAgentMessageAt).toBe(2_000)

    // Rebuilt from the transcript on boot, like lastMessageAt.
    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(chat.id).lastAgentMessageAt).toBe(2_000)
  })

  test("a fork inherits the source's touched paths", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const source = await store.createChat(project.id)
    await store.setChatProvider(source.id, "claude")
    await store.setSessionToken(source.id, "session-1")
    await store.appendMessage(source.id, entry("user_prompt", 1_000, { content: "edit files" }))
    await store.recordFilesTouched(source.id, [
      { path: "src/app.ts", baseBlob: "blob-app" },
      { path: "src/util.ts", baseBlob: null },
    ])

    const forked = await store.forkChat(source.id)

    // Same conversation, same claim on the files it changed — the fork belongs
    // in Relevant next to its source, not with an empty touched set. Base blobs
    // come too, so the fork expires with the same commit its source does.
    const inherited = [
      { path: "src/app.ts", baseBlob: "blob-app" },
      { path: "src/util.ts", baseBlob: null },
    ]
    expect(forked.touchedFiles).toEqual(inherited)
    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(forked.id).touchedFiles).toEqual(inherited)
  })

  test("a later turn's base blob replaces an earlier one for the same path", async () => {
    // The path was committed between the two turns, so the newer commit is what
    // the claim must be measured against — otherwise a chat with live work in a
    // file it had previously landed would read as settled.
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.recordFilesTouched(chat.id, [{ path: "src/app.ts", baseBlob: "blob-first" }])
    await store.recordFilesTouched(chat.id, [{ path: "src/app.ts", baseBlob: "blob-second" }])

    expect(store.requireChat(chat.id).touchedFiles).toEqual([{ path: "src/app.ts", baseBlob: "blob-second" }])
    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(chat.id).touchedFiles).toEqual([{ path: "src/app.ts", baseBlob: "blob-second" }])
  })

  test("line counts accumulate across turns while the base stays the latest", async () => {
    // Each event carries one turn's numstat, so a chat that keeps editing one
    // file has written the sum of them — while its *position* (the base blob)
    // is only ever the most recent commit it worked from.
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.recordFilesTouched(chat.id, [{ path: "src/app.ts", baseBlob: "blob-first", additions: 10, deletions: 2 }])
    await store.recordFilesTouched(chat.id, [{ path: "src/app.ts", baseBlob: "blob-second", additions: 5, deletions: 3 }])

    const expected = [{ path: "src/app.ts", baseBlob: "blob-second", additions: 15, deletions: 5 }]
    expect(store.requireChat(chat.id).touchedFiles).toEqual(expected)
    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(chat.id).touchedFiles).toEqual(expected)
  })

  test("a file with no counts keeps the totals it already had", async () => {
    // The backfill re-records paths to date them, carrying no numstat of its
    // own; dating a claim must not erase how much the chat wrote there.
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.recordFilesTouched(chat.id, [{ path: "src/app.ts", additions: 7, deletions: 1 }])
    await store.recordFilesTouched(chat.id, [{ path: "src/app.ts", baseBlob: "dated-later" }])

    expect(store.requireChat(chat.id).touchedFiles)
      .toEqual([{ path: "src/app.ts", baseBlob: "dated-later", additions: 7, deletions: 1 }])
  })

  test("re-recording the same file with the same base writes nothing", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.recordFilesTouched(chat.id, [{ path: "src/app.ts", baseBlob: "blob-first" }])
    const afterFirst = await Bun.file(join(dataDir, "chats.jsonl")).text()
    await store.recordFilesTouched(chat.id, [{ path: "src/app.ts", baseBlob: "blob-first" }])

    // The common case — a chat iterating on the same handful of files, turn
    // after turn — must not grow the log with a repeat of what it already says.
    expect(await Bun.file(join(dataDir, "chats.jsonl")).text()).toBe(afterFirst)
  })

  test("a fork inherits lastTurnEndedAt, so it keeps the conversation's recency", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const source = await store.createChat(project.id)
    await store.setChatProvider(source.id, "claude")
    await store.setSessionToken(source.id, "session-1")
    await store.appendMessage(source.id, entry("user_prompt", source.createdAt + 1, { content: "edit files" }))
    await store.recordTurnFinished(source.id)
    const sourceTurnEndedAt = store.requireChat(source.id).lastTurnEndedAt
    expect(sourceTurnEndedAt).toBeNumber()

    const forked = await store.forkChat(source.id)
    expect(forked.lastTurnEndedAt).toBe(sourceTurnEndedAt!)
    // A fork has no turn events of its own, so the timestamp has to ride on
    // chat_created to survive a replay of the log.
    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(forked.id).lastTurnEndedAt).toBe(sourceTurnEndedAt!)
    // The fork itself hasn't run a turn — only the timestamp is inherited.
    expect(reloaded.requireChat(forked.id).lastTurnOutcome).toBeNull()
  })

  test("reopening a removed project restores its existing chats", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.removeProject(project.id)
    expect(store.getProject(project.id)).toBeNull()

    const reopened = await store.openProject("/tmp/project")

    expect(reopened.id).toBe(project.id)
    expect(store.listChatsByProject(reopened.id).map((entry) => entry.id)).toEqual([chat.id])
  })

  test("archives chats without deleting their transcript", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", chat.createdAt + 1, { content: "keep this" }))

    await store.archiveChat(chat.id)

    expect(store.getChat(chat.id)?.archivedAt).toBeNumber()
    expect(store.listChatsByProject(project.id)).toEqual([])
    expect(store.getMessages(chat.id).map((message) => message.kind)).toEqual(["user_prompt"])

    await store.unarchiveChat(chat.id)

    expect(store.getChat(chat.id)?.archivedAt).toBeUndefined()
    expect(store.listChatsByProject(project.id).map((entry) => entry.id)).toEqual([chat.id])
  })

  test("rehydrates message metadata from transcripts after a restart without compaction", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 1_000, { content: "  Fix the   login bug  " }))
    await store.appendMessage(chat.id, entry("assistant_text", 2_000, { text: "Done, the fix is in auth.ts" }))

    // No compact() — a restart between compactions must not lose transcript-derived metadata.
    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    const reloadedChat = reloaded.getChat(chat.id)
    expect(reloadedChat?.hasMessages).toBe(true)
    expect(reloadedChat?.lastMessageAt).toBe(1_000)
    expect(reloadedChat?.lastUserMessagePreview).toBe("Fix the login bug")
    expect(reloadedChat?.lastAgentMessagePreview).toBe("Done, the fix is in auth.ts")
  })

  test("counts turns, and survives the replay that would double-count them", async () => {
    // The hazard this guards: the count accumulates, so it lives on the *store*
    // event rather than in `applyMessageMetadata`, which boot re-runs over each
    // transcript tail on top of an already-loaded snapshot. Put it there and a
    // restart inflates every chat.
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    expect(store.getChat(chat.id)?.turnCount).toBeUndefined()

    await store.recordTurnStarted(chat.id)
    await store.appendMessage(chat.id, entry("user_prompt", 1_000, { content: "first" }))
    await store.recordTurnStarted(chat.id)
    await store.appendMessage(chat.id, entry("user_prompt", 2_000, { content: "second" }))

    expect(store.getChat(chat.id)?.turnCount).toBe(2)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getChat(chat.id)?.turnCount).toBe(2)
  })

  test("a fork inherits the turns behind the conversation it copied", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const source = await store.createChat(project.id)
    await store.setChatProvider(source.id, "claude")
    await store.setSessionToken(source.id, "session-1")
    await store.recordTurnStarted(source.id)
    await store.appendMessage(source.id, entry("user_prompt", 1_000, { content: "first" }))
    await store.recordTurnStarted(source.id)

    const fork = await store.forkChat(source.id)

    // Starting from zero would read as a fresh chat, which a fork of a
    // two-turn conversation is not.
    expect(store.getChat(fork.id)?.turnCount).toBe(2)
  })

  test("strips markdown while the message still has lines to strip it by", async () => {
    // Headings, list markers and quotes are anchored to the start of a line,
    // and this is the last place the lines exist — the preview is one string
    // by the time the client sees it. Getting this wrong shows up as `##` and
    // `- ` stranded mid-sentence in the sidebar's hover card.
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 1_000, {
      content: "## Plan\n\n- rewrite the **router**\n- drop `parseTranscript`\n\n> and ship it",
    }))

    expect(store.getChat(chat.id)?.lastUserMessagePreview)
      .toBe("Plan rewrite the router drop parseTranscript and ship it")
  })

  test("advances each preview independently, so a new prompt keeps the old reply", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 1_000, { content: "first ask" }))
    await store.appendMessage(chat.id, entry("assistant_text", 2_000, { text: "first answer" }))
    await store.appendMessage(chat.id, entry("user_prompt", 3_000, { content: "second ask" }))

    const updated = store.getChat(chat.id)

    // The card uses the timestamps to notice the reply belongs to the previous
    // turn and hides it; the store's job is only to keep them apart.
    expect(updated?.lastUserMessagePreview).toBe("second ask")
    expect(updated?.lastAgentMessagePreview).toBe("first answer")
    expect(updated?.lastAgentMessagePreviewAt).toBe(2_000)
  })

  test("marks chats done until a new turn starts, surviving reads and reloads", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.recordTurnFinished(chat.id)
    await store.setChatDoneState(chat.id, true)
    expect(store.getChat(chat.id)?.doneAt).toBeNumber()

    // Reading only clears unread; done state is untouched.
    await store.setChatReadState(chat.id, false)
    expect(store.getChat(chat.id)?.unread).toBe(false)
    expect(store.getChat(chat.id)?.doneAt).toBeNumber()

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getChat(chat.id)?.doneAt).toBeNumber()

    // A new turn means the user re-engaged, clearing the done state.
    await reloaded.recordTurnStarted(chat.id)
    expect(reloaded.getChat(chat.id)?.doneAt).toBeUndefined()

    await reloaded.setChatDoneState(chat.id, true)
    await reloaded.setChatDoneState(chat.id, false)
    expect(reloaded.getChat(chat.id)?.doneAt).toBeUndefined()
  })
})

describe("on-demand tool payloads", () => {
  test("returns the requested entries with their payloads, minus debugRaw", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(dataDir, "payloads")
    const chat = await store.createChat(project.id)

    await store.appendMessage(chat.id, {
      _id: "call-1",
      createdAt: 1,
      kind: "tool_call",
      debugRaw: "{}",
      tool: { kind: "tool", toolKind: "write_file", toolName: "Write", toolId: "t1", input: { filePath: "a.ts", content: "body" } },
    } as unknown as TranscriptEntry)
    await store.appendMessage(chat.id, {
      _id: "result-1",
      createdAt: 2,
      kind: "tool_result",
      toolId: "t1",
      content: "written",
    } as unknown as TranscriptEntry)

    const found = store.getEntriesById(chat.id, ["call-1", "result-1"])

    expect(found).toHaveLength(2)
    // The payloads the wire dropped are exactly what this exists to return.
    expect((found[0] as unknown as { tool: { input: { content?: string } } }).tool.input.content).toBe("body")
    expect((found[1] as unknown as { content?: unknown }).content).toBe("written")
    expect(found[0]?.debugRaw).toBeUndefined()
  })

  test("silently omits ids that are not in the transcript", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(dataDir, "payloads")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("assistant_text", 1, { text: "hi" }))

    expect(store.getEntriesById(chat.id, ["nope"])).toEqual([])
    expect(store.getEntriesById(chat.id, [])).toEqual([])
  })
})

describe("stale empty chat pruning", () => {
  test("keeps a cached chat that actually has messages", async () => {
    // The prune sweep only deletes chats it believes are empty. `hasMessages`
    // can be stale — it is metadata, repaired by peeking at the transcript —
    // so a chat with entries must survive, transcript and all.
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(dataDir, "prune")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 1, { content: "hello" }))

    // Warm the LRU, then mimic the metadata having been lost.
    store.getClientTranscript(chat.id)
    const record = store.getChat(chat.id)!
    record.hasMessages = false
    record.createdAt = Date.now() - 60 * 60 * 1000

    const pruned = await store.pruneStaleEmptyChats({ activeChatIds: new Set(), protectedChatIds: new Set() })

    expect(pruned).not.toContain(chat.id)
    expect(store.getChat(chat.id)).not.toBeNull()
    expect(store.getMessages(chat.id)).toHaveLength(1)
    // And the repair happened rather than merely being skipped.
    expect(store.getChat(chat.id)?.hasMessages).toBe(true)
  })
})
