/**
 * The operations Kanna exposes to something that is not a browser: the REST
 * API (`routes.ts`) and the agent-facing MCP tools (`../kanna-tools.ts`).
 *
 * Both surfaces call the same functions here so they cannot drift — a change
 * to what "create a chat" means lands on the HTTP route and the tool in one
 * edit. The functions go through the same `EventStore` and `AgentCoordinator`
 * the WebSocket uses, then `broadcast()` pushes fresh snapshots, so a chat
 * created either way shows up in a connected browser straight away.
 *
 * Errors are `ControlError`, which carries the HTTP status the REST layer
 * wants and a message the tool layer hands back to the model verbatim.
 */

import type { AgentProvider, ChatSnapshot, KannaStatus, ModelOptions } from "../../shared/types"
import type { ClientCommand } from "../../shared/protocol"
import type { ChatRecord, ProjectRecord } from "../events"
import type { EventStore } from "../event-store"
import type { AnalyticsReporter } from "../analytics"
import { initializeProjectDirectory } from "../paths"
import { SERVER_PROVIDERS } from "../provider-catalog"
import { deriveChatSnapshot, deriveStatus } from "../read-models"
import { readChatWindow, type ChatWindowRouteDeps } from "../chat-window-route"

/** Cap on `listChats` so one call can't serialize an entire history. */
export const DEFAULT_CHAT_LIMIT = 50
export const MAX_CHAT_LIMIT = 200

export class ControlError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export interface ControlDeps extends ChatWindowRouteDeps {
  store: ChatWindowRouteDeps["store"] &
    Pick<EventStore, "getProject" | "openProject" | "createChat" | "deleteChat" | "reload">
  agent: ChatWindowRouteDeps["agent"] & {
    send: (
      command: Extract<ClientCommand, { type: "chat.send" }>,
      options?: { agentOrigin?: ControlCaller }
    ) => Promise<{ chatId: string; queuedMessageId?: string; queued?: true }>
    cancel: (chatId: string) => Promise<void>
    closeChat: (chatId: string) => Promise<void>
  }
  /** Push fresh snapshots to connected sockets after a write. */
  broadcast: () => Promise<void> | void
  /**
   * Same reporter the socket uses. Writes through here emit the same events as
   * the equivalent `ClientCommand`, so metrics don't silently miss whatever is
   * driven over HTTP or by an agent's tool call.
   */
  analytics: Pick<AnalyticsReporter, "track">
}

/**
 * Reject a provider the server has no catalog entry for.
 *
 * This has to happen before `agent.send`. A bad provider is only discovered
 * when the turn is set up — and for a prompt that lands behind a running turn
 * that is long after the 202, in `dequeueAndStartQueuedMessage`, which removes
 * the queued message *before* the catalog lookup throws. The prompt would be
 * acknowledged and then silently dropped. Validating against SERVER_PROVIDERS
 * (rather than a hand-written list) keeps this in step with what
 * `getProviderSettings` will actually accept.
 *
 * Lives here rather than at the route so the agent-facing tools get the same
 * check: the MCP schema constrains the enum, but a tool call is still model
 * output arriving over a wire.
 */
export function assertKnownProvider(provider: AgentProvider | undefined) {
  if (provider === undefined) return
  if (SERVER_PROVIDERS.some((candidate) => candidate.id === provider)) return
  const known = SERVER_PROVIDERS.map((candidate) => candidate.id).join(", ")
  throw new ControlError(400, `Unknown provider "${provider}". Expected one of: ${known}`)
}

/** Prompt knobs shared by "create a chat and send" and "send to a chat". */
export interface PromptFields {
  provider?: AgentProvider
  model?: string
  effort?: string
  modelOptions?: ModelOptions
  planMode?: boolean
  autoPlan?: boolean
}

/**
 * Identifies the chat a request came from, when it came from an agent running
 * inside Kanna. Absent for a human API client. Drives the fan-out guard in
 * {@link assertMaySpawn}.
 */
