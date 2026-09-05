import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"
import type { ControlDeps } from "./api/control"
import { createClaudeKannaMcpServer } from "./kanna-mcp-claude"
import { createLocalKannaControl } from "./kanna-control-local"
import { KANNA_TOOLS } from "./kanna-tools"

async function withDeps<T>(run: (deps: ControlDeps, store: EventStore, dataDir: string) => Promise<T>) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-claude-mcp-"))
  const store = new EventStore(dataDir)
  await store.initialize()
  const deps: ControlDeps = {
    store,
    appSettings: { getSnapshot: () => ({ transcript: { windowAssistantMessages: 50 } }) as never },
    agent: {
      getActiveStatuses: () => new Map(),
      getDrainingChatIds: () => new Set(),
      async send(command, options) {
        const chatId =
          command.chatId ?? (await store.createChat(command.projectId!, { agentOrigin: options?.agentOrigin })).id
        return { chatId }
      },
      async cancel() {},
      async closeChat() {},
    },
    broadcast: () => {},
    analytics: { track: () => {} },
  }
  try {
    return await run(deps, store, dataDir)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
}

describe("createClaudeKannaMcpServer", () => {
  test("builds an SDK server the Agent SDK accepts", async () => {
    await withDeps(async (deps) => {
      const server = createClaudeKannaMcpServer(deps, "caller-chat")
      expect(server.type).toBe("sdk")
      expect(server.name).toBe("kanna")
    })
  })

  test("the Zod shapes every tool declares are valid SDK tool schemas", async () => {
    // The SDK rejects a plain JSON Schema outright, so this is what catches a
    // tool whose shape stopped being Zod.
    await withDeps(async (deps) => {
      expect(() => createClaudeKannaMcpServer(deps, "caller-chat")).not.toThrow()
      expect(KANNA_TOOLS.length).toBeGreaterThan(0)
    })
  })
})

describe("createLocalKannaControl", () => {
  test("dispatches each tool onto the matching control call", async () => {
    await withDeps(async (deps, store, dataDir) => {
      const caller = { chatId: "caller" }
      const ctx = createLocalKannaControl(deps, caller)

      const added = (await ctx.call("add_project", { localPath: path.join(dataDir, "proj") })) as {
        project: { id: string }
        created: boolean
      }
      expect(added.created).toBe(true)

      const listed = (await ctx.call("list_projects", {})) as { projects: unknown[] }
      expect(listed.projects).toHaveLength(1)

      const created = (await ctx.call("create_chat", { projectId: added.project.id })) as {
        chat: { id: string; createdByChatId: string | null }
      }
      expect(created.chat.createdByChatId).toBe("caller")

      const chats = (await ctx.call("list_chats", { projectId: added.project.id })) as { total: number }
      expect(chats.total).toBe(1)

      const read = (await ctx.call("get_chat", { chatId: created.chat.id })) as { chat: { id: string } }
      expect(read.chat.id).toBe(created.chat.id)

      const cancelled = (await ctx.call("cancel_chat", { chatId: created.chat.id })) as { chatId: string }
      expect(cancelled.chatId).toBe(created.chat.id)

      expect(store.getChat(created.chat.id)?.agentOrigin).toEqual(caller)
    })
  })

  test("a missing required argument is refused before the store is touched", async () => {
    await withDeps(async (deps) => {
      const ctx = createLocalKannaControl(deps, { chatId: "caller" })
      await expect(ctx.call("get_chat", {})).rejects.toThrow(/Missing or empty "chatId"/)
      await expect(ctx.call("add_project", { localPath: "   " })).rejects.toThrow(/Missing or empty "localPath"/)
    })
  })

  test("a wrongly typed optional argument is refused rather than coerced", async () => {
    await withDeps(async (deps) => {
      const ctx = createLocalKannaControl(deps, { chatId: "caller" })
      await expect(ctx.call("list_chats", { limit: "5" })).rejects.toThrow(/"limit" must be a number/)
      await expect(ctx.call("list_chats", { includeArchived: "yes" })).rejects.toThrow(/must be a boolean/)
    })
  })
})

describe("reload through the tools", () => {
  test("re-reads the store and reports the counts", async () => {
    await withDeps(async (deps, store, dataDir) => {
      const ctx = createLocalKannaControl(deps, { chatId: "caller" })
      const project = await store.openProject(path.join(dataDir, "proj"))

      const other = new EventStore(dataDir)
      await other.initialize()
      const added = await other.createChat(project.id)

      const result = (await ctx.call("reload", {})) as { chats: number; droppedChatIds: string[] }

      expect(store.getChat(added.id)).not.toBeNull()
      expect(result.chats).toBe(1)
      expect(result.droppedChatIds).toEqual([])
    })
  })

  test("a bad data dir surfaces as an error the model can read, not a wipe", async () => {
    await withDeps(async (deps, store, dataDir) => {
      const ctx = createLocalKannaControl(deps, { chatId: "caller" })
      const project = await store.openProject(path.join(dataDir, "proj"))
      const chat = await store.createChat(project.id)
      await store.compact()

      await Bun.write(path.join(dataDir, "snapshot.json"), "{ not json")

      await expect(ctx.call("reload", {})).rejects.toThrow(/Reload refused/)
      expect(store.getChat(chat.id)).not.toBeNull()
    })
  })
})
