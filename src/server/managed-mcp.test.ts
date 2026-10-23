import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Result } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListResourceTemplatesRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { ManagedMcp, parseMcpImport } from "./managed-mcp"
import { makeMcpStore } from "./mcp-store"
import { runTest } from "./effect/testing"
import type { McpBridgeEndpoint } from "../shared/mcp"

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function directory() { const dir = await mkdtemp(path.join(tmpdir(), "kanna-managed-mcp-")); dirs.push(dir); return dir }

/** A real MCP + OAuth server. No provider account, network service, or browser is needed. */
function upstream(oauth = false) {
  let base = ""
  let token = "access-0"
  let refresh = "refresh-0"
  let registrations = 0
  let refreshes = 0
  let exchanges = 0
  let lastChallenge = ""
  const clients = new Map<string, Record<string, unknown>>()
  const servers = new Set<Server>()
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()
  let started!: () => void
  let cancelled!: () => void
  const waiting = new Promise<void>((resolve) => { started = resolve })
  const cancellation = new Promise<void>((resolve) => { cancelled = resolve })
  const requests: string[] = []
  const http = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return Response.json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["tools"] })
      if (url.pathname.startsWith("/.well-known/")) return Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] })
      if (url.pathname === "/register") {
        const metadata = await request.json() as Record<string, unknown>
        const id = `client-${++registrations}`
        clients.set(id, metadata)
        return Response.json({ ...metadata, client_id: id }, { status: 201 })
      }
      if (url.pathname === "/authorize") {
        if (!clients.has(url.searchParams.get("client_id") ?? "")) return new Response("Unknown client", { status: 400 })
        lastChallenge = url.searchParams.get("code_challenge") ?? ""
        const callback = new URL(url.searchParams.get("redirect_uri")!)
        callback.searchParams.set("state", url.searchParams.get("state")!)
        callback.searchParams.set("code", "authorization-code")
        return Response.redirect(callback.toString(), 302)
      }
      if (url.pathname === "/token") {
        const fields = new URLSearchParams(await request.text())
        if (!clients.has(fields.get("client_id") ?? "")) return Response.json({ error: "invalid_client" }, { status: 400 })
        if (fields.get("grant_type") === "refresh_token") {
          if (fields.get("refresh_token") !== refresh) return Response.json({ error: "invalid_grant" }, { status: 400 })
          refreshes++
        } else {
          const challenge = createHash("sha256").update(fields.get("code_verifier") ?? "").digest("base64url")
          if (!lastChallenge || challenge !== lastChallenge || fields.get("code") !== "authorization-code") return Response.json({ error: "invalid_grant" }, { status: 400 })
          exchanges++
        }
        token = `access-${exchanges + refreshes}`; refresh = `refresh-${exchanges + refreshes}`
        return Response.json({ access_token: token, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 })
      }
      if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 })
      const authorization = request.headers.get("authorization") ?? ""
      requests.push(authorization)
      if (oauth && authorization !== `Bearer ${token}`) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` } })
      const sessionId = request.headers.get("mcp-session-id")
      if (sessionId) return sessions.get(sessionId)?.handleRequest(request) ?? new Response("Session not found", { status: 404 })
      const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: "Use these fixture tools." })
      server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] }))
      server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
        if (call.params.name === "wait") {
          started()
          await new Promise<void>((resolve) => extra.signal.addEventListener("abort", () => { cancelled(); resolve() }, { once: true }))
        }
        return { content: [{ type: "text", text: String(call.params.arguments?.value) }] }
      })
      server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [{ uri: "fixture://readme", name: "README" }] }))
      server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }))
      server.setRequestHandler(ReadResourceRequestSchema, () => ({ contents: [{ uri: "fixture://readme", text: "Read me." }] }))
      server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [{ name: "review" }] }))
      server.setRequestHandler(GetPromptRequestSchema, () => ({ messages: [{ role: "user", content: { type: "text", text: "Review this." } }] }))
      servers.add(server)
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true, onsessioninitialized: (id) => { sessions.set(id, transport) } })
      await server.connect(transport)
      return transport.handleRequest(request)
    },
  })
  base = `http://127.0.0.1:${http.port}`
  return {
    url: `${base}/mcp`, requests, waiting, cancellation,
    get registrations() { return registrations }, get refreshes() { return refreshes }, get exchanges() { return exchanges },
    expire() { token = "expired" },
    async close() { http.stop(true); await Promise.all([...servers].map((server) => server.close())) },
  }
}