export interface ControlCaller {
  chatId: string
}

export interface SerializedProject {
  id: string
  title: string
  localPath: string
  createdAt: number
  updatedAt: number
  chatCount: number
}

export interface SerializedChat {
  id: string
  projectId: string
  title: string
  status: KannaStatus
  provider: AgentProvider | null
  createdAt: number
  updatedAt: number
  lastMessageAt: number | null
  lastModel: string | null
  hasMessages: boolean
  unread: boolean
  archived: boolean
  /** Set when an agent created this chat — see `ChatRecord.agentOrigin`. */
  createdByChatId: string | null
}

export function serializeProject(project: ProjectRecord, chatCount: number): SerializedProject {
  return {
    id: project.id,
    title: project.sidebarTitle ?? project.title,
    localPath: project.localPath,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    chatCount,
  }
}

export function serializeChat(chat: ChatRecord, status: KannaStatus): SerializedChat {
  return {
    id: chat.id,
    projectId: chat.projectId,
    title: chat.title,
    status,
    provider: chat.provider,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    lastMessageAt: chat.lastMessageAt ?? null,
    lastModel: chat.lastModel ?? null,
    hasMessages: Boolean(chat.hasMessages),
    unread: chat.unread,
    archived: Boolean(chat.archivedAt),
    createdByChatId: chat.agentOrigin?.chatId ?? null,
  }
}

function chatStatus(deps: ControlDeps, chat: ChatRecord): KannaStatus {
  return deriveStatus(chat, deps.agent.getActiveStatuses().get(chat.id))
}

function liveChats(deps: ControlDeps) {
  return [...deps.store.state.chatsById.values()].filter((chat) => !chat.deletedAt)
}

export function requireChat(deps: ControlDeps, chatId: string): ChatRecord {
  const chat = deps.store.getChat(chatId)
  if (!chat || chat.deletedAt) throw new ControlError(404, "Chat not found")
  return chat
}

/**
 * The fan-out guard for agent callers.
 *
 * An agent may start turns in *other* chats, but a chat that an agent itself
 * created may not start any: one agent can hand work to a second, and there
 * the chain stops. Without this a loop that ends in "spin up a chat to do the
 * rest" recurses into unbounded billed turns, and nothing in the transcript
 * makes that visible until the bill does.
 *
 * Depth is read off the persisted `agentOrigin` rather than an in-memory
 * counter, so a restart (which resumes interrupted turns) doesn't reset it.
 */
export function assertMaySpawn(deps: ControlDeps, caller: ControlCaller | undefined, targetChatId?: string) {
  if (!caller) return
  if (targetChatId && targetChatId === caller.chatId) {
    throw new ControlError(409, "An agent cannot send a message to its own chat")
  }
  const callerChat = deps.store.getChat(caller.chatId)
  if (callerChat?.agentOrigin) {
    throw new ControlError(
      409,
      "This chat was itself started by an agent, so it cannot start more agent work. Ask the person you are working with to do it."
    )
  }
}

// --- projects -------------------------------------------------------------

