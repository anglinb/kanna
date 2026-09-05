/**
 * `kanna mcp` — the Kanna management tools as a stdio MCP server.
 *
 * Codex has no in-process tool hook the way the Claude Agent SDK does, so its
 * sessions get these tools by spawning this as a child process
 * (`codex app-server -c mcp_servers.kanna.…`, wired up in codex-app-server.ts).
 * It speaks MCP over stdin/stdout and turns each `tools/call` into one request
 * to `/api/v1` on loopback, where control.ts does the same work Claude's
 * in-process server does directly.
 *
 * MCP is hand-rolled rather than pulled from a package: this speaks exactly
 * four methods, all of them a few lines, and the alternative is a dependency
 * in the install path of every Kanna user for the sake of a JSON-RPC loop.
 *
 * Credentials come from a file, not argv and not the environment: `ps` shows a
 * child's command line to every user on the machine, and codex passes its own
 * environment through to MCP servers it spawns. The file is written 0600 in
 * the data dir by the server that spawned this.
 */

import { AGENT_CHAT_HEADER } from "./api/routes"
import { KANNA_TOOLS, KANNA_TOOLS_INSTRUCTIONS, toolInputJsonSchema } from "./kanna-tools"

/** MCP revision we implement. Clients that ask for another get told this one. */
const PROTOCOL_VERSION = "2024-11-05"

export interface McpBridgeConfig {
  /** Base URL of the Kanna server, e.g. http://127.0.0.1:3210 */
  baseUrl: string
  /** Internal API key minted by that server for this run. */
  apiKey: string
  /** The chat whose agent is calling, for the fan-out guard. */
  chatId: string
}

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

/**
 * The credentials file the server writes and this process reads. Its own
 * format rather than reusing the `--api-key-file` list format: that one is a
 * bare list of keys, and this needs the URL and the calling chat too.
 */
export function serializeBridgeConfig(config: McpBridgeConfig) {
  return JSON.stringify(config)
}

export function parseBridgeConfig(contents: string): McpBridgeConfig {
  const parsed = JSON.parse(contents) as Partial<McpBridgeConfig>
  if (!parsed.baseUrl || !parsed.apiKey || !parsed.chatId) {
    throw new Error("Malformed Kanna MCP credentials file")
  }
  return { baseUrl: parsed.baseUrl, apiKey: parsed.apiKey, chatId: parsed.chatId }
}

// --- the REST calls behind each tool --------------------------------------

interface HttpResult {
  ok: boolean
  status: number
  body: unknown
}

async function request(
  config: McpBridgeConfig,
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch
): Promise<HttpResult> {
  const response = await fetchImpl(`${config.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      [AGENT_CHAT_HEADER]: config.chatId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    // Leave it as text — a non-JSON body from the API means something is off
    // and the raw response is the most useful thing to show.
  }
  return { ok: response.ok, status: response.status, body: parsed }
}

function query(params: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    search.set(key, String(value))
  }
  const rendered = search.toString()
  return rendered ? `?${rendered}` : ""
}

function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing or empty "${field}"`)
  return value
}

function pick(input: Record<string, unknown>, fields: string[]) {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    if (input[field] !== undefined && input[field] !== null) out[field] = input[field]
  }
  return out
}

const PROMPT_FIELDS = ["provider", "model", "effort", "planMode"]

