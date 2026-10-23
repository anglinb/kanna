import path from "node:path"
import { parse as parseToml } from "smol-toml"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import type { TSchema } from "typebox"
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { auth, extractWWWAuthenticateParams, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import { OAuthTokensSchema, OAuthClientInformationFullSchema } from "@modelcontextprotocol/sdk/shared/auth.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  ListToolsRequestSchema, CallToolRequestSchema, CallToolResultSchema, CancelledNotificationSchema, ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Context, Effect, FileSystem, Layer, Semaphore, Stream } from "effect"
import {
  MCP_PROVIDERS, mcpBridgeName, type ManagedMcpServer, type McpBridgeServers, type McpConnectResult,
  type McpProvider, type McpServerInput, type McpServerSummary, type McpSnapshot,
} from "../shared/mcp"
import { McpError, McpStore, mcpAuthIdentity, validateMcpServer } from "./mcp-store"
import { runKanna } from "./effect/bridge"
import { HttpHost } from "./platform/http-host"
import { Machine } from "./platform/machine"
import { ProcessSpawner } from "./platform/process-spawner"
import { McpStdioTransport } from "./mcp-stdio"

type Status = Pick<McpServerSummary, "status" | "toolCount" | "message">
interface Route { id: string; provider: McpProvider; cwd: string; chatId: string; token: string; fingerprint: string; generation: number }
interface PendingAuth { state: string; verifier?: string; url?: string; expires: number; fingerprint: string; epoch: number }
interface Connection { client: Client; fingerprint: string; id: string; closed?: boolean }

export class ManagedMcp extends Context.Service<ManagedMcp, {
  readonly snapshot: Effect.Effect<McpSnapshot>
  readonly save: (input: McpServerInput) => Effect.Effect<McpSnapshot, McpError>
  readonly remove: (id: string) => Effect.Effect<McpSnapshot, McpError>
  readonly connect: (id: string) => Effect.Effect<McpConnectResult, McpError>
  readonly disconnect: (id: string) => Effect.Effect<McpSnapshot, McpError>
  readonly importConfig: (content: string, providers: McpProvider[], projectPath?: string) => Effect.Effect<McpSnapshot, McpError>
  readonly importProvider: (provider: "claude" | "codex" | "cursor", projectPath?: string) => Effect.Effect<McpSnapshot, McpError>
  readonly endpoints: (provider: McpProvider, cwd: string, chatId: string) => Effect.Effect<McpBridgeServers>
  readonly releaseChat: (chatId: string) => Effect.Effect<void>
  readonly piTools: (cwd: string, chatId: string) => Effect.Effect<ToolDefinition[], McpError>
}>()("@kanna/server/ManagedMcp") {
  static readonly layer = (dataDir: string) => Layer.effect(this, makeManagedMcp).pipe(Layer.provide(McpStore.layer(dataDir)))
}

const fingerprint = (server: ManagedMcpServer) => JSON.stringify(server)
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function expandMcpVariable(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
    const replacement = env[name] ?? fallback
    if (replacement === undefined) throw new Error(`Set ${name} in Kanna's environment before connecting.`)
    return replacement
  })
}

/** Import definitions, never provider token caches. Kanna is its own OAuth client. */
export function parseMcpImport(content: string, providers: McpProvider[], projectPath?: string): McpServerInput[] {
  let parsed: Record<string, unknown>
  try { parsed = record(JSON.parse(content)) } catch { parsed = record(parseToml(content)) }
  const entries = record(parsed.mcpServers ?? parsed.mcp_servers)
  if (Object.keys(entries).length === 0) throw new Error("Paste a configuration containing mcpServers (JSON) or mcp_servers (TOML).")
  return Object.entries(entries).map(([name, value]) => {
    const entry = record(value)
    // Unsupported auth helpers must not silently become unauthenticated imports.
    const supported = new Set(["type", "transport", "command", "args", "env", "url", "headers", "http_headers", "enabled", "disabled"])
    const unsupported = Object.keys(entry).filter((key) => !supported.has(key))
    if (unsupported.length) throw new Error(`${name} uses unsupported options: ${unsupported.join(", ")}. Convert these options before importing.`)
    return {
      name,
      transport: entry.type === "sse" || entry.transport === "sse" ? "sse" : entry.url ? "http" : "stdio",
      command: entry.command as string | undefined,
      args: entry.args as string[] | undefined,
      env: entry.env as Record<string, string> | undefined,
      url: entry.url as string | undefined,
      headers: (entry.headers ?? entry.http_headers) as Record<string, string> | undefined,
      providers: entry.enabled === false || entry.disabled === true ? [] : providers,
      projectPath,
    }
  })
}

