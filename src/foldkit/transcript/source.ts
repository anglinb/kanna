import { getUserPromptSignature, TRANSCRIPT_PADDING_BOTTOM_OFFSET } from "../../client/app/kannaStateHelpers"
import { CHAT_NAVBAR_OFFSET_PX } from "../../client/app/ChatPage/utils"
import type { ResolvedTranscriptRow } from "../../client/app/transcriptRowTypes"
import {
  buildRowIndexByMessageId,
  findLatestAssistantTextRowIndex,
  findLatestUserPromptRowIndex,
  findToolCallRowIndex,
} from "../../client/app/ChatPage/transcriptScrollAnchors"
import { buildTranscriptTurns, type TranscriptTurn } from "../../client/app/ChatPage/transcriptTurns"
import type { ChatJumpTarget } from "../../client/lib/chat-navigation"
import type { SidebarThread } from "../../client/lib/thread-sections"
import type {
  AgentProvider,
  HydratedTranscriptMessage,
  QueuedChatMessage,
  ResolvedChatReadAnchor,
  TranscriptOutlineEntry,
  WaitingOn,
} from "../../shared/types"
import type { EditorPreset, TerminalPreset } from "../../shared/protocol"
import type { AppModel } from "../app/slice"
import { getOpenAppItems } from "../chat/openExternal"
import { routeChatId } from "../app/route"
import * as ChatSession from "../core/chatSession"
import * as Sidebar from "../core/stores/sidebar"
import { chatSchedules, sidebarThread } from "../chat/chatReference"
import type { ChatPageContext } from "../chat/pageInputs"
import type { RenderOptions, ScheduleReferences, TranscriptRow } from "./messages"
import type { Model } from "./model"
import { resolvedRows } from "./resolve"
import type { Feed, RestoreCandidate } from "./viewport"

// What the viewport draws from: ChatTranscriptViewport's props, as one
// value. The chat page's comes off the root Model (useKannaState's chat
// fields, as ChatPage passed them); the export viewer makes its own.

export interface TranscriptSource {
  chatId: string | null
  messages: ReadonlyArray<HydratedTranscriptMessage>
  queued: ReadonlyArray<QueuedChatMessage>
  localPath: string | undefined
  latestToolIds: Record<string, string | null>
  isProcessing: boolean
  runtimeStatus: string | null
  waitingOn: WaitingOn | undefined
  isDraining: boolean
  commandError: string | null
  usageLimitResume: { at: number; provider: AgentProvider } | null
  /** onUsageLimitResume is given (a chat page). */
  canResume: boolean
  hasOlder: boolean
  outline: ReadonlyArray<TranscriptOutlineEntry> | undefined
  isLoadingOlder: boolean
  readAnchor: { resolved: boolean; anchor: ResolvedChatReadAnchor | null; confirmed: boolean }
  /** onReportReadAnchor is given. */
  reports: boolean
  jump: { requestId: number; target: ChatJumpTarget } | null
  headerOffsetPx: number
  transcriptPaddingBottom: number
  showEmptyState: boolean
  isPageFileDragActive: boolean
  showScrollButton: boolean
  /** The sub-chat's parent (useParentChatId), and the chat's project (ReplyQuoteProjectContext). */
  parentChatId: string | null
  currentProjectId: string | null
  options: Partial<RenderOptions>
  /** Absent outside a chat page: every reference draws as plain text. */
  references: {
    /** The root, for a live chat card's row and menu (chatCard.ts). */
    app: AppModel
    sidebarThread: (chatId: string | null | undefined) => SidebarThread | null
    sidebarReady: boolean
    schedules: ScheduleReferences
  } | null
  /** Where the viewport is found by the slice's Commands. */
  viewportKey: string
  /** A local link's right-click menu (OpenExternalContextMenuContent): where it can open the file. */
  linkMenu: LinkMenuSource | null
}

export interface LinkMenuSource {
  isMac: boolean
  editorPreset: EditorPreset
  editorCommandTemplate: string | undefined
  installedEditors: EditorPreset[] | null
  installedTerminals: TerminalPreset[] | null
}

/** The menu's destinations: React's OpenAppMenuItems with Finder, Preview and the default app. */
export function linkMenuItems(menu: LinkMenuSource) {
  return getOpenAppItems({
    editorPreset: menu.editorPreset,
    isMac: menu.isMac,
    installedEditors: menu.installedEditors,
    installedTerminals: menu.installedTerminals,
    includeFinder: true,
    includePreview: true,
    includeDefault: true,
  })
}

