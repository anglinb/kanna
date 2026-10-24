import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Cause, Effect, Queue, Result, Stream } from "effect"
import type { AgentProvider } from "../shared/types"
import { AgentCoordinator } from "./agent"
import { AccountError, type ProviderAccounts } from "./provider-accounts"
import { EventStore } from "./event-store"
import { runTest } from "./effect/testing"
import { testPlatformContext } from "./platform/testing"
import type { HarnessEvent } from "./harness-types"
import type { QuickResponse } from "./quick-response"
import { timestamped } from "./transcript"

test("chats, queued messages and forks retain their account when defaults change", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kanna-agent-accounts-"))
  let defaultAccount = "work"
  const starts: Array<string | undefined> = []
  const streams: Array<Queue.Queue<HarnessEvent, Cause.Done>> = []
  const accounts = {
    runtime: (provider: AgentProvider, id = defaultAccount) => id === "missing" ? Effect.fail(new AccountError({ message: "Account not found." })) : Effect.succeed({
      accountId: id,
      ...(id.startsWith("existing-") ? {} : { environment: { CLAUDE_CONFIG_DIR: `/profiles/${id}` } }),
    }),
  } as unknown as ProviderAccounts["Service"]
  const store = await runTest(EventStore.make({ dataDir }))
  const project = await runTest(store.openProject(dataDir))
  const agent = new AgentCoordinator({
    platform: testPlatformContext, store, providerAccounts: accounts, onStateChange: () => {},
    quickResponse: { generateStructuredWithDiagnostics: () => Effect.succeed({ value: "Account chat", failures: [] }) } as unknown as QuickResponse["Service"],
    checkSessionArtifact: () => "present",
    startClaudeSession: async ({ environment }) => {
      starts.push(environment?.CLAUDE_CONFIG_DIR)
      const events = Effect.runSync(Queue.unbounded<HarnessEvent, Cause.Done>())
      streams.push(events)
      return {
        provider: "claude", stream: Stream.toAsyncIterable(Stream.fromQueue(events)),
        interrupt: async () => {}, close: () => { Queue.endUnsafe(events) },
        sendPrompt: async () => {
          Queue.offerUnsafe(events, { type: "session_token", sessionToken: `session-${starts.length}` })
          Queue.offerUnsafe(events, { type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }) })
        },
        setModel: async () => {}, setPermissionMode: async () => {},
      }
    },
  })
  const idle = async (chatId: string) => {
    for (let attempt = 0; attempt < 200; attempt++) { if (!agent.isBusy(chatId)) return; await Bun.sleep(5) }
    throw new Error("Chat did not finish")
  }
  try {
    const sent = await runTest(agent.sendEffect({ type: "chat.send", projectId: project.id, provider: "claude", accountId: "work", content: "first" }))
    await idle(sent.chatId)
    expect(store.getChat(sent.chatId)?.accountIds?.claude).toBe("work")
    defaultAccount = "personal"
    await runTest(agent.sendEffect({ type: "chat.send", chatId: sent.chatId, provider: "claude", content: "second" }))
    await idle(sent.chatId)
    const mismatch = await runTest(Effect.result(agent.enqueueEffect({ type: "message.enqueue", chatId: sent.chatId, provider: "claude", accountId: "personal", content: "wrong account" })))
    expect(Result.isFailure(mismatch)).toBe(true)
    expect(store.getQueuedMessages(sent.chatId)).toHaveLength(0)
    expect(starts).toEqual(["/profiles/work"])

    const fork = await runTest(agent.forkChatEffect(sent.chatId))
    expect(store.getChat(fork.chatId)?.accountIds?.claude).toBe("work")
    const fresh = await runTest(agent.sendEffect({ type: "chat.send", projectId: project.id, provider: "claude", content: "new default" }))
    await idle(fresh.chatId)
    expect(store.getChat(fresh.chatId)?.accountIds?.claude).toBe("personal")

    // An old conversation with no account field must retain the old CLI login.
    const old = await runTest(store.createChat(project.id))
    await runTest(store.setChatProvider(old.id, "claude"))
    await runTest(store.appendMessage(old.id, timestamped({ kind: "user_prompt", content: "before accounts", attachments: [] })))
    await runTest(agent.sendEffect({ type: "chat.send", chatId: old.id, provider: "claude", content: "resume" }))
    await idle(old.id)
    expect(store.getChat(old.id)?.accountIds?.claude).toBe("existing-claude")
    expect(starts.at(-1)).toBeUndefined()

    const child = await runTest(store.createChat(project.id, { parentChatId: sent.chatId }))
    await runTest(agent.sendEffect({ type: "chat.send", chatId: child.id, provider: "claude", content: "inherited" }))
    await idle(child.id)
    expect(store.getChat(child.id)?.accountIds?.claude).toBe("work")

    await agent.closeChat(sent.chatId)
    const reloaded = await runTest(EventStore.make({ dataDir }))
    expect(reloaded.getChat(sent.chatId)?.accountIds?.claude).toBe("work")
    expect(reloaded.getChat(fork.chatId)?.accountIds?.claude).toBe("work")
    const removed = await runTest(Effect.result(agent.sendEffect({ type: "chat.send", projectId: project.id, provider: "claude", accountId: "missing", content: "fail closed" })))
    expect(Result.isFailure(removed)).toBe(true)
  } finally {
    await agent.dispose()
    for (const stream of streams) Queue.endUnsafe(stream)
    rmSync(dataDir, { recursive: true, force: true })
  }
})