export async function callTool(
  config: McpBridgeConfig,
  name: string,
  input: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<HttpResult> {
  switch (name) {
    case "list_projects":
      return await request(config, "GET", "/api/v1/projects", undefined, fetchImpl)
    case "add_project":
      return await request(config, "POST", "/api/v1/projects", pick(input, ["localPath", "title"]), fetchImpl)
    case "list_chats":
      return await request(
        config,
        "GET",
        `/api/v1/chats${query({
          projectId: input.projectId as string | undefined,
          includeArchived: input.includeArchived as boolean | undefined,
          limit: input.limit as number | undefined,
        })}`,
        undefined,
        fetchImpl
      )
    case "get_chat":
      return await request(
        config,
        "GET",
        `/api/v1/chats/${encodeURIComponent(requireString(input, "chatId"))}${query({ full: input.full as boolean | undefined })}`,
        undefined,
        fetchImpl
      )
    case "create_chat":
      return await request(
        config,
        "POST",
        "/api/v1/chats",
        pick(input, ["projectId", "content", ...PROMPT_FIELDS]),
        fetchImpl
      )
    case "send_message":
      return await request(
        config,
        "POST",
        `/api/v1/chats/${encodeURIComponent(requireString(input, "chatId"))}/messages`,
        pick(input, ["content", ...PROMPT_FIELDS]),
        fetchImpl
      )
    case "cancel_chat":
      return await request(
        config,
        "POST",
        `/api/v1/chats/${encodeURIComponent(requireString(input, "chatId"))}/cancel`,
        {},
        fetchImpl
      )
    case "reload":
      return await request(config, "POST", "/api/v1/reload", {}, fetchImpl)
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// --- MCP protocol ---------------------------------------------------------

function toolsListResult() {
  return {
    tools: KANNA_TOOLS.map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: toolInputJsonSchema(definition),
    })),
  }
}

/**
 * Handles one JSON-RPC message. Returns the response to write, or null for a
 * notification (which by JSON-RPC takes no reply).
 */
export async function handleMessage(
  config: McpBridgeConfig,
  message: JsonRpcRequest,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, unknown> | null> {
  const respond = (result: unknown) => ({ jsonrpc: "2.0" as const, id: message.id ?? null, result })
  const fail = (code: number, msg: string) => ({
    jsonrpc: "2.0" as const,
    id: message.id ?? null,
    error: { code, message: msg },
  })

  switch (message.method) {
    case "initialize":
      return respond({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "kanna", version: "1" },
        instructions: KANNA_TOOLS_INSTRUCTIONS,
      })
    case "notifications/initialized":
      return null
    case "ping":
      return respond({})
    case "tools/list":
      return respond(toolsListResult())
    case "tools/call": {
      const params = message.params ?? {}
      const name = typeof params.name === "string" ? params.name : ""
      const args = (params.arguments ?? {}) as Record<string, unknown>
      try {
        const result = await callTool(config, name, args, fetchImpl)
        const text =
          typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2)
        // A refused spawn or a missing chat comes back as an MCP tool error,
        // not a protocol error: the model should read it and adjust, not have
        // its turn fail.
        return respond({
          content: [{ type: "text", text: result.ok ? text : `Kanna API error ${result.status}: ${text}` }],
          isError: !result.ok,
        })
      } catch (error) {
        return respond({
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        })
      }
    }
    default:
      // A notification we don't implement is ignored; a request gets the
      // standard "method not found" so the client isn't left waiting.
      if (message.id === undefined || message.id === null) return null
      return fail(-32601, `Method not found: ${message.method}`)
  }
}

/**
 * Reads newline-delimited JSON-RPC off stdin and writes replies to stdout,
 * until stdin closes. Anything diagnostic goes to stderr — stdout is the
 * protocol channel and a stray log there desynchronizes the client.
 */
export async function runMcpStdioServer(
  config: McpBridgeConfig,
  io: {
    input: ReadableStream<Uint8Array>
    write: (line: string) => void
    warn: (message: string) => void
    fetchImpl?: typeof fetch
  }
) {
  const decoder = new TextDecoder()
  const reader = io.input.getReader()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
      if (!line) continue

      let message: JsonRpcRequest
      try {
        message = JSON.parse(line) as JsonRpcRequest
      } catch {
        io.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }))
        continue
      }

      try {
        const response = await handleMessage(config, message, io.fetchImpl)
        if (response) io.write(JSON.stringify(response))
      } catch (error) {
        io.warn(`kanna mcp: ${error instanceof Error ? error.message : String(error)}`)
        if (message.id !== undefined && message.id !== null) {
          io.write(
            JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Internal error" } })
          )
        }
      }
    }
  }
}
