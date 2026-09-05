/**
 * `/api/v1/*` — the remote REST API.
 *
 * Two kinds of caller reach this. A person or script with a key from `--api`
 * (see cli-runtime.ts), and Kanna's own agent-facing MCP bridge, which runs as
 * a child process of a codex session and holds a loopback-only internal key
 * (see ../kanna-mcp-stdio.ts). The bridge additionally sends
 * `X-Kanna-Agent-Chat`, naming the chat whose agent is calling, which is what
 * the fan-out guard in control.ts keys off.
 *
 * The operations themselves live in control.ts, shared with the in-process
 * tools Claude gets, so HTTP and MCP cannot drift.
 *
 * Prompts are asynchronous: a send returns 202 with the chat id, and the
 * caller polls `GET /api/v1/chats/:id` for status and new messages. A turn can
 * run for many minutes, which no HTTP client or proxy would sit through.
 */

import type { AgentProvider, ModelOptions } from "../../shared/types"
import {
  addProject,
  cancelChat,
  ControlError,
  createChat,
  deleteChat,
  getChat,
  listChats,
  listProjects,
  reloadFromDisk,
  sendMessage,
  type ControlCaller,
  type ControlDeps,
  type PromptFields,
} from "./control"
import { extractApiKey, type ApiKeyVerifier } from "./keys"

export const API_ROUTE_PREFIX = "/api/v1"

/**
 * Header the MCP bridge sets to identify the chat its agent is running in.
 * Only honoured for callers holding the internal key — a human API client
 * setting it would only restrict itself, but there is no reason to let it.
 */
export const AGENT_CHAT_HEADER = "x-kanna-agent-chat"

export interface ApiRouteDeps extends ControlDeps {
  verifier: ApiKeyVerifier
  /**
   * True when the request's key was the internal one Kanna mints for its own
   * agent bridge. Only such a request may claim an agent chat id.
   */
  isInternalKey?: (req: Request) => boolean
  version: string
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

function methodNotAllowed(allow: string) {
  return new Response(null, { status: 405, headers: { Allow: allow, "Cache-Control": "no-store" } })
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text()
  if (!raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ControlError(400, "Body must be valid JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ControlError(400, "Body must be a JSON object")
  }
  return parsed as Record<string, unknown>
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== "string" || !value.trim()) {
    throw new ControlError(400, `Missing or empty "${field}"`)
  }
  return value
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new ControlError(400, `"${field}" must be a string`)
  return value
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "boolean") throw new ControlError(400, `"${field}" must be a boolean`)
  return value
}

function isTruthyParam(value: string | null) {
  return value === "" || value === "1" || value === "true"
}

/**
 * The prompt fields shared by "create a chat and send" and "send to an
 * existing chat". Kept in one place so the two routes can't drift.
 */
function readPromptFields(body: Record<string, unknown>): PromptFields {
  const modelOptions = body.modelOptions
  if (modelOptions !== undefined && (typeof modelOptions !== "object" || modelOptions === null || Array.isArray(modelOptions))) {
    throw new ControlError(400, '"modelOptions" must be an object')
  }
  return {
    provider: optionalString(body, "provider") as AgentProvider | undefined,
    model: optionalString(body, "model"),
    effort: optionalString(body, "effort"),
    modelOptions: modelOptions as ModelOptions | undefined,
    planMode: optionalBoolean(body, "planMode"),
    autoPlan: optionalBoolean(body, "autoPlan"),
  }
}

/** The agent chat behind this request, or undefined for a human caller. */
function readCaller(req: Request, deps: ApiRouteDeps): ControlCaller | undefined {
  const chatId = req.headers.get(AGENT_CHAT_HEADER)?.trim()
  if (!chatId) return undefined
  if (!deps.isInternalKey?.(req)) return undefined
  return { chatId }
}

// --- routes ---------------------------------------------------------------

function handleRoot(deps: ApiRouteDeps) {
  return json({
    name: "kanna",
    version: deps.version,
    api: 1,
    capabilities: ["projects", "chats", "messages", "cancel", "reload"],
  })
}

async function handleCreateProject(req: Request, deps: ApiRouteDeps) {
  const body = await readJsonBody(req)
  const result = await addProject(deps, {
    localPath: requireString(body, "localPath"),
    title: optionalString(body, "title"),
  })
  // Always 201, including for a path that was already open: opening is
  // idempotent and existing clients treat any 2xx that isn't 201 as a
  // surprise. `created` in the body is how a caller tells the two apart.
  return json({ project: result.project, created: result.created }, 201)
}