export function pageLinkMenu(app: AppModel): LinkMenuSource {
  const settings = app.stores.appSettings.settings
  return {
    isMac: (app.localProjects?.machine.platform ?? "darwin") === "darwin",
    editorPreset: app.stores.terminalPreferences.editorPreset,
    editorCommandTemplate: app.stores.terminalPreferences.editorCommandTemplate,
    installedEditors: settings?.installedEditors ?? null,
    installedTerminals: settings?.installedTerminals ?? null,
  }
}

const EMPTY_QUEUED: QueuedChatMessage[] = []
const NO_READ_ANCHOR = { resolved: true, anchor: null, confirmed: true }

/** The page's chat session, if it is the route's chat. */
export function pageChat(app: AppModel) {
  const chatId = routeChatId(app.route)
  return chatId && app.chat?.chatId === chatId ? app.chat : null
}

export function viewportKey(chatId: string | null) {
  return `page:${chatId ?? "none"}`
}

/** The chat page's transcript, off the root Model and the page's own state. */
export function pageSource(app: AppModel, page: ChatPageContext | undefined, model: Model): TranscriptSource {
  const chatId = routeChatId(app.route)
  const chat = pageChat(app)
  const snapshot = chat ? ChatSession.snapshotOf(chat) : null
  const runtime = snapshot?.runtime ?? null
  const sidebarStatus = Sidebar.sidebarChatStatus(app.stores.sidebar, chat?.chatId ?? null)
  const messages = chat?.messages ?? []
  const pending = app.actions.pendingChatJump
  return {
    chatId,
    messages,
    queued: snapshot?.queuedMessages ?? EMPTY_QUEUED,
    localPath: runtime?.localPath,
    latestToolIds: chat ? ChatSession.latestToolIds(chat) : {},
    isProcessing: chat ? ChatSession.isProcessing(chat, sidebarStatus) : false,
    runtimeStatus: chat ? ChatSession.runtimeStatus(chat, sidebarStatus) : null,
    waitingOn: runtime?.waitingOn,
    isDraining: runtime?.isDraining ?? false,
    commandError: app.commandError,
    usageLimitResume: runtime?.usageLimitResume ?? null,
    canResume: true,
    hasOlder: chat ? ChatSession.hasOlderMessages(chat) : false,
    outline: snapshot?.outline,
    isLoadingOlder: chat?.isLoadingOlder ?? false,
    readAnchor: chat ? ChatSession.readAnchorState(chat) : { resolved: false, anchor: null, confirmed: false },
    reports: true,
    jump: pending && pending.chatId === chatId ? { requestId: pending.requestId, target: pending.jump } : null,
    headerOffsetPx: CHAT_NAVBAR_OFFSET_PX,
    transcriptPaddingBottom: page?.transcriptPaddingBottom ?? TRANSCRIPT_PADDING_BOTTOM_OFFSET,
    showEmptyState: page?.showEmptyState ?? false,
    isPageFileDragActive: page?.isPageFileDragActive ?? false,
    showScrollButton: model.showScrollToBottom && messages.length > 0,
    parentChatId: Sidebar.parentChatId(app.stores.sidebar, chatId),
    currentProjectId: Sidebar.projectIdForChat(app.stores.sidebar, chatId),
    options: { canLoadDebugRaw: true, interceptLocalLinks: true },
    references: {
      app,
      sidebarThread: (id) => sidebarThread(app, id),
      sidebarReady: app.stores.sidebar.ready,
      schedules: chatSchedules(app),
    },
    viewportKey: viewportKey(chatId),
    linkMenu: pageLinkMenu(app),
  }
}

export { NO_READ_ANCHOR }

// DERIVED

export function rowsOf(source: TranscriptSource): TranscriptRow[] {
  return resolvedRows(source.messages, {
    isLoading: source.isProcessing,
    localPath: source.localPath ?? undefined,
    latestToolIds: source.latestToolIds,
  })
}

const asResolved = (rows: TranscriptRow[]) => rows as unknown as ResolvedTranscriptRow[]

let turnsCache: { rows: TranscriptRow[]; turns: TranscriptTurn[] } | null = null

/**
 * The turns the minimap shows: the loaded ones from the rows, and before the
 * window those the outline names (no rows, so no reply or count; they exist
 * so the map reaches the start and a click can load them).
 */
