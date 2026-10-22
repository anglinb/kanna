import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { AgentCoordinator } from "./agent"
import { CodexAppServerManager } from "./codex-app-server"
import { openEventStore } from "./event-store-bridge"

class Child extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  constructor() {
    super()
    this.stdin.on("data", chunk => {
      const message = JSON.parse(chunk.toString())
      if (message.method === "initialize" || message.method === "thread/start") {
        this.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: "thread" } } })}\n`)
      }
    })
  }
  kill() {
    this.killed = true
    this.stdout.end()
    this.stderr.end()
    this.stdin.end()
    this.emit("close", 0)
    return true
  }
}

test("closing a chat stops Codex and rejects pending requests", async () => {
  const child = new Child()
  const manager = new CodexAppServerManager({ spawnProcess: () => child as never })
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-codex-lifecycle-"))
  try {
    await manager.startSession({ chatId: "chat", cwd: "/tmp", model: "gpt-5.5", sessionToken: null })
    child.stderr.write(`${"diagnostic\n".repeat(10000)}${"x".repeat(20000)}\n`)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(manager.getResourceCounts().codexStderrChars).toBeLessThanOrEqual(8192)
    const result = manager.readAccountRateLimits("/tmp").then(() => "resolved", error => error.message)
    const agent = new AgentCoordinator({ store: await openEventStore(dataDir), codexManager: manager, onStateChange: () => {} })
    await agent.closeChat("chat")
    expect(await result).toBe("Codex session closed")
    expect(child.killed).toBe(true)
    expect(manager.getResourceCounts()).toEqual({ codexSessions: 0, codexPendingRequests: 0, codexStderrChars: 0 })
  } finally {
    manager.stopAll()
    await rm(dataDir, { recursive: true, force: true })
  }
})
