import path from "node:path"
import { Machine } from "./platform/machine"
import { Context, Effect, FileSystem, Layer, Schema, Semaphore } from "effect"
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js"
import type { ManagedMcpServer, McpServerInput } from "../shared/mcp"
import { McpServerInputSchema } from "../shared/mcp-schema"

export class McpError extends Schema.TaggedError<McpError>()("@kanna/server/McpError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface McpCredentials {
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  expiresAt?: number
  redirectUrl?: string
  discovery?: OAuthDiscoveryState
}

/** Provider enablement can change without invalidating an upstream login. */
export const mcpAuthIdentity = (server: ManagedMcpServer) => JSON.stringify({
  transport: server.transport, url: server.url, command: server.command, args: server.args,
  env: server.env, headers: server.headers, clientId: server.clientId, clientSecret: server.clientSecret,
})

const ConfigFile = Schema.Struct({ version: Schema.Literal(1), servers: Schema.Array(McpServerInputSchema) })
const CredentialsFile = Schema.Struct({ version: Schema.Literal(1), servers: Schema.Record(Schema.String, Schema.Unknown) })
const error = (operation: string) => () => new McpError({ operation, message: `Unable to ${operation} MCP storage.` })

export class McpStore extends Context.Service<McpStore, {
  readonly filePath: string
  readonly servers: Effect.Effect<ManagedMcpServer[]>
  readonly revision: Effect.Effect<number>
  readonly save: (input: McpServerInput) => Effect.Effect<ManagedMcpServer, McpError>
  readonly saveMany: (inputs: McpServerInput[]) => Effect.Effect<ManagedMcpServer[], McpError>
  readonly remove: (id: string) => Effect.Effect<void, McpError>
  readonly credentials: (id: string) => Effect.Effect<McpCredentials>
  readonly credentialEpoch: (id: string) => Effect.Effect<number>
  readonly clearCredentials: (id: string) => Effect.Effect<void, McpError>
  readonly updateCredentials: (id: string, update: (value: McpCredentials) => McpCredentials, expected?: { identity: string; epoch: number }) => Effect.Effect<void, McpError>
}>()("@kanna/server/McpStore") {
  static readonly layer = (dataDir: string) => Layer.effect(this, makeMcpStore(dataDir))
}

export function validateMcpServer(input: unknown, homeDirectory?: string): ManagedMcpServer {
  const decoded = Schema.decodeUnknownOption(McpServerInputSchema)(input)
  if (decoded._tag === "None") throw new Error("Invalid MCP definition. Check the connection type, arguments, and provider names.")
  const parsed = decoded.value
  const { args, ...fields } = parsed
  let projectPath = parsed.projectPath?.trim() || undefined
  if (projectPath?.startsWith("~")) {
    if (!homeDirectory || !/^~(?:\/|$)/.test(projectPath)) throw new Error("Use an absolute project folder.")
    projectPath = projectPath.replace(/^~/, homeDirectory)
  }
  if (projectPath && !path.isAbsolute(projectPath)) throw new Error("Use an absolute project folder.")
  const name = parsed.name.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || name === "kanna") {
    throw new Error("Use a server name with letters, numbers, hyphens, or underscores. The name kanna is reserved.")
  }
  if (parsed.transport === "stdio" && !parsed.command?.trim()) throw new Error("A local server needs a command.")
  if (parsed.transport !== "stdio") {
    if (parsed.url?.includes("${")) throw new Error("Use a complete server URL. Environment references belong in headers or local command settings.")
    const url = new URL(parsed.url ?? "")
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("A remote server needs an HTTP or HTTPS URL without embedded credentials.")
    }
  }
  return {
    ...fields,
    ...(args ? { args: [...args] } : {}),
    id: parsed.id ?? crypto.randomUUID(),
    name,
    providers: [...new Set(parsed.providers)],
    projectPath: projectPath ? path.normalize(projectPath) : undefined,
  }
}