/** Owns credentials and upstream clients; harnesses only receive authenticated loopback URLs. */
export const makeManagedMcp = Effect.gen(function* () {
  const store = yield* McpStore
  const fs = yield* FileSystem.FileSystem
  const machine = yield* Machine
  const http = yield* HttpHost
  const spawner = yield* ProcessSpawner
  const states = new Map<string, Status>()
  const pending = new Map<string, PendingAuth>()
  const routes = new Map<string, Route>()
  const connections = new Map<string, Connection>()
  const connecting = new Map<Client, { id: string; key: string; active: boolean }>()
  const generations = new Map<string, number>()
  const connectionLocks = new Map<string, Semaphore.Semaphore>()
  const oauthLocks = new Map<string, Semaphore.Semaphore>()
  const downstream = new Set<Server>()
  const activeRequests = new Map<string, AbortController>()
  const closing = new AbortController()
  let origin = ""
  const oauthFetch: FetchLike = (input, init) => fetch(input, {
    ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), closing.signal, AbortSignal.timeout(30_000)]),
  })

  const lookup = (id: string) => store.servers.pipe(Effect.flatMap((servers) => {
    const server = servers.find((entry) => entry.id === id)
    return server ? Effect.succeed(server) : Effect.fail(new McpError({ operation: "lookup", message: "MCP server no longer exists." }))
  }))
  const lockFor = (locks: Map<string, Semaphore.Semaphore>, key: string) => Effect.gen(function* () {
    let lock = locks.get(key)
    if (!lock) { lock = yield* Semaphore.make(1); locks.set(key, lock) }
    return lock
  })
  const closeClient = (client: Client) => Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
  const invalidate = (id: string) => Effect.gen(function* () {
    pending.delete(id)
    states.delete(id)
    for (const [key, connection] of connections) {
      if (connection.id === id) { connections.delete(key); yield* closeClient(connection.client) }
    }
    for (const [client, owner] of connecting) if (owner.id === id) { owner.active = false; yield* closeClient(client) }
    for (const [key, route] of routes) if (route.id === id) routes.delete(key)
  })
  const snapshot = Effect.gen(function* () {
    for (const [id, attempt] of pending) if (attempt.expires < Date.now()) {
      pending.delete(id)
      states.set(id, { status: "error", message: "Sign-in expired. Connect again." })
    }
    return {
      filePath: store.filePath,
      revision: yield* store.revision,
      servers: (yield* store.servers).map((server): McpServerSummary => {
        const { args, env, headers, clientSecret, ...publicFields } = server
        return {
          ...publicFields,
          argumentCount: args?.length ?? 0,
          environmentKeys: Object.keys(env ?? {}),
          headerKeys: Object.keys(headers ?? {}),
          hasClientSecret: Boolean(clientSecret),
          ...(states.get(server.id) ?? { status: "unconnected" }),
        }
      }),
    } satisfies McpSnapshot
  })

  const oauthProvider = (server: ManagedMcpServer, epoch: number, attempt?: PendingAuth): OAuthClientProvider => {
    const update = (change: Parameters<typeof store.updateCredentials>[1]) => runKanna(store.updateCredentials(server.id, change, { identity: mcpAuthIdentity(server), epoch }))
    return ({
    get redirectUrl() { return `${origin}/oauth/callback` },
    get clientMetadata() {
      return {
        client_name: "Kanna", redirect_uris: [`${origin}/oauth/callback`],
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
        token_endpoint_auth_method: server.clientSecret ? "client_secret_post" : "none",
      }
    },
    state: () => attempt?.state ?? crypto.randomUUID(),
    clientInformation: async () => {
      if (server.clientId) return { client_id: server.clientId, ...(server.clientSecret ? { client_secret: server.clientSecret } : {}) }
      const saved = await runKanna(store.credentials(server.id))
      const parsed = OAuthClientInformationFullSchema.safeParse(saved.client)
      return parsed.success ? parsed.data : undefined
    },
    saveClientInformation: (client) => update((value) => ({ ...value, client, redirectUrl: `${origin}/oauth/callback` })),
    tokens: async () => {
      const saved = await runKanna(store.credentials(server.id))
      const parsed = OAuthTokensSchema.safeParse(saved.tokens)
      return parsed.success ? parsed.data : undefined
    },
    saveTokens: (tokens) => update((value) => ({
      ...value,
      tokens: { ...tokens, refresh_token: tokens.refresh_token ?? value.tokens?.refresh_token },
      expiresAt: tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000,
    })),
    redirectToAuthorization: (url) => {
      if (attempt) attempt.url = url.toString()
      states.set(server.id, { status: "needsAuth" })
      throw new UnauthorizedError("Sign in to this server in Settings → MCP servers.")
    },
    saveCodeVerifier: (verifier) => { if (attempt) attempt.verifier = verifier },
    codeVerifier: () => {
      if (!attempt?.verifier) throw new Error("The authorization attempt expired. Sign in again.")
      return attempt.verifier
    },
    discoveryState: () => runKanna(store.credentials(server.id)).then((value) => value.discovery),
    saveDiscoveryState: (discovery) => update((value) => ({ ...value, discovery })),
    invalidateCredentials: (scope) => update((value) => {
      if (scope === "all") return {}
      const next = { ...value }
      if (scope === "client") delete next.client
      if (scope === "tokens") { delete next.tokens; delete next.expiresAt }
      if (scope === "discovery") delete next.discovery
      if (scope === "verifier" && attempt) delete attempt.verifier
      return next
    }),
  }) }

  const connectClient = (server: ManagedMcpServer, key: string, cwd: string, attempt?: PendingAuth) => Effect.gen(function* () {
    const lock = yield* lockFor(connectionLocks, key)
    return yield* lock.withPermits(1)(Effect.gen(function* () {
      const existing = connections.get(key)
      if (existing?.fingerprint === fingerprint(server) && !existing.closed) return existing.client
      if (existing) { connections.delete(key); yield* closeClient(existing.client) }
      const epoch = yield* store.credentialEpoch(server.id)
      const provider = oauthProvider(server, epoch, attempt)
      const environment = yield* Effect.try({
        try: () => ({ ...machine.env.snapshot(), ...Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, expandMcpVariable(value, machine.env.snapshot())])) }),
        catch: (cause) => new McpError({ operation: "environment", message: cause instanceof Error ? cause.message : "Unable to resolve MCP environment." }),
      })
      const resolved = yield* Effect.try({
        try: () => ({
          command: server.command ? expandMcpVariable(server.command, environment) : undefined,
          args: server.args?.map((arg) => expandMcpVariable(arg, environment)),
          headers: Object.fromEntries(Object.entries(server.headers ?? {}).map(([key, value]) => [key, expandMcpVariable(value, environment)])),
        }),
        catch: (cause) => new McpError({ operation: "environment", message: cause instanceof Error ? cause.message : "Unable to resolve MCP environment." }),
      })
      const authorizationLock = yield* lockFor(oauthLocks, server.id)
      // Only one refresh may consume a rotating refresh token. Other connections
      // retry with the new token instead of refreshing the one they just sent.
      const authorizedFetch: FetchLike = async (input, init) => {
        const response = await fetch(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), closing.signal]) })
        if (response.status !== 401 || String(input).split("?")[0] !== server.url?.split("?")[0]) return response
        return runKanna(authorizationLock.withPermits(1)(Effect.tryPromise({
          try: async () => {
            const sent = new Headers(init?.headers).get("Authorization")
            const current = await provider.tokens()
            if (!current?.access_token || sent === `Bearer ${current.access_token}`) {
              const challenge = extractWWWAuthenticateParams(response)
              await auth(provider, { serverUrl: server.url!, resourceMetadataUrl: challenge.resourceMetadataUrl, scope: challenge.scope, fetchFn: oauthFetch })
            }
            const tokens = await provider.tokens()
            const headers = new Headers(init?.headers)
            if (tokens?.access_token) headers.set("Authorization", `Bearer ${tokens.access_token}`)
            return fetch(input, { ...init, headers, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), closing.signal]) })
          },
          catch: () => new McpError({ operation: "authorize", message: "Sign in to this server in Settings → MCP servers." }),
        })))
      }
      const transport = server.transport === "stdio"
        ? new McpStdioTransport(spawner, {
          command: resolved.command!, args: resolved.args, cwd, env: environment,
        })
        : server.transport === "sse"
          ? new SSEClientTransport(new URL(server.url!), { authProvider: provider, requestInit: { headers: resolved.headers }, fetch: authorizedFetch })
          : new StreamableHTTPClientTransport(new URL(server.url!), { authProvider: provider, requestInit: { headers: resolved.headers }, fetch: authorizedFetch })
      const client = new Client({ name: "kanna", version: "1.0.0" })
      const owner = { id: server.id, key, active: true }
      connecting.set(client, owner)
      const start = Effect.tryPromise({
        try: async (signal) => {
          const credentials = await runKanna(store.credentials(server.id))
          if (server.url && credentials.tokens?.refresh_token && credentials.expiresAt && credentials.expiresAt <= Date.now() + 30_000) {
            await runKanna(authorizationLock.withPermits(1)(Effect.tryPromise({
              try: async () => {
                const latest = await runKanna(store.credentials(server.id))
                if (latest.expiresAt && latest.expiresAt <= Date.now() + 30_000) await auth(provider, { serverUrl: server.url!, fetchFn: oauthFetch })
              },
              catch: () => new McpError({ operation: "authorize", message: "Sign in to this server in Settings → MCP servers." }),
            })))
          }
          await client.connect(transport, { signal: AbortSignal.any([signal, closing.signal]), timeout: 20_000 })
        },
        catch: (cause) => {
          const needsAuth = cause instanceof UnauthorizedError || attempt?.url || states.get(server.id)?.status === "needsAuth"
          const message = needsAuth ? "Sign in to this server in Settings → MCP servers." : "Could not connect. Check the server address, command, and credentials."
          states.set(server.id, { status: needsAuth ? "needsAuth" : "error", message })
          return new McpError({ operation: "connect", message })
        },
      }).pipe(Effect.timeout("30 seconds"), Effect.mapError((cause) => cause instanceof McpError ? cause : new McpError({ operation: "connect", message: "MCP connection timed out." })))
      return yield* Effect.gen(function* () {
        yield* start
        // A save/delete/close while the handshake was pending must not resurrect its connection.
        const current = yield* lookup(server.id)
        if (!owner.active || closing.signal.aborted || fingerprint(current) !== fingerprint(server)) {
          return yield* new McpError({ operation: "connect", message: "MCP configuration changed. Connect again." })
        }
        const connection: Connection = { client, id: server.id, fingerprint: fingerprint(server) }
        connections.set(key, connection)
        client.onclose = () => { connection.closed = true }
        states.set(server.id, { status: "connected" })
        return client
      }).pipe(Effect.onError(() => closeClient(client)), Effect.ensuring(Effect.sync(() => connecting.delete(client))))
    }))
  })

  const connect = Effect.fn("ManagedMcp.connect")(function* (id: string) {
    const server = yield* lookup(id)
    pending.delete(id)
    const previous = connections.get(`settings:${id}`)
    if (previous) { connections.delete(`settings:${id}`); yield* closeClient(previous.client) }
    // Try existing credentials first. Re-register a dynamic OAuth client only when interaction is required.
    const initial = yield* Effect.result(connectClient(server, `settings:${id}`, server.projectPath ?? machine.homeDirectory))
    if (initial._tag === "Success") {
      const tools = yield* Effect.tryPromise(() => initial.success.getServerCapabilities()?.tools ? initial.success.listTools() : Promise.resolve({ tools: [] })).pipe(Effect.orElseSucceed(() => ({ tools: [] })))
      states.set(id, { status: "connected", toolCount: tools.tools.length })
      return { status: "connected" } satisfies McpConnectResult
    }
    if (server.transport === "stdio") {
      states.set(id, { status: "error", message: initial.failure.message })
      return yield* initial.failure
    }
    const attempt: PendingAuth = { state: crypto.randomUUID(), expires: Date.now() + 10 * 60_000, fingerprint: fingerprint(server), epoch: yield* store.credentialEpoch(id) }
    pending.set(id, attempt)
    const credentials = yield* store.credentials(id)
    if (credentials.redirectUrl && credentials.redirectUrl !== `${origin}/oauth/callback` && !server.clientId) {
      yield* store.updateCredentials(id, (value) => ({ discovery: value.discovery }))
    }
    const result = yield* Effect.result(connectClient(server, `settings:${id}`, server.projectPath ?? machine.homeDirectory, attempt))
    if (result._tag === "Success") { pending.delete(id); return { status: "connected" } satisfies McpConnectResult }
    if (attempt.url) {
      states.set(id, { status: "needsAuth" })
      return { status: "needsAuth", authorizationUrl: attempt.url } satisfies McpConnectResult
    }
    pending.delete(id)
    states.set(id, { status: "error", message: result.failure.message })
    return yield* result.failure
  })

  const callback = (request: Request) => Effect.gen(function* () {
    const url = new URL(request.url)
    const entry = [...pending.entries()].find(([, attempt]) => attempt.state === url.searchParams.get("state"))
    if (!entry) return new Response("Authorization attempt not found. Return to Kanna and sign in again.", { status: 400 })
    const [id, attempt] = entry
    pending.delete(id)
    if (attempt.expires < Date.now() || !attempt.verifier || !url.searchParams.get("code") || url.searchParams.has("error")) {
      states.set(id, { status: "error", message: "Sign-in was cancelled or expired. Connect again." })
      return new Response("Sign-in was cancelled or expired. Return to Kanna to try again.", { status: 400 })
    }
    const server = yield* lookup(id)
    if (attempt.fingerprint !== fingerprint(server)) return new Response("Configuration changed. Sign in again.", { status: 400 })
    const oauthLock = yield* lockFor(oauthLocks, id)
    yield* oauthLock.withPermits(1)(Effect.tryPromise({
      try: () => auth(oauthProvider(server, attempt.epoch, attempt), { serverUrl: server.url!, authorizationCode: url.searchParams.get("code")!, fetchFn: oauthFetch }),
      catch: () => {
        states.set(id, { status: "error", message: "Sign-in failed. Try connecting again." })
        return new McpError({ operation: "authorize", message: "Sign-in failed. Try connecting again." })
      },
    }))
    yield* connectClient(server, `settings:${id}`, server.projectPath ?? machine.homeDirectory)
    generations.set(id, (generations.get(id) ?? 0) + 1)
    return new Response("Connected to Kanna. You can close this tab.", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } })
  }).pipe(Effect.catchTag("@kanna/server/McpError", () => Effect.succeed(new Response("Sign-in failed. Return to Kanna to try again.", { status: 400 }))))

  const proxy = (request: Request, route: Route) => Effect.gen(function* () {
    const server = yield* lookup(route.id)
    if (!server.providers.includes(route.provider) || fingerprint(server) !== route.fingerprint) return new Response("Configuration changed. Restart the chat connection.", { status: 410 })
    const client = yield* connectClient(server, `${route.chatId}:${server.id}`, route.cwd)
    const capabilities = client.getServerCapabilities()
    const bridge = new Server({ name: server.name, version: "1.0.0" }, {
      capabilities: { ...(capabilities?.tools ? { tools: {} } : {}), ...(capabilities?.resources ? { resources: {} } : {}), ...(capabilities?.prompts ? { prompts: {} } : {}) },
      instructions: client.getInstructions(),
    })
    type Extra = { signal: AbortSignal; requestId: string | number }
    const forward = async <A>(extra: Extra, call: (options: { signal: AbortSignal; timeout: number; resetTimeoutOnProgress: boolean }) => Promise<A>) => {
      const key = `${route.token}:${extra.requestId}`
      const controller = new AbortController()
      activeRequests.set(key, controller)
      try { return await call({ signal: AbortSignal.any([extra.signal, request.signal, closing.signal, controller.signal]), timeout: 86400_000, resetTimeoutOnProgress: true }) }
      finally { if (activeRequests.get(key) === controller) activeRequests.delete(key) }
    }
    // Stateless HTTP notifications arrive on another transport, so cancellation
    // must be routed to the request's controller rather than that transport's map.
    bridge.setNotificationHandler(CancelledNotificationSchema, (notification) => {
      activeRequests.get(`${route.token}:${notification.params.requestId}`)?.abort()
    })
    if (capabilities?.tools) {
      bridge.setRequestHandler(ListToolsRequestSchema, (call, extra) => forward(extra, (options) => client.listTools(call.params, options)))
      bridge.setRequestHandler(CallToolRequestSchema, (call, extra) => forward(extra, (options) => client.callTool(call.params, undefined, {
        ...options,
        onprogress: (progress) => {
          if (extra._meta?.progressToken !== undefined) void extra.sendNotification({ method: "notifications/progress", params: { ...progress, progressToken: extra._meta.progressToken } }).catch(() => {})
        },
      })))
    }
    if (capabilities?.resources) {
      bridge.setRequestHandler(ListResourcesRequestSchema, (call, extra) => forward(extra, (options) => client.listResources(call.params, options)))
      bridge.setRequestHandler(ListResourceTemplatesRequestSchema, (call, extra) => forward(extra, (options) => client.listResourceTemplates(call.params, options)))
      bridge.setRequestHandler(ReadResourceRequestSchema, (call, extra) => forward(extra, (options) => client.readResource(call.params, options)))
    }
    if (capabilities?.prompts) {
      bridge.setRequestHandler(ListPromptsRequestSchema, (call, extra) => forward(extra, (options) => client.listPrompts(call.params, options)))
      bridge.setRequestHandler(GetPromptRequestSchema, (call, extra) => forward(extra, (options) => client.getPrompt(call.params, options)))
    }
    downstream.add(bridge)
    const release = () => { downstream.delete(bridge); return Effect.tryPromise(() => bridge.close()).pipe(Effect.ignore) }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    const response = yield* Effect.tryPromise({
      try: async () => { await bridge.connect(transport); return transport.handleRequest(request) },
      catch: () => new McpError({ operation: "proxy", message: "MCP bridge request failed." }),
    }).pipe(Effect.onError(release))
    if (!response.body) { yield* release(); return response }
    const body = Stream.fromReadableStream({ evaluate: () => response.body!, onError: () => new McpError({ operation: "proxy", message: "MCP response interrupted." }) }).pipe(Stream.ensuring(release()))
    return new Response(Stream.toReadableStream(body), { status: response.status, headers: response.headers })
  }).pipe(Effect.catchTag("@kanna/server/McpError", () => Effect.succeed(new Response("MCP connection unavailable. Open Settings → MCP servers.", { status: 503 }))))

  const listener = yield* Effect.acquireRelease(http.listen({
    hostname: "127.0.0.1", port: 0, idleTimeoutSeconds: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      if (request.headers.has("origin")) return new Response("Forbidden", { status: 403 })
      if (url.pathname === "/oauth/callback" && request.method === "GET") return runKanna(callback(request))
      const route = routes.get(url.pathname)
      if (!route || request.headers.get("authorization") !== `Bearer ${route.token}`) return new Response("Unauthorized", { status: 401 })
      return runKanna(proxy(request, route))
    },
  }).pipe(Effect.mapError(() => new McpError({ operation: "listen", message: "Unable to start the local MCP bridge." }))), (listener) => Effect.gen(function* () {
    closing.abort()
    yield* listener.stop(true)
    yield* Effect.forEach([...connections.values()], ({ client }) => closeClient(client), { concurrency: "unbounded", discard: true })
    yield* Effect.forEach([...connecting.keys()], closeClient, { concurrency: "unbounded", discard: true })
    yield* Effect.forEach([...downstream], (server) => Effect.tryPromise(() => server.close()).pipe(Effect.ignore), { concurrency: "unbounded", discard: true })
    connections.clear(); routes.clear(); pending.clear()
  }))
  origin = `http://127.0.0.1:${listener.port}`

  const save = Effect.fn("ManagedMcp.save")(function* (input: McpServerInput) {
    const saved = yield* store.save(input)
    yield* invalidate(saved.id)
    return yield* snapshot
  })
  const importConfig = Effect.fn("ManagedMcp.importConfig")(function* (content: string, providers: McpProvider[], projectPath?: string) {
    const inputs = yield* Effect.try({ try: () => parseMcpImport(content, providers, projectPath), catch: (cause) => new McpError({ operation: "import", message: cause instanceof Error ? cause.message : "Invalid MCP configuration." }) })
    const existing = yield* store.servers
    // Never silently replace an existing Kanna server (including its credentials).
    if (inputs.some((input) => existing.some((entry) => entry.name === input.name && entry.projectPath === input.projectPath))) {
      return yield* new McpError({ operation: "import", message: "A server with this name already exists in Kanna. Edit it to enable another provider." })
    }
    // Validate the whole batch before the first write.
    yield* Effect.try({ try: () => inputs.forEach((input) => validateMcpServer(input, machine.homeDirectory)), catch: () => new McpError({ operation: "import", message: "One or more MCP definitions are invalid. No servers were imported." }) })
    yield* store.saveMany(inputs)
    return yield* snapshot
  })
  const importProvider = Effect.fn("ManagedMcp.importProvider")(function* (provider: "claude" | "codex" | "cursor", projectPath?: string) {
    const file = provider === "claude" ? projectPath ? path.join(projectPath, ".mcp.json") : path.join(machine.homeDirectory, ".claude.json")
      : provider === "cursor" ? path.join(projectPath ?? machine.homeDirectory, ".cursor", "mcp.json")
      : projectPath ? path.join(projectPath, ".codex", "config.toml") : path.join(machine.env.get("CODEX_HOME") ?? path.join(machine.homeDirectory, ".codex"), "config.toml")
    const content = yield* fs.readFileString(file).pipe(Effect.mapError(() => new McpError({ operation: "import", message: "Could not read the provider's MCP configuration." })))
    return yield* importConfig(content, [...MCP_PROVIDERS], projectPath)
  })
  const endpoints = Effect.fn("ManagedMcp.endpoints")(function* (provider: McpProvider, cwd: string, chatId: string) {
    const selected = (yield* store.servers).filter((server) => server.providers.includes(provider) && (!server.projectPath || path.resolve(server.projectPath) === path.resolve(cwd)))
    // Project-scoped entries override global entries of the same name.
    const byName = new Map(selected.filter((server) => !server.projectPath).map((server) => [server.name, server]))
    for (const server of selected.filter((server) => server.projectPath)) byName.set(server.name, server)
    const result: McpBridgeServers = {}
    for (const server of byName.values()) {
      let existing = [...routes.entries()].find(([, route]) => route.id === server.id && route.chatId === chatId && route.provider === provider && route.fingerprint === fingerprint(server) && route.generation === (generations.get(server.id) ?? 0))
      if (!existing) {
        const pathname = `/servers/${crypto.randomUUID()}`
        const route: Route = { id: server.id, provider, cwd, chatId, token: crypto.randomUUID(), fingerprint: fingerprint(server), generation: generations.get(server.id) ?? 0 }
        routes.set(pathname, route); existing = [pathname, route]
      }
      result[server.name] = { url: `${origin}${existing[0]}`, headers: { Authorization: `Bearer ${existing[1].token}` } }
    }
    return result
  })
  return {
    snapshot, save, connect, endpoints, importConfig, importProvider,
    piTools: (cwd: string, chatId: string) => Effect.gen(function* () {
      const selected = yield* endpoints("pi", cwd, chatId)
      const tools: ToolDefinition[] = []
      for (const [name, endpoint] of Object.entries(selected)) {
        const route = routes.get(new URL(endpoint.url).pathname)!
        const server = yield* lookup(route.id)
        const loaded = yield* Effect.result(Effect.gen(function* () {
          const client = yield* connectClient(server, `${chatId}:${server.id}`, cwd)
          if (!client.getServerCapabilities()?.tools) return []
          const definitions: ToolDefinition[] = []
          let cursor: string | undefined
          do {
            const page = yield* Effect.tryPromise({ try: () => client.listTools(cursor ? { cursor } : {}), catch: () => new McpError({ operation: "tools", message: "Unable to list MCP tools." }) })
            for (const tool of page.tools) {
              definitions.push({
                name: `mcp__${mcpBridgeName(name)}__${tool.name}`, label: tool.title ?? tool.name,
                description: tool.description ?? tool.name, parameters: tool.inputSchema as TSchema,
                execute: async (_id, input, signal) => {
                  const current = await runKanna(lookup(server.id))
                  if (!current.providers.includes("pi") || fingerprint(current) !== fingerprint(server)) throw new Error("MCP configuration changed. Send another message to reconnect.")
                  const result = CallToolResultSchema.parse(await client.callTool({ name: tool.name, arguments: input as Record<string, unknown> }, undefined, { signal, timeout: 86400_000 }))
                  const content = result.content.map((block) => block.type === "text" || block.type === "image" ? block : { type: "text" as const, text: JSON.stringify(block) })
                  if (result.isError) throw new Error(content.filter((block) => block.type === "text").map((block) => block.text).join("\n"))
                  return { content, details: result.structuredContent ?? {} }
                },
              })
            }
            cursor = page.nextCursor
          } while (cursor)
          return definitions
        }))
        if (loaded._tag === "Success") tools.push(...loaded.success)
        else states.set(server.id, { status: "error", message: loaded.failure.message })
      }
      return tools
    }),
    remove: (id: string) => store.remove(id).pipe(Effect.andThen(invalidate(id)), Effect.andThen(snapshot)),
    disconnect: (id: string) => invalidate(id).pipe(Effect.andThen(store.clearCredentials(id)), Effect.andThen(snapshot)),
    releaseChat: (chatId: string) => Effect.gen(function* () {
      for (const [key, route] of routes) if (route.chatId === chatId) routes.delete(key)
      for (const [key, connection] of connections) if (key.startsWith(`${chatId}:`)) { connections.delete(key); yield* closeClient(connection.client) }
      for (const [client, owner] of connecting) if (owner.key.startsWith(`${chatId}:`)) { owner.active = false; yield* closeClient(client) }
    }),
  }
})