async function bridgeClient(endpoint: McpBridgeEndpoint) {
  const client = new Client({ name: "test-harness", version: "1" })
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }))
  return client
}

describe("Kanna-owned MCP connections", () => {
  test("one definition serves tools, resources, prompts and instructions to multiple harnesses", async () => {
    const dir = await directory(); const fixture = upstream()
    try {
      await runTest(Effect.gen(function* () {
        const mcp = yield* ManagedMcp
        yield* mcp.save({ name: "fixture", transport: "http", url: fixture.url, providers: ["claude", "codex"] })
        const claude = (yield* mcp.endpoints("claude", "/project", "chat-a")).fixture!
        const codex = (yield* mcp.endpoints("codex", "/project", "chat-b")).fixture!
        expect(claude.url).not.toBe(codex.url)
        const clients = yield* Effect.promise(() => Promise.all([bridgeClient(claude), bridgeClient(codex)]))
        try {
          for (const client of clients) {
            expect(client.getInstructions()).toBe("Use these fixture tools.")
            expect((yield* Effect.promise(() => client.listTools())).tools[0]?.name).toBe("echo")
            expect((yield* Effect.promise(() => client.callTool({ name: "echo", arguments: { value: "portable" } }))).content).toEqual([{ type: "text", text: "portable" }])
            expect((yield* Effect.promise(() => client.listResources())).resources[0]?.uri).toBe("fixture://readme")
            expect((yield* Effect.promise(() => client.getPrompt({ name: "review" }))).messages).toHaveLength(1)
          }
        } finally { yield* Effect.promise(() => Promise.all(clients.map((client) => client.close()))) }
        expect((yield* mcp.endpoints("cursor", "/project", "chat-c"))).toEqual({})
      }).pipe(Effect.provide(ManagedMcp.layer(dir))))
    } finally { await fixture.close() }
  })

  test("cancelling a tool through a stateless bridge cancels its upstream request", async () => {
    const dir = await directory(); const fixture = upstream()
    try {
      await runTest(Effect.gen(function* () {
        const mcp = yield* ManagedMcp
        yield* mcp.save({ name: "fixture", transport: "http", url: fixture.url, providers: ["codex"] })
        const endpoint = (yield* mcp.endpoints("codex", "/project", "cancel-chat")).fixture!
        const client = yield* Effect.promise(() => bridgeClient(endpoint))
        const controller = new AbortController()
        const call = client.callTool({ name: "wait" }, undefined, { signal: controller.signal }).then(() => false, () => true)
        yield* Effect.promise(() => fixture.waiting)
        controller.abort()
        expect(yield* Effect.promise(() => call)).toBe(true)
        yield* Effect.promise(() => fixture.cancellation).pipe(Effect.timeout("2 seconds"))
        yield* Effect.promise(() => client.close())
      }).pipe(Effect.provide(ManagedMcp.layer(dir))))
    } finally { await fixture.close() }
  })

  test("OAuth is completed in Kanna, shared across providers, refreshed, and retained after restart", async () => {
    const dir = await directory(); const fixture = upstream(true)
    let serverId = ""
    try {
      await runTest(Effect.gen(function* () {
        const mcp = yield* ManagedMcp
        const snapshot = yield* mcp.save({ name: "oauth", transport: "http", url: fixture.url, providers: ["claude", "codex", "pi"] })
        serverId = snapshot.servers[0]!.id
        const result = yield* mcp.connect(serverId)
        expect(result.status).toBe("needsAuth")
        expect(result.authorizationUrl).toBeDefined()
        const redirect = yield* Effect.promise(() => fetch(result.authorizationUrl!, { redirect: "manual" }))
        const callback = redirect.headers.get("location")!
        const bad = new URL(callback); bad.searchParams.set("state", "wrong-state")
        expect((yield* Effect.promise(() => fetch(bad))).status).toBe(400)
        expect(fixture.exchanges).toBe(0)
        expect((yield* Effect.promise(() => fetch(callback))).status).toBe(200)
        expect((yield* Effect.promise(() => fetch(callback))).status).toBe(400)
        expect(fixture.exchanges).toBe(1)
        for (const provider of ["claude", "codex"] as const) {
          const endpoint = (yield* mcp.endpoints(provider, "/project", `chat-${provider}`)).oauth!
          const client = yield* Effect.promise(() => bridgeClient(endpoint))
          expect((yield* Effect.promise(() => client.callTool({ name: "echo", arguments: { value: provider } }))).isError).not.toBe(true)
          yield* Effect.promise(() => client.close())
        }
        const clients = yield* Effect.promise(async () => {
          const endpoints = await Promise.all(["claude", "codex"].map((provider) => Effect.runPromise(mcp.endpoints(provider as "claude" | "codex", "/project", `concurrent-${provider}`))))
          return Promise.all(endpoints.map((endpoint) => bridgeClient(endpoint.oauth!)))
        })
        fixture.expire()
        yield* Effect.promise(() => Promise.all(clients.map((client) => client.callTool({ name: "echo", arguments: { value: "concurrent" } }))))
        expect(fixture.refreshes).toBe(1)
        yield* Effect.promise(() => Promise.all(clients.map((client) => client.close())))
        const serialized = JSON.stringify(yield* mcp.snapshot)
        expect(serialized).not.toContain("access_token")
        expect(serialized).not.toContain("refresh_token")
        expect(serialized).not.toContain("client_secret")
        const tools = yield* mcp.piTools("/project", "chat-pi")
        expect(tools[0]?.name).toBe("mcp__kanna-oauth__echo")
        expect((yield* Effect.promise(() => tools[0]!.execute("call", { value: "pi" }, new AbortController().signal, undefined, {} as Parameters<(typeof tools)[number]["execute"]>[4]))).content).toEqual([{ type: "text", text: "pi" }])
      }).pipe(Effect.provide(ManagedMcp.layer(dir))))
      expect((await stat(path.join(dir, "mcp-credentials.json"))).mode & 0o777).toBe(0o600)
      fixture.expire()
      await runTest(Effect.gen(function* () {
        const mcp = yield* ManagedMcp
        expect((yield* mcp.connect(serverId)).status).toBe("connected")
        expect(fixture.refreshes).toBe(2)
        expect(fixture.exchanges).toBe(1)
      }).pipe(Effect.provide(ManagedMcp.layer(dir))))
    } finally { await fixture.close() }
  })

  test("local commands share Kanna's arguments and environment, and stop when the chat closes", async () => {
    const dir = await directory()
    await runTest(Effect.gen(function* () {
      const mcp = yield* ManagedMcp
      const fixturePath = new URL("./__fixtures__/managed-mcp-stdio.ts", import.meta.url).pathname
      const created = yield* mcp.save({ name: "local", transport: "stdio", command: process.execPath, args: [fixturePath, "argument-secret"], env: { FIXTURE_KEY: "environment-secret" }, providers: ["codex"] })
      const summary = created.servers[0]!
      expect(JSON.stringify(summary)).not.toContain("argument-secret")
      expect(JSON.stringify(summary)).not.toContain("environment-secret")
      // Provider toggles must retain arguments and environment without reading secrets into the browser.
      yield* mcp.save({ id: summary.id, name: summary.name, transport: "stdio", command: process.execPath, providers: ["codex", "claude"] })
      const endpoint = (yield* mcp.endpoints("codex", dir, "local-chat")).local!
      const client = yield* Effect.promise(() => bridgeClient(endpoint))
      const result = yield* Effect.promise(() => client.callTool({ name: "context" }))
      const context = JSON.parse((result.content as { text: string }[])[0]!.text)
      expect(context).toMatchObject({ cwd: yield* Effect.promise(() => realpath(dir)), key: "environment-secret", argument: "argument-secret" })
      yield* mcp.releaseChat("local-chat")
      expect(() => process.kill(context.pid, 0)).toThrow()
      yield* Effect.promise(() => client.close())
    }).pipe(Effect.provide(ManagedMcp.layer(dir))))
  })

  test("batch imports are atomic and credentials cannot be restored after a sign-out or server change", async () => {
    const dir = await directory()
    await runTest(Effect.gen(function* () {
      const store = yield* makeMcpStore(dir)
      const first = yield* store.save({ name: "first", transport: "http", url: "https://example.com/mcp", providers: ["claude"] })
      const epoch = yield* store.credentialEpoch(first.id)
      const { mcpAuthIdentity } = yield* Effect.promise(() => import("./mcp-store"))
      const expected = { identity: mcpAuthIdentity(first), epoch }
      yield* store.updateCredentials(first.id, () => ({ tokens: { access_token: "secret", token_type: "Bearer" } }), expected)
      yield* store.clearCredentials(first.id)
      expect(Result.isFailure(yield* Effect.result(store.updateCredentials(first.id, () => ({ tokens: { access_token: "late-secret", token_type: "Bearer" } }), expected)))).toBe(true)
      expect(yield* store.credentials(first.id)).toEqual({})
      const result = yield* Effect.result(store.saveMany([
        { name: "second", transport: "http", url: "https://second.example/mcp", providers: ["codex"] },
        { name: "first", transport: "http", url: "https://duplicate.example/mcp", providers: ["codex"] },
      ]))
      expect(Result.isFailure(result)).toBe(true)
      expect((yield* store.servers).map((entry) => entry.name)).toEqual(["first"])
    }))
  })

  test("bridges require their own token, reject browser origins, and revoke access on disable/delete", async () => {
    const dir = await directory(); const fixture = upstream()
    try {
      await runTest(Effect.gen(function* () {
        const mcp = yield* ManagedMcp
        const initial = yield* mcp.save({ name: "fixture", transport: "http", url: fixture.url, providers: ["codex"] })
        const server = initial.servers[0]!
        const endpoint = (yield* mcp.endpoints("codex", "/project", "chat")).fixture!
        expect((yield* Effect.promise(() => fetch(endpoint.url))).status).toBe(401)
        expect((yield* Effect.promise(() => fetch(endpoint.url, { headers: { ...endpoint.headers, Origin: "https://example.com" } }))).status).toBe(403)
        yield* mcp.save({ id: server.id, name: server.name, transport: "http", url: fixture.url, providers: [] })
        expect((yield* Effect.promise(() => fetch(endpoint.url, { headers: endpoint.headers }))).status).toBe(401)
        expect(yield* mcp.endpoints("codex", "/project", "chat")).toEqual({})
        yield* mcp.remove(server.id)
        expect((yield* mcp.snapshot).servers).toEqual([])
      }).pipe(Effect.provide(ManagedMcp.layer(dir))))
    } finally { await fixture.close() }
  })

  test("project overrides are scoped, and credential values are retained on ordinary edits", async () => {
    const dir = await directory()
    await runTest(Effect.gen(function* () {
      const mcp = yield* ManagedMcp
      let snapshot = yield* mcp.save({ name: "fixture", transport: "http", url: "https://global.example/mcp", providers: ["codex"], headers: { Authorization: "Bearer secret" }, env: { API_KEY: "secret" }, clientSecret: "secret" })
      const server = snapshot.servers[0]!
      expect(JSON.stringify(snapshot)).not.toContain('"secret"')
      yield* mcp.save({ id: server.id, name: server.name, transport: "http", url: server.url, providers: ["codex", "claude"] })
      const file = JSON.parse(yield* Effect.promise(() => readFile(path.join(dir, "mcp.json"), "utf8")))
      expect(file.servers[0].headers.Authorization).toBe("Bearer secret")
      expect(file.servers[0].env.API_KEY).toBe("secret")
      snapshot = yield* mcp.save({ name: "fixture", transport: "http", url: "https://project.example/mcp", projectPath: "/project", providers: ["codex"] })
      expect(snapshot.servers).toHaveLength(2)
      const project = yield* mcp.endpoints("codex", "/project", "project-chat")
      const global = yield* mcp.endpoints("codex", "/other", "other-chat")
      expect(Object.keys(project)).toEqual(["fixture"])
      expect(Object.keys(global)).toEqual(["fixture"])
      expect(project.fixture?.url).not.toBe(global.fixture?.url)
    }).pipe(Effect.provide(ManagedMcp.layer(dir))))
  })

  test("invalid storage fails without overwriting it", async () => {
    const dir = await directory()
    await writeFile(path.join(dir, "mcp.json"), "{bad json")
    const result = await runTest(Effect.result(makeMcpStore(dir)))
    expect(Result.isFailure(result)).toBe(true)
    expect(await readFile(path.join(dir, "mcp.json"), "utf8")).toBe("{bad json")
  })

  test("imports JSON and TOML definitions without transferring provider OAuth sessions", () => {
    expect(parseMcpImport('{"mcpServers":{"local":{"command":"npx","args":["server"]}}}', ["claude", "codex"])[0]).toMatchObject({ name: "local", transport: "stdio", providers: ["claude", "codex"] })
    expect(parseMcpImport('[mcp_servers.remote]\nurl="https://example.com/mcp"\n[mcp_servers.remote.http_headers]\nAuthorization="Bearer x"', ["pi"])[0]).toMatchObject({ name: "remote", transport: "http", headers: { Authorization: "Bearer x" } })
    expect(() => parseMcpImport('{"mcpServers":{"remote":{"url":"https://example.com","headersHelper":"command"}}}', ["pi"])).toThrow("headersHelper")
  })
})