export function listProjects(deps: ControlDeps) {
  const chatCounts = new Map<string, number>()
  for (const chat of liveChats(deps)) {
    if (chat.archivedAt) continue
    chatCounts.set(chat.projectId, (chatCounts.get(chat.projectId) ?? 0) + 1)
  }
  const projects = [...deps.store.state.projectsById.values()]
    .filter((project) => !project.deletedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((project) => serializeProject(project, chatCounts.get(project.id) ?? 0))
  return { projects }
}

export async function addProject(deps: ControlDeps, input: { localPath: string; title?: string }) {
  // Same call the UI's "new project" flow makes: create the directory if it is
  // missing, and `git init` it when it is empty so chats there get diffs. An
  // existing non-empty directory is left exactly as it is.
  let resolvedPath: string
  try {
    resolvedPath = await initializeProjectDirectory(input.localPath)
  } catch (error) {
    throw new ControlError(400, error instanceof Error ? error.message : "Could not open project directory")
  }

  // openProject is idempotent on a path that is already open, so ask before
  // rather than after: the returned record looks the same either way, and a
  // caller told "created" about a project that was already there would go on
  // to make a duplicate.
  const existingId = deps.store.state.projectIdsByPath.get(resolvedPath)
  const existing = existingId ? deps.store.state.projectsById.get(existingId) : undefined
  const alreadyOpen = Boolean(existing && !existing.deletedAt)

  const project = await deps.store.openProject(resolvedPath, input.title)
  // Mirrors ws-router's `project.open`: only a path that wasn't already open
  // counts as opening a project.
  if (!alreadyOpen) deps.analytics.track("project_opened")
  await deps.broadcast()
  return { project: serializeProject(project, 0), created: !alreadyOpen }
}

// --- chats ----------------------------------------------------------------

export function listChats(
  deps: ControlDeps,
  input: { projectId?: string; includeArchived?: boolean; limit?: number }
) {
  if (input.projectId && !deps.store.getProject(input.projectId)) {
    throw new ControlError(404, "Project not found")
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
    throw new ControlError(400, '"limit" must be a positive integer')
  }
  const limit = Math.min(input.limit ?? DEFAULT_CHAT_LIMIT, MAX_CHAT_LIMIT)

  const matching = liveChats(deps)
    .filter((chat) => (input.projectId ? chat.projectId === input.projectId : true))
    .filter((chat) => (input.includeArchived ? true : !chat.archivedAt))
    .sort((a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt))

  return {
    chats: matching.slice(0, limit).map((chat) => serializeChat(chat, chatStatus(deps, chat))),
    total: matching.length,
  }
}

export async function createChat(
  deps: ControlDeps,
  input: { projectId: string; content?: string } & PromptFields,
  caller?: ControlCaller
) {
  if (!deps.store.getProject(input.projectId)) throw new ControlError(404, "Project not found")
  assertKnownProvider(input.provider)

  const content = input.content?.trim() ? input.content : undefined
  // The guard is on starting turns, not on creating records: an empty chat
  // runs nothing and costs nothing, and staging one for a person to prompt is
  // a reasonable thing for any agent to do. Only `content` spends anything.
  if (content) assertMaySpawn(deps, caller)

  // With `content`, hand the whole thing to agent.send: it creates the chat
  // and starts the first turn in one step, exactly as the composer does when
  // you type into a project with no chat open.
  if (content) {
    const result = await deps.agent.send(
      {
        type: "chat.send",
        projectId: input.projectId,
        content,
        provider: input.provider,
        model: input.model,
        effort: input.effort,
        modelOptions: input.modelOptions,
        planMode: input.planMode,
        autoPlan: input.autoPlan,
      },
      { agentOrigin: caller }
    )
    await deps.broadcast()
    const chat = requireChat(deps, result.chatId)
    return { chat: serializeChat(chat, chatStatus(deps, chat)), queued: result.queued ?? false, started: true }
  }

  // `agent.send` tracks this itself on the prompt path above, so it is only
  // emitted here, where the chat is created on its own.
  const chat = await deps.store.createChat(input.projectId, { agentOrigin: caller })
  deps.analytics.track("chat_created")
  await deps.broadcast()
  return { chat: serializeChat(chat, chatStatus(deps, chat)), queued: false, started: false }
}

export function getChat(deps: ControlDeps, input: { chatId: string; full?: boolean }) {
  const chat = requireChat(deps, input.chatId)
  const snapshot: ChatSnapshot | null = input.full
    ? deriveChatSnapshot(
        deps.store.state,
        deps.agent.getActiveStatuses(),
        deps.agent.getDrainingChatIds(),
        input.chatId,
        (id) => deps.store.getClientTranscript(id)
      )
    : readChatWindow(input.chatId, deps)
  if (!snapshot) throw new ControlError(404, "Chat not found")
  return {
    chat: serializeChat(chat, chatStatus(deps, chat)),
    runtime: snapshot.runtime,
    queuedMessages: snapshot.queuedMessages,
    messages: snapshot.messages,
    startIndex: snapshot.startIndex,
  }
}

export async function sendMessage(
  deps: ControlDeps,
  input: { chatId: string; content: string } & PromptFields,
  caller?: ControlCaller
) {
  requireChat(deps, input.chatId)
  assertMaySpawn(deps, caller, input.chatId)
  assertKnownProvider(input.provider)

  const result = await deps.agent.send({
    type: "chat.send",
    chatId: input.chatId,
    content: input.content,
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    modelOptions: input.modelOptions,
    planMode: input.planMode,
    autoPlan: input.autoPlan,
  })
  await deps.broadcast()

  const chat = requireChat(deps, result.chatId)
  return {
    chatId: result.chatId,
    // True when a turn was already running: the prompt was queued behind it
    // rather than starting one, and will run when the current turn ends.
    queued: result.queued ?? false,
    queuedMessageId: result.queuedMessageId ?? null,
    status: chatStatus(deps, chat),
  }
}

export async function cancelChat(deps: ControlDeps, input: { chatId: string }) {
  requireChat(deps, input.chatId)
  await deps.agent.cancel(input.chatId)
  await deps.broadcast()
  const chat = requireChat(deps, input.chatId)
  return { chatId: input.chatId, status: chatStatus(deps, chat) }
}

/**
 * Re-read the store from disk and bring the running process in line with it.
 *
 * For editing the data dir underneath a live Kanna — moving a chat between
 * projects, importing one, fixing a record — and picking the result up without
 * a restart. `EventStore.reload` validates everything first and refuses rather
 * than resetting, so a bad edit surfaces as an error with the old state still
 * loaded.
 *
 * Two loose ends the store cannot tie off on its own, both about chats that no
 * longer exist on disk but still have something running in this process:
 *
 * - A chat with a live harness session is released the same way deleting one
 *   would (cancel, then close). Left alone, its agent would keep appending to
 *   a chat no snapshot mentions.
 * - Chats that survived the reload but had a turn running are reported back
 *   rather than touched. Their turn is still going and still writing; that is
 *   usually fine, but the caller should know which ones were in flight.
 */
export async function reloadFromDisk(deps: ControlDeps) {
  const activeBefore = [...deps.agent.getActiveStatuses().keys()]

  let counts: { projects: number; chats: number }
  try {
    counts = await deps.store.reload()
  } catch (error) {
    // 409, not 500: the data dir is in a state this build will not load, and
    // the caller is the one who can fix it.
    throw new ControlError(409, `Reload refused: ${error instanceof Error ? error.message : String(error)}`)
  }

  const stillLive = (chatId: string) => {
    const chat = deps.store.getChat(chatId)
    return Boolean(chat && !chat.deletedAt)
  }

  const droppedChatIds: string[] = []
  for (const chatId of activeBefore) {
    if (stillLive(chatId)) continue
    await deps.agent.cancel(chatId)
    await deps.agent.closeChat(chatId)
    droppedChatIds.push(chatId)
  }

  await deps.broadcast()

  return {
    ...counts,
    /** Chats whose turn was still running through the reload. */
    activeChatIds: activeBefore.filter(stillLive),
    /** Chats that vanished from disk; their harness session was released. */
    droppedChatIds,
  }
}

export async function deleteChat(deps: ControlDeps, input: { chatId: string }) {
  requireChat(deps, input.chatId)
  // Same order as the UI's chat.delete: stop the turn, release the harness
  // session, then tombstone the record.
  await deps.agent.cancel(input.chatId)
  await deps.agent.closeChat(input.chatId)
  await deps.store.deleteChat(input.chatId)
  deps.analytics.track("chat_deleted")
  await deps.broadcast()
  return { chatId: input.chatId, deleted: true as const }
}
