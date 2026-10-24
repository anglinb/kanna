import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js"
import { Effect, Exit, Scope, Stream } from "effect"
import { runKanna, runKannaSync } from "./effect/bridge"
import type { ProcessSpawner, SpawnedProcess } from "./platform/process-spawner"

/** MCP framing over the injected machine's process service, including on hosted bindings. */
export class McpStdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private scope: Scope.Closeable | null = null
  private child: SpawnedProcess | null = null
  private readonly buffer = new ReadBuffer()
  private closed = false

  constructor(private readonly spawner: ProcessSpawner["Service"], private readonly options: {
    command: string; args?: string[]; env: Record<string, string | undefined>; cwd: string
  }) {}

  private didClose() {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }

  async start() {
    if (this.scope || this.closed) throw new Error("MCP transport already started or closed.")
    const scope = await runKanna(Scope.make())
    this.scope = scope
    try {
      this.child = await runKanna(this.spawner.spawn([this.options.command, ...(this.options.args ?? [])], {
        cwd: this.options.cwd, env: this.options.env, stdin: "pipe", stdout: "pipe", stderr: "ignore",
      }).pipe(Scope.provide(scope)))
      runKannaSync(Stream.runForEach(this.child.stdout, (chunk) => Effect.sync(() => {
        try {
          this.buffer.append(Buffer.from(chunk))
          for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage()) this.onmessage?.(message)
        } catch { this.onerror?.(new Error("Invalid JSON-RPC received from the local MCP server.")) }
      })).pipe(
        Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", () => Effect.sync(() => this.onerror?.(new Error("Local MCP output was interrupted.")))),
        Effect.ensuring(Effect.sync(() => this.didClose())),
        Effect.forkIn(scope, { startImmediately: true }),
      ))
    } catch (cause) {
      await this.close()
      throw cause
    }
  }

  async send(message: JSONRPCMessage) {
    if (!this.child || this.closed) throw new Error("Local MCP server is not connected.")
    await runKanna(this.child.writeStdin(serializeMessage(message)))
  }

  async close() {
    const scope = this.scope
    this.scope = null
    if (scope) await runKanna(Scope.close(scope, Exit.void))
    if (this.child) {
      const child = this.child
      await runKanna(child.exited.pipe(
        Effect.timeout("1 second"),
        Effect.catchTag("TimeoutError", () => child.kill("SIGKILL").pipe(Effect.andThen(child.exited))),
        Effect.asVoid,
      ))
    }
    this.buffer.clear()
    this.didClose()
  }
}