/** One writer for config and refresh-token rotation; files are private and replaced atomically. */
export const makeMcpStore = Effect.fn("McpStore.make")(function* (dataDir: string) {
  const fs = yield* FileSystem.FileSystem
  const machine = yield* Machine
  const filePath = path.join(dataDir, "mcp.json")
  const credentialsPath = path.join(dataDir, "mcp-credentials.json")
  const lock = yield* Semaphore.make(1)
  const epochs = new Map<string, number>()
  let revision = 0

  const read = <A>(file: string, schema: Schema.Codec<A>, fallback: A) => fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(fallback)),
    Effect.mapError(error("read")),
  )
  const config = yield* read(filePath, ConfigFile, { version: 1, servers: [] })
  let servers = yield* Effect.try({
    try: () => config.servers.map((input) => validateMcpServer(input, machine.homeDirectory)),
    catch: error("read"),
  })
  const credentialsFile = yield* read(credentialsPath, CredentialsFile, { version: 1, servers: {} })
  let credentials = Object.fromEntries(Object.entries(credentialsFile.servers).filter(([, value]) => value && typeof value === "object" && !Array.isArray(value))) as Record<string, McpCredentials>
  const credentialsFor = (id: string): McpCredentials => Object.hasOwn(credentials, id) ? credentials[id]! : {}

  const write = (file: string, value: unknown) => Effect.gen(function* () {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`
    yield* fs.makeDirectory(dataDir, { recursive: true })
    yield* fs.writeFileString(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    yield* fs.rename(temporary, file).pipe(Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)))
  }).pipe(Effect.mapError(error("write")))

  const updateCredentials = (id: string, update: (value: McpCredentials) => McpCredentials, expected?: { identity: string; epoch: number }) => lock.withPermits(1)(Effect.gen(function* () {
    const server = servers.find((entry) => entry.id === id)
    if (!server || (expected && (mcpAuthIdentity(server) !== expected.identity || (epochs.get(id) ?? 0) !== expected.epoch))) {
      return yield* new McpError({ operation: "authorize", message: "MCP configuration or sign-in changed. Connect again." })
    }
    const next = { ...credentials, [id]: update(credentialsFor(id)) }
    yield* write(credentialsPath, { version: 1, servers: next })
    credentials = next
  }))

  const saveMany = Effect.fn("McpStore.saveMany")(function* (inputs: McpServerInput[]) {
    const validated = yield* Effect.try({
      try: () => inputs.map((input) => validateMcpServer(input, machine.homeDirectory)),
      catch: (cause) => new McpError({ operation: "validate", message: cause instanceof Error ? cause.message : "Invalid MCP configuration." }),
    })
    return yield* lock.withPermits(1)(Effect.gen(function* () {
      const saved: ManagedMcpServer[] = []
      let next = [...servers]
      const nextCredentials = { ...credentials }
      const invalidated: string[] = []
      for (const server of validated) {
        const previous = next.find((entry) => entry.id === server.id)
        if (next.some((entry) => entry.id !== server.id && entry.name === server.name && entry.projectPath === server.projectPath)) {
          return yield* new McpError({ operation: "save", message: "A server with this name already exists in this scope." })
        }
        // Editing ordinary fields never requires sending credentials back to the browser.
        const nextServer = { ...previous, ...server }
        if (previous && (previous.transport !== server.transport || previous.url !== server.url || previous.command !== server.command)) {
          // Moving an entry to another destination must not forward its old secrets.
          if (server.args === undefined) delete nextServer.args
          if (server.env === undefined) delete nextServer.env
          if (server.headers === undefined) delete nextServer.headers
          if (server.clientSecret === undefined) delete nextServer.clientSecret
        }
        next = [...next.filter((entry) => entry.id !== server.id), nextServer]
        if (previous && mcpAuthIdentity(previous) !== mcpAuthIdentity(nextServer)) {
          delete nextCredentials[server.id]
          invalidated.push(server.id)
        }
        saved.push(nextServer)
      }
      if (invalidated.length) yield* write(credentialsPath, { version: 1, servers: nextCredentials })
      yield* write(filePath, { version: 1, servers: next })
      credentials = nextCredentials
      for (const id of invalidated) epochs.set(id, (epochs.get(id) ?? 0) + 1)
      servers = next
      revision++
      return saved
    }))
  })

  const remove = Effect.fn("McpStore.remove")(function* (id: string) {
    yield* lock.withPermits(1)(Effect.gen(function* () {
      const next = servers.filter((server) => server.id !== id)
      const nextCredentials = { ...credentials }
      delete nextCredentials[id]
      yield* write(credentialsPath, { version: 1, servers: nextCredentials })
      yield* write(filePath, { version: 1, servers: next })
      credentials = nextCredentials
      epochs.set(id, (epochs.get(id) ?? 0) + 1)
      servers = next
      revision++
    }))
  })

  return {
    filePath,
    servers: Effect.sync(() => structuredClone(servers)),
    revision: Effect.sync(() => revision),
    save: (input: McpServerInput) => saveMany([input]).pipe(Effect.map((saved) => saved[0]!)),
    saveMany,
    remove,
    credentials: (id: string) => Effect.sync(() => structuredClone(credentialsFor(id))),
    credentialEpoch: (id: string) => Effect.sync(() => epochs.get(id) ?? 0),
    clearCredentials: (id: string) => lock.withPermits(1)(Effect.gen(function* () {
      const next = { ...credentials }
      delete next[id]
      yield* write(credentialsPath, { version: 1, servers: next })
      credentials = next
      epochs.set(id, (epochs.get(id) ?? 0) + 1)
    })),
    updateCredentials,
  }
})
