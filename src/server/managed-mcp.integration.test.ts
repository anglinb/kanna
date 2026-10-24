import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { ClientCommand, ServerEnvelope } from "../shared/protocol"
import type { McpSnapshot } from "../shared/mcp"
import { startIsolatedServer } from "./testing/isolated-server"

test("MCP settings round-trip over the real server without returning credentials", async () => {
  const fixture = await startIsolatedServer()
  const socket = new WebSocket(`ws://127.0.0.1:${fixture.server.port}/ws`)
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (cause: Error) => void }>()
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as ServerEnvelope
    if (message.type !== "ack" && message.type !== "error") return
    if (!message.id) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.type === "ack") request.resolve(message.result)
    else request.reject(new Error("MCP settings command failed."))
  })
  const command = <A>(command: ClientCommand) => new Promise<A>((resolve, reject) => {
    const id = crypto.randomUUID()
    pending.set(id, { resolve: (value) => resolve(value as A), reject })
    socket.send(JSON.stringify({ v: 1, type: "command", id, command }))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error("WebSocket could not open")), { once: true })
    })
    expect((await command<McpSnapshot>({ type: "mcp.read" })).servers).toEqual([])
    const created = await command<McpSnapshot>({ type: "mcp.save", server: {
      name: "shared", transport: "http", url: "https://example.com/mcp", providers: ["claude"], headers: { Authorization: "Bearer integration-secret" },
    } })
    expect(created.servers[0]?.headerKeys).toEqual(["Authorization"])
    expect(JSON.stringify(created)).not.toContain("integration-secret")
    const entry = created.servers[0]!
    await command({ type: "mcp.save", server: { id: entry.id, name: entry.name, transport: "http", url: entry.url, providers: ["claude", "codex"] } })
    const reread = await command<McpSnapshot>({ type: "mcp.read" })
    expect(reread.servers[0]?.providers).toEqual(["claude", "codex"])
    const stored = JSON.parse(await readFile(path.join(fixture.dataDir, "mcp.json"), "utf8"))
    expect(stored.servers[0].headers.Authorization).toBe("Bearer integration-secret")
    await command({ type: "mcp.remove", id: entry.id })
    expect((await command<McpSnapshot>({ type: "mcp.read" })).servers).toEqual([])
  } finally {
    socket.close()
    await fixture.close()
  }
}, 30_000)