export function turnsOf(source: TranscriptSource, rows: TranscriptRow[]): TranscriptTurn[] {
  const loadedTurns = turnsCache?.rows === rows ? turnsCache.turns : buildTranscriptTurns(asResolved(rows))
  turnsCache = { rows, turns: loadedTurns }
  const outline = source.outline
  if (!source.hasOlder || !outline || outline.length === 0) return loadedTurns
  const loadedIds = new Set(loadedTurns.map((turn) => turn.id))
  const unloaded: TranscriptTurn[] = outline
    .filter((entry) => !loadedIds.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      rowIndex: -1,
      endRowIndex: -1,
      replyRowId: null,
      prompt: entry.preview,
      response: null,
      agentMessageCount: 0,
      error: null,
      timestamp: new Date(entry.createdAt).toISOString(),
      durationMs: null,
      loaded: false,
    }))
  return unloaded.length === 0 ? loadedTurns : [...unloaded, ...loadedTurns]
}

/** A short, stable stand-in for a prompt's content signature (only ever compared). */
function hashSignature(text: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`
}

/** resolveRestoreTarget, but for the column width test, which the controller does. */
function restoreCandidate(rows: TranscriptRow[], anchor: ResolvedChatReadAnchor | null, rowIndexByMessageId: Map<string, number>): RestoreCandidate {
  if (rows.length === 0) return { kind: "end" }
  if (anchor?.atEnd) return { kind: "end" }
  if (anchor) {
    const index = rowIndexByMessageId.get(anchor.messageId)
    const rowId = index === undefined ? undefined : rows[index]?.id
    if (rowId !== undefined) {
      return {
        kind: "pin",
        rowId,
        ...(anchor.offsetFromMessage !== undefined ? { offsetFromMessage: anchor.offsetFromMessage } : {}),
        ...(anchor.transcriptWidth !== undefined ? { transcriptWidth: anchor.transcriptWidth } : {}),
      }
    }
  }
  const latestPromptIndex = findLatestUserPromptRowIndex(asResolved(rows))
  const latestPromptRowId = latestPromptIndex === null ? undefined : rows[latestPromptIndex]?.id
  return latestPromptRowId !== undefined ? { kind: "pin", rowId: latestPromptRowId } : { kind: "end" }
}

/** What the viewport's controller reads (viewport.ts `Feed`). */
export function feedOf(source: TranscriptSource, rows: TranscriptRow[], model: Model): Feed {
  const resolved = asResolved(rows)
  const rowIndexByMessageId = buildRowIndexByMessageId(resolved)
  const promptIndex = findLatestUserPromptRowIndex(resolved)
  const promptRow = promptIndex === null ? null : rows[promptIndex]
  const prompt = promptRow?.kind === "single" && promptRow.message.kind === "user_prompt"
    ? {
      messageId: promptRow.message.id,
      signature: hashSignature(getUserPromptSignature(promptRow.message.content, promptRow.message.attachments ?? [])),
      rowIndex: promptIndex!,
      rowId: promptRow.id,
    }
    : null
  const replyIndex = findLatestAssistantTextRowIndex(resolved)
  const toolTarget = [source.jump?.target, model.lastJump?.target].find((target): target is { toolId: string } => typeof target === "object" && target !== null)
  const toolIndex = toolTarget ? findToolCallRowIndex(resolved, toolTarget.toolId) : null
  const unloaded = model.unloadedJump
  const unloadedIndex = unloaded ? rowIndexByMessageId.get(unloaded.messageId) : undefined
  return {
    chatId: source.chatId,
    header: source.headerOffsetPx,
    insetBottom: Math.max(0, source.transcriptPaddingBottom - TRANSCRIPT_PADDING_BOTTOM_OFFSET),
    readAnchor: { resolved: source.readAnchor.resolved, confirmed: source.readAnchor.confirmed },
    restore: restoreCandidate(rows, source.readAnchor.anchor, rowIndexByMessageId),
    prompt,
    reply: replyIndex === null ? null : rows[replyIndex]?.id ?? null,
    tool: toolTarget ? { toolId: toolTarget.toolId, rowId: toolIndex === null ? null : rows[toolIndex]?.id ?? null } : null,
    jump: source.jump,
    hasOlder: source.hasOlder,
    loadingOlder: source.isLoadingOlder,
    unloadedJump: unloaded ? { seq: unloaded.seq, rowId: unloadedIndex === undefined ? null : rows[unloadedIndex]?.id ?? null } : null,
    atEnd: model.isAtEnd,
    minimap: !source.showEmptyState,
    reports: source.reports,
  }
}