function handleListChats(url: URL, deps: ApiRouteDeps) {
  const rawLimit = url.searchParams.get("limit")
  let limit: number | undefined
  if (rawLimit !== null) {
    const parsed = Number(rawLimit)
    if (!Number.isInteger(parsed) || parsed < 1) throw new ControlError(400, '"limit" must be a positive integer')
    limit = parsed
  }
  return json(listChats(deps, {
    projectId: url.searchParams.get("projectId") ?? undefined,
    includeArchived: isTruthyParam(url.searchParams.get("includeArchived")),
    limit,
  }))
}

async function handleCreateChat(req: Request, deps: ApiRouteDeps) {
  const body = await readJsonBody(req)
  const result = await createChat(
    deps,
    {
      projectId: requireString(body, "projectId"),
      content: optionalString(body, "content"),
      ...readPromptFields(body),
    },
    readCaller(req, deps)
  )
  return result.started
    ? json({ chat: result.chat, queued: result.queued }, 202)
    : json({ chat: result.chat }, 201)
}

function handleGetChat(url: URL, chatId: string, deps: ApiRouteDeps) {
  return json(getChat(deps, { chatId, full: isTruthyParam(url.searchParams.get("full")) }))
}

async function handleSendMessage(req: Request, chatId: string, deps: ApiRouteDeps) {
  const body = await readJsonBody(req)
  const result = await sendMessage(
    deps,
    { chatId, content: requireString(body, "content"), ...readPromptFields(body) },
    readCaller(req, deps)
  )
  return json(result, 202)
}

// --- dispatch -------------------------------------------------------------

/** True when this request is for the REST API, whoever it turns out to be. */
export function isApiRoute(url: URL) {
  return url.pathname === API_ROUTE_PREFIX || url.pathname.startsWith(`${API_ROUTE_PREFIX}/`)
}

/**
 * True when the request carries a key valid for this server. `server.ts` uses
 * this to let an API caller past the `--password` session gate, which exists
 * for browsers and which an API client has no way to satisfy.
 */
export function hasValidApiKey(req: Request, verifier: ApiKeyVerifier | null) {
  if (!verifier || verifier.count === 0) return false
  return verifier.isValid(extractApiKey(req))
}

async function route(req: Request, url: URL, deps: ApiRouteDeps): Promise<Response> {
  const rest = url.pathname.slice(API_ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, "")
  let segments: string[]
  try {
    segments = rest ? rest.split("/").map(decodeURIComponent) : []
  } catch {
    // decodeURIComponent throws URIError on malformed input like `%ZZ`. That
    // is a bad request, not a server fault, so it must not reach the 500 path.
    throw new ControlError(400, "Malformed percent-encoding in path")
  }

  if (segments.length === 0) {
    if (req.method !== "GET") return methodNotAllowed("GET")
    return handleRoot(deps)
  }

  if (segments[0] === "reload" && segments.length === 1) {
    if (req.method !== "POST") return methodNotAllowed("POST")
    return json(await reloadFromDisk(deps))
  }

  if (segments[0] === "projects" && segments.length === 1) {
    if (req.method === "GET") return json(listProjects(deps))
    if (req.method === "POST") return await handleCreateProject(req, deps)
    return methodNotAllowed("GET, POST")
  }

  if (segments[0] === "chats") {
    if (segments.length === 1) {
      if (req.method === "GET") return handleListChats(url, deps)
      if (req.method === "POST") return await handleCreateChat(req, deps)
      return methodNotAllowed("GET, POST")
    }

    const chatId = segments[1]!
    if (segments.length === 2) {
      if (req.method === "GET") return handleGetChat(url, chatId, deps)
      if (req.method === "DELETE") return json(await deleteChat(deps, { chatId }))
      return methodNotAllowed("GET, DELETE")
    }

    if (segments.length === 3 && segments[2] === "messages") {
      if (req.method !== "POST") return methodNotAllowed("POST")
      return await handleSendMessage(req, chatId, deps)
    }

    if (segments.length === 3 && segments[2] === "cancel") {
      if (req.method !== "POST") return methodNotAllowed("POST")
      return json(await cancelChat(deps, { chatId }))
    }
  }

  return json({ error: "Not found" }, 404)
}

/**
 * Returns null when the request is not for the API, so `server.ts` can keep
 * this in its chain of fall-through handlers.
 */
export async function handleApiRequest(req: Request, url: URL, deps: ApiRouteDeps): Promise<Response | null> {
  if (!isApiRoute(url)) return null

  if (!hasValidApiKey(req, deps.verifier)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Bearer realm="kanna"',
      },
    })
  }

  try {
    return await route(req, url, deps)
  } catch (error) {
    if (error instanceof ControlError) {
      return json({ error: error.message }, error.status)
    }
    // Store and agent failures surface as 500 with their message: this API is
    // key-gated and operator-facing, so the detail is useful, not a leak.
    const message = error instanceof Error ? error.message : "Internal error"
    return json({ error: message }, 500)
  }
}
