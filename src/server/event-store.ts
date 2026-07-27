import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { closeSync, existsSync, fstatSync, openSync, readSync, readFileSync as readFileSyncImmediate } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { getDataDir, LOG_PREFIX } from "../shared/branding"
import type { AgentProvider, ChatHistoryPage, ChatHistorySnapshot, ChatTurnSummary, QueuedChatMessage, ResolvedChatReadAnchor, TranscriptEntry } from "../shared/types"
import {
  CHAT_READ_ANCHOR_PADDING,
  CHAT_RECENT_LIMIT_DEFAULT,
  CHAT_RECENT_LIMIT_MAX,
  STORE_VERSION,
} from "../shared/types"
import {
  type ChatEvent,
  type ProjectEvent,
  type QueuedMessageEvent,
  type SnapshotFile,
  type StoreEvent,
  type StoreState,
  type TurnEvent,
  cloneTranscriptEntries,
  cloneTranscriptEntriesForClient,
  createEmptyState,
} from "./events"
import { appendTurnEntry, buildTurnIndexFromBuffer } from "./chat-turn-index"
import { resolveLocalPath } from "./paths"

const COMPACTION_THRESHOLD_BYTES = 2 * 1024 * 1024
const STALE_EMPTY_CHAT_MAX_AGE_MS = 5 * 60 * 1000
/** Chats this much older than the user's latest activity are auto-archived (kept, not deleted). */
const STALE_CHAT_AUTO_ARCHIVE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Chats this much older than the user's latest activity are hard-deleted (archived or not). */
const STALE_CHAT_DELETE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
const SIDEBAR_PROJECT_ORDER_FILE = "sidebar-order.json"
const CHAT_MESSAGE_PREVIEW_MAX_LENGTH = 160
// How much of each transcript tail is scanned at boot to rebuild chat metadata
// (lastMessageAt, previews) that only lives in snapshots between compactions.
const TRANSCRIPT_METADATA_TAIL_BYTES = 256 * 1024
/**
 * Initial tail chunk read when serving a recent page, quadrupled until it
 * covers the requested entry count. 512KB holds a few hundred typical entries,
 * so the default window is usually one read.
 */
const TRANSCRIPT_TAIL_CHUNK_BYTES = 512 * 1024

/** A line at least this long can't be whitespace-only, so skip the check. */
const BLANK_LINE_MAX_BYTES = 8

function isBlankRange(buffer: Buffer, start: number, end: number) {
  for (let index = start; index < end; index++) {
    const byte = buffer[index]!
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) return false
  }
  return true
}

function buildChatMessagePreview(text: string) {
  const collapsed = text.replace(/\s+/g, " ").trim()
  if (!collapsed) return undefined
  return collapsed.length > CHAT_MESSAGE_PREVIEW_MAX_LENGTH
    ? `${collapsed.slice(0, CHAT_MESSAGE_PREVIEW_MAX_LENGTH)}…`
    : collapsed
}

/**
 * Entries the agent itself produced, as opposed to the user's prompts or the
 * bookkeeping entries a session emits around them (system_init, account_info,
 * context_window_updated, compaction/handoff boundaries…). Only these advance
 * `lastAgentMessageAt`, so idle session housekeeping can't make a chat look
 * freshly active.
 *
 * `tool_call`/`tool_result` count alongside `assistant_text`: a plan lands as
 * an ExitPlanMode tool call, and a permission prompt may arrive with no text
 * at all, so text alone would miss exactly the mid-turn stops this timestamp
 * exists to catch. `result` counts too — it's the agent's closing entry.
 */
function isAgentAuthoredEntry(entry: TranscriptEntry) {
  return entry.kind === "assistant_text"
    || entry.kind === "tool_call"
    || entry.kind === "tool_result"
    || entry.kind === "result"
}

function normalizeSidebarProjectOrder(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  const projectIds: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string") continue
    const projectId = entry.trim()
    if (!projectId || seen.has(projectId)) continue
    seen.add(projectId)
    projectIds.push(projectId)
  }

  return projectIds
}



interface LegacyTranscriptStats {
  hasLegacyData: boolean
  sources: Array<"snapshot" | "messages_log">
  chatCount: number
  entryCount: number
}

interface TranscriptPageResult {
  entries: TranscriptEntry[]
  hasOlder: boolean
  olderCursor: string | null
}

/**
 * A cached transcript, possibly only its tail.
 *
 * `startIndex` is the absolute index of `entries[0]` within the file, so a
 * suffix still yields correct `idx:` history cursors. `startIndex === 0` means
 * the whole transcript is present.
 */
interface CachedTranscript {
  entries: TranscriptEntry[]
  startIndex: number
}

interface ParsedReplayEvent {
  event: StoreEvent
  sourceIndex: number
  lineIndex: number
}

function getReplayEventPriority(event: StoreEvent) {
  switch (event.type) {
    case "project_opened":
    case "project_sidebar_renamed":
    case "project_removed":
      return 0
    case "chat_created":
      return 1
    case "chat_renamed":
    case "chat_provider_set":
    case "chat_plan_mode_set":
    case "chat_auto_plan_set":
      return 2
    case "message_appended":
      return 3
    case "queued_message_enqueued":
    case "queued_message_removed":
      return 4
    case "turn_started":
      return 5
    case "session_token_set":
      return 6
    case "pending_fork_session_token_set":
      return 6
    case "turn_cancelled":
      return 7
    case "turn_finished":
    case "turn_failed":
      return 8
    case "chat_read_state_set":
    case "chat_done_state_set":
    case "chat_read_anchor_set":
      return 9
    case "chat_deleted":
    case "chat_archived":
    case "chat_unarchived":
      return 10
  }
}

function encodeHistoryCursor(index: number) {
  return `idx:${index}`
}

function decodeCursor(cursor: string) {
  if (cursor.startsWith("idx:")) {
    const value = Number.parseInt(cursor.slice("idx:".length), 10)
    if (!Number.isInteger(value) || value < 0) {
      throw new Error("Invalid history cursor")
    }
    return value
  }

  throw new Error("Invalid history cursor")
}

function getHistorySnapshot(page: TranscriptPageResult, recentLimit: number): ChatHistorySnapshot {
  return {
    hasOlder: page.hasOlder,
    olderCursor: page.olderCursor,
    recentLimit,
  }
}

function getForkedChatTitle(title: string) {
  const trimmed = title.trim()
  if (!trimmed) return "Fork: New Chat"
  return trimmed.startsWith("Fork: ") ? trimmed : `Fork: ${trimmed}`
}

export class EventStore {
  readonly dataDir: string
  readonly state: StoreState = createEmptyState()
  private writeChain = Promise.resolve()
  private storageReset = false
  private readonly snapshotPath: string
  private readonly projectsLogPath: string
  private readonly chatsLogPath: string
  private readonly messagesLogPath: string
  private readonly queuedMessagesLogPath: string
  private readonly turnsLogPath: string
  private readonly transcriptsDir: string
  private readonly sidebarProjectOrderPath: string
  private legacyMessagesByChatId = new Map<string, TranscriptEntry[]>()
  private legacySidebarProjectOrder: string[] = []
  private sidebarProjectOrder: string[] = []
  private snapshotHasLegacyMessages = false
  // Small LRU of hot transcripts. One slot used to thrash badly: any read of
  // another chat (board view, prune sweep) evicted the actively streaming
  // chat, forcing a synchronous full-file re-read on its next event.
  //
  // An entry may hold only a *suffix* of the transcript — rendering a chat
  // needs the last few hundred entries, not all of them, and parsing a 24MB
  // file to serve 0.3MB was the bulk of a cold chat open. `startIndex` is the
  // absolute index of `entries[0]`, so history cursors stay absolute and
  // appends can extend a suffix in place.
  private readonly transcriptCache = new Map<string, CachedTranscript>()
  /** Turn summaries per chat, built lazily and extended by `appendMessage`. */
  private readonly turnIndexes = new Map<string, ChatTurnSummary[]>()
  /** Entry count per transcript, keyed by the file size it was measured at. */
  private readonly transcriptEntryCounts = new Map<string, { size: number; count: number }>()
  private static readonly TRANSCRIPT_CACHE_LIMIT = 8
  /** Turn indexes are ~26KB each; more slots than transcripts, far cheaper. */
  private static readonly TURN_INDEX_CACHE_LIMIT = 32
  /**
   * Fired after a turn reaches a terminal state — the same three events that
   * set `lastTurnEndedAt`. Deliberately distinct from `Agent.onStateChange`,
   * which fires per streamed token.
   */
  onTurnEnded?: (chatId: string) => void

  constructor(dataDir = getDataDir(homedir())) {
    this.dataDir = dataDir
    this.snapshotPath = path.join(this.dataDir, "snapshot.json")
    this.projectsLogPath = path.join(this.dataDir, "projects.jsonl")
    this.chatsLogPath = path.join(this.dataDir, "chats.jsonl")
    this.messagesLogPath = path.join(this.dataDir, "messages.jsonl")
    this.queuedMessagesLogPath = path.join(this.dataDir, "queued-messages.jsonl")
    this.turnsLogPath = path.join(this.dataDir, "turns.jsonl")
    this.transcriptsDir = path.join(this.dataDir, "transcripts")
    this.sidebarProjectOrderPath = path.join(this.dataDir, SIDEBAR_PROJECT_ORDER_FILE)
  }

  private transcriptsDirReady = false

  private async ensureTranscriptsDir() {
    if (this.transcriptsDirReady) return
    await mkdir(this.transcriptsDir, { recursive: true })
    this.transcriptsDirReady = true
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true })
    await this.ensureTranscriptsDir()
    await this.ensureFile(this.projectsLogPath)
    await this.ensureFile(this.chatsLogPath)
    await this.ensureFile(this.messagesLogPath)
    await this.ensureFile(this.queuedMessagesLogPath)
    await this.ensureFile(this.turnsLogPath)
    await this.loadSnapshot()
    await this.replayLogs()
    await this.hydrateChatMetadataFromTranscripts()
    await this.loadSidebarProjectOrder()
    if (!(await this.hasLegacyTranscriptData()) && await this.shouldCompact()) {
      await this.compact()
    }
  }

  /**
   * Chat metadata derived from transcript entries (lastMessageAt, hasMessages,
   * message previews) is applied in memory on append and only persisted when a
   * snapshot compaction runs. Rebuild it from the transcript files on boot so
   * restarts between compactions don't regress it.
   */
  private async hydrateChatMetadataFromTranscripts() {
    const chats = [...this.state.chatsById.values()].filter((chat) => !chat.deletedAt)
    await Promise.all(chats.map(async (chat) => {
      try {
        const file = Bun.file(this.transcriptPath(chat.id))
        if (!(await file.exists())) return
        const start = Math.max(0, file.size - TRANSCRIPT_METADATA_TAIL_BYTES)
        const text = await file.slice(start).text()
        const lines = text.split("\n")
        if (start > 0) {
          // The slice may begin mid-line; drop the partial first line.
          lines.shift()
        }
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            this.applyMessageMetadata(chat.id, JSON.parse(line) as TranscriptEntry)
          } catch {
            // Skip partial or corrupt lines (e.g. an append cut off by a crash).
          }
        }
      } catch {
        // Metadata hydration is best-effort; the transcript itself is untouched.
      }
    }))
  }

  private async ensureFile(filePath: string) {
    const file = Bun.file(filePath)
    if (!(await file.exists())) {
      await Bun.write(filePath, "")
    }
  }

  private async clearStorage() {
    if (this.storageReset) return
    this.storageReset = true
    this.resetState()
    this.clearLegacyTranscriptState()
    await Promise.all([
      Bun.write(this.snapshotPath, ""),
      Bun.write(this.projectsLogPath, ""),
      Bun.write(this.chatsLogPath, ""),
      Bun.write(this.messagesLogPath, ""),
      Bun.write(this.queuedMessagesLogPath, ""),
      Bun.write(this.turnsLogPath, ""),
    ])
  }

  private async loadSnapshot() {
    const file = Bun.file(this.snapshotPath)
    if (!(await file.exists())) return

    try {
      const text = await file.text()
      if (!text.trim()) return
      const parsed = JSON.parse(text) as SnapshotFile
      if (parsed.v !== STORE_VERSION) {
        console.warn(`${LOG_PREFIX} Resetting local chat history for store version ${STORE_VERSION}`)
        await this.clearStorage()
        return
      }
      for (const project of parsed.projects) {
        this.state.projectsById.set(project.id, { ...project })
        this.state.projectIdsByPath.set(project.localPath, project.id)
      }
      for (const chat of parsed.chats) {
        this.state.chatsById.set(chat.id, {
          ...chat,
          unread: chat.unread ?? false,
          readAnchor: chat.readAnchor ?? null,
          pendingForkSessionToken: chat.pendingForkSessionToken ?? null,
        })
      }
      this.legacySidebarProjectOrder = normalizeSidebarProjectOrder(parsed.sidebarProjectOrder)
      if (parsed.queuedMessages?.length) {
        for (const queuedSet of parsed.queuedMessages) {
          this.state.queuedMessagesByChatId.set(queuedSet.chatId, queuedSet.entries.map((entry) => ({
            ...entry,
            attachments: [...entry.attachments],
          })))
        }
      }
      if (parsed.messages?.length) {
        this.snapshotHasLegacyMessages = true
        for (const messageSet of parsed.messages) {
          this.legacyMessagesByChatId.set(messageSet.chatId, cloneTranscriptEntries(messageSet.entries))
        }
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to load snapshot, resetting local history:`, error)
      await this.clearStorage()
    }
  }

  private resetState() {
    this.state.projectsById.clear()
    this.state.projectIdsByPath.clear()
    this.state.chatsById.clear()
    this.state.queuedMessagesByChatId.clear()
    this.sidebarProjectOrder = []
    this.legacySidebarProjectOrder = []
    this.transcriptCache.clear()
    this.transcriptEntryCounts.clear()
    this.turnIndexes.clear()
  }

  private clearLegacyTranscriptState() {
    this.legacyMessagesByChatId.clear()
    this.snapshotHasLegacyMessages = false
  }

  private async loadSidebarProjectOrder() {
    const file = Bun.file(this.sidebarProjectOrderPath)
    if (await file.exists()) {
      try {
        const text = await file.text()
        if (!text.trim()) {
          this.sidebarProjectOrder = []
          return
        }
        this.sidebarProjectOrder = normalizeSidebarProjectOrder(JSON.parse(text))
      } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to load ${SIDEBAR_PROJECT_ORDER_FILE}, ignoring saved order:`, error)
        this.sidebarProjectOrder = []
      }
      return
    }

    const legacySidebarProjectOrder = await this.loadLegacySidebarProjectOrder()
    this.sidebarProjectOrder = legacySidebarProjectOrder
    if (legacySidebarProjectOrder.length > 0) {
      await this.writeSidebarProjectOrderFile(legacySidebarProjectOrder)
    }
  }

  private async loadLegacySidebarProjectOrder() {
    const fromProjectsLog = await this.readLegacySidebarProjectOrderFromProjectsLog()
    if (fromProjectsLog.length > 0) {
      return fromProjectsLog
    }
    return [...this.legacySidebarProjectOrder]
  }

  private async readLegacySidebarProjectOrderFromProjectsLog() {
    const file = Bun.file(this.projectsLogPath)
    if (!(await file.exists())) return []

    const text = await file.text()
    if (!text.trim()) return []

    const lines = text.split("\n")
    let lastNonEmpty = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].trim()) {
        lastNonEmpty = index
        break
      }
    }

    let projectIds: string[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim()
      if (!line) continue
      try {
        const event = JSON.parse(line) as {
          v?: number
          type?: string
          projectIds?: unknown
        }
        if (event.v !== STORE_VERSION || event.type !== "sidebar_project_order_set") {
          continue
        }
        projectIds = normalizeSidebarProjectOrder(event.projectIds)
      } catch (error) {
        if (index === lastNonEmpty) {
          console.warn(`${LOG_PREFIX} Ignoring corrupt trailing line in ${path.basename(this.projectsLogPath)} while migrating sidebar order`)
          return projectIds
        }
        console.warn(`${LOG_PREFIX} Failed to migrate sidebar order from ${path.basename(this.projectsLogPath)}:`, error)
        return []
      }
    }

    return projectIds
  }

  private async writeSidebarProjectOrderFile(projectIds: string[]) {
    await mkdir(this.dataDir, { recursive: true })
    await writeFile(this.sidebarProjectOrderPath, `${JSON.stringify(projectIds, null, 2)}\n`, "utf8")
  }

  private async replayLogs() {
    if (this.storageReset) return
    const replayEvents = [
      ...await this.loadReplayEvents(this.projectsLogPath, 0),
      ...await this.loadReplayEvents(this.chatsLogPath, 1),
      ...await this.loadReplayEvents(this.messagesLogPath, 2),
      ...await this.loadReplayEvents(this.queuedMessagesLogPath, 3),
      ...await this.loadReplayEvents(this.turnsLogPath, 4),
    ]
    if (this.storageReset) return

    replayEvents
      .sort((left, right) => (
        left.event.timestamp - right.event.timestamp
        || getReplayEventPriority(left.event) - getReplayEventPriority(right.event)
        || left.sourceIndex - right.sourceIndex
        || left.lineIndex - right.lineIndex
      ))
      .forEach(({ event }) => {
        this.applyEvent(event)
      })
  }

  private async loadReplayEvents(filePath: string, sourceIndex: number): Promise<ParsedReplayEvent[]> {
    const file = Bun.file(filePath)
    if (!(await file.exists())) return []
    const text = await file.text()
    if (!text.trim()) return []

    const parsedEvents: ParsedReplayEvent[] = []
    const lines = text.split("\n")
    let lastNonEmpty = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].trim()) {
        lastNonEmpty = index
        break
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim()
      if (!line) continue
      try {
        const event = JSON.parse(line) as Partial<StoreEvent>
        if (event.v !== STORE_VERSION) {
          console.warn(`${LOG_PREFIX} Resetting local history from incompatible event log`)
          await this.clearStorage()
          return []
        }
        if ((event as { type?: unknown }).type === "sidebar_project_order_set") {
          continue
        }
        parsedEvents.push({
          event: event as StoreEvent,
          sourceIndex,
          lineIndex: index,
        })
      } catch (error) {
        if (index === lastNonEmpty) {
          console.warn(`${LOG_PREFIX} Ignoring corrupt trailing line in ${path.basename(filePath)}`)
          return parsedEvents
        }
        console.warn(`${LOG_PREFIX} Failed to replay ${path.basename(filePath)}, resetting local history:`, error)
        await this.clearStorage()
        return []
      }
    }

    return parsedEvents
  }

  private applyEvent(event: StoreEvent) {
    switch (event.type) {
      case "project_opened": {
        const localPath = resolveLocalPath(event.localPath)
        const project = {
          id: event.projectId,
          localPath,
          title: event.title,
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
        }
        this.state.projectsById.set(project.id, project)
        this.state.projectIdsByPath.set(localPath, project.id)
        break
      }
      case "project_removed": {
        const project = this.state.projectsById.get(event.projectId)
        if (!project) break
        project.deletedAt = event.timestamp
        project.updatedAt = event.timestamp
        this.state.projectIdsByPath.delete(project.localPath)
        break
      }
      case "project_sidebar_renamed": {
        const project = this.state.projectsById.get(event.projectId)
        if (!project) break
        if (event.title) {
          project.sidebarTitle = event.title
        } else {
          delete project.sidebarTitle
        }
        project.updatedAt = event.timestamp
        break
      }
      case "chat_created": {
      const chat = {
          id: event.chatId,
          projectId: event.projectId,
          title: event.title,
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
          unread: false,
          provider: null,
          planMode: false,
          autoPlan: false,
          sessionToken: null,
          pendingForkSessionToken: null,
          hasMessages: false,
          lastTurnOutcome: null,
          // Forks carry the source's turn-end timestamp on the create event
          // (they have no turn events of their own to replay).
          ...(event.lastTurnEndedAt != null ? { lastTurnEndedAt: event.lastTurnEndedAt } : {}),
        }
        this.state.chatsById.set(chat.id, chat)
        break
      }
      case "chat_renamed": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.title = event.title
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_deleted": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.deletedAt = event.timestamp
        chat.updatedAt = event.timestamp
        this.state.queuedMessagesByChatId.delete(event.chatId)
        break
      }
      case "chat_archived": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.archivedAt = event.timestamp
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_unarchived": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        delete chat.archivedAt
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_provider_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.provider = event.provider
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_plan_mode_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.planMode = event.planMode
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_auto_plan_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.autoPlan = event.autoPlan
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_read_state_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.unread = event.unread
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_read_anchor_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.readAnchor = {
          messageId: event.messageId,
          atEnd: event.atEnd,
          updatedAt: event.timestamp,
        }
        // Intentionally does not bump `updatedAt` — a scroll is not a chat
        // mutation, and bumping it would churn sidebar ordering/signatures.
        break
      }
      case "chat_done_state_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        if (event.done) {
          chat.doneAt = event.timestamp
        } else {
          delete chat.doneAt
        }
        chat.updatedAt = event.timestamp
        break
      }
      case "message_appended": {
        this.applyMessageMetadata(event.chatId, event.entry)
        const existing = this.legacyMessagesByChatId.get(event.chatId) ?? []
        existing.push({ ...event.entry })
        this.legacyMessagesByChatId.set(event.chatId, existing)
        break
      }
      case "queued_message_enqueued": {
        const existing = this.state.queuedMessagesByChatId.get(event.chatId) ?? []
        existing.push({
          ...event.message,
          attachments: [...event.message.attachments],
        })
        this.state.queuedMessagesByChatId.set(event.chatId, existing)
        const chat = this.state.chatsById.get(event.chatId)
        if (chat) {
          chat.updatedAt = event.timestamp
        }
        break
      }
      case "queued_message_removed": {
        const existing = this.state.queuedMessagesByChatId.get(event.chatId) ?? []
        const next = existing.filter((entry) => entry.id !== event.queuedMessageId)
        if (next.length > 0) {
          this.state.queuedMessagesByChatId.set(event.chatId, next)
        } else {
          this.state.queuedMessagesByChatId.delete(event.chatId)
        }
        const chat = this.state.chatsById.get(event.chatId)
        if (chat) {
          chat.updatedAt = event.timestamp
        }
        break
      }
      case "turn_started": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.updatedAt = event.timestamp
        // A new turn means the user re-engaged, so the chat is no longer "done".
        delete chat.doneAt
        break
      }
      case "turn_finished": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.updatedAt = event.timestamp
        chat.unread = true
        chat.lastTurnOutcome = "success"
        chat.lastTurnEndedAt = event.timestamp
        break
      }
      case "turn_failed": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.updatedAt = event.timestamp
        chat.unread = true
        chat.lastTurnOutcome = "failed"
        chat.lastTurnEndedAt = event.timestamp
        break
      }
      case "turn_cancelled": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.updatedAt = event.timestamp
        chat.lastTurnOutcome = "cancelled"
        chat.lastTurnEndedAt = event.timestamp
        break
      }
      case "session_token_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.sessionToken = event.sessionToken
        chat.updatedAt = event.timestamp
        break
      }
      case "pending_fork_session_token_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.pendingForkSessionToken = event.pendingForkSessionToken
        chat.updatedAt = event.timestamp
        break
      }
    }
  }

  private applyMessageMetadata(chatId: string, entry: TranscriptEntry) {
    const chat = this.state.chatsById.get(chatId)
    if (!chat) return
    chat.hasMessages = true
    if (entry.kind === "user_prompt") {
      chat.lastMessageAt = entry.createdAt
      if (!entry.hidden) {
        const preview = buildChatMessagePreview(entry.content)
        if (preview) chat.lastUserMessagePreview = preview
      }
    } else if (entry.kind === "assistant_text" && !entry.hidden) {
      const preview = buildChatMessagePreview(entry.text)
      if (preview) chat.lastAgentMessagePreview = preview
    }
    if (isAgentAuthoredEntry(entry)) {
      // Hidden entries count: this is "when did the agent last do something",
      // not "what can we show" — same split as lastMessageAt vs its preview.
      chat.lastAgentMessageAt = Math.max(chat.lastAgentMessageAt ?? 0, entry.createdAt)
    }
    chat.updatedAt = Math.max(chat.updatedAt, entry.createdAt)
  }

  private append<TEvent extends StoreEvent>(filePath: string, event: TEvent) {
    const payload = `${JSON.stringify(event)}\n`
    this.writeChain = this.writeChain.then(async () => {
      await appendFile(filePath, payload, "utf8")
      this.applyEvent(event)
    })
    return this.writeChain
  }

  private transcriptPath(chatId: string) {
    return path.join(this.transcriptsDir, `${chatId}.jsonl`)
  }

  /** Absolute path of a chat's JSONL transcript (may not exist yet for a fresh chat). */
  getTranscriptPath(chatId: string) {
    return this.transcriptPath(chatId)
  }

  /**
   * The complete entry list for a chat, loading from disk on miss. Callers
   * must not mutate.
   *
   * Use `getRecentMessagesPage` for rendering — it serves the tail without
   * reading the whole file. This is for the callers that genuinely need every
   * entry (export, handoff, anchor resolution, debugRaw lookup).
   */
  private getTranscriptEntries(chatId: string): TranscriptEntry[] {
    const cached = this.transcriptCache.get(chatId)
    if (cached && cached.startIndex === 0) {
      // Refresh LRU recency.
      this.transcriptCache.delete(chatId)
      this.transcriptCache.set(chatId, cached)
      return cached.entries
    }

    const legacyEntries = this.legacyMessagesByChatId.get(chatId)
    const entries = legacyEntries ? cloneTranscriptEntries(legacyEntries) : this.loadTranscriptFromDisk(chatId)
    // Replaces any cached suffix — a complete list supersedes it.
    this.setCachedTranscript(chatId, entries, 0)
    return entries
  }

  private setCachedTranscript(chatId: string, entries: TranscriptEntry[], startIndex: number) {
    this.transcriptCache.delete(chatId)
    while (this.transcriptCache.size >= EventStore.TRANSCRIPT_CACHE_LIMIT) {
      const oldest = this.transcriptCache.keys().next().value
      if (oldest === undefined) break
      this.transcriptCache.delete(oldest)
    }
    this.transcriptCache.set(chatId, { entries, startIndex })
  }

  /**
   * Count non-empty lines by scanning bytes, without parsing them.
   *
   * Needed once per chat so a tail read can place its window at an absolute
   * index. Costs a read of the file (~8ms for 24MB) but skips the JSON parse
   * that dominates a full load; after that the count is maintained by
   * `appendMessage`.
   */
  private countTranscriptEntries(chatId: string): number {
    const transcriptPath = this.transcriptPath(chatId)
    if (!existsSync(transcriptPath)) return 0

    // Keyed by size so widening a window (which reads the tail again) doesn't
    // re-scan the file. Appends invalidate it, but streaming reads are served
    // from the cached window and never land here.
    const size = Bun.file(transcriptPath).size
    const cached = this.transcriptEntryCounts.get(chatId)
    if (cached && cached.size === size) return cached.count

    const buffer = readFileSyncImmediate(transcriptPath)
    let count = 0
    let lineStart = 0
    for (;;) {
      const newline = buffer.indexOf(0x0a, lineStart)
      const end = newline === -1 ? buffer.length : newline
      // Only short segments can be blank; a serialized entry is far longer, so
      // this keeps the scan in `indexOf`'s native memchr rather than a JS loop
      // over every byte.
      if (end - lineStart >= BLANK_LINE_MAX_BYTES || !isBlankRange(buffer, lineStart, end)) {
        count++
      }
      if (newline === -1) break
      lineStart = newline + 1
      if (lineStart >= buffer.length) break
    }
    this.transcriptEntryCounts.set(chatId, { size, count })
    return count
  }

  /**
   * Read at least `limit` entries from the end of a transcript.
   *
   * Reads a tail chunk and grows it until enough complete lines are in hand,
   * so a chat open parses a few hundred entries instead of every entry in the
   * file. Returns null when the file is missing or a line fails to parse, so
   * the caller can fall back to a full load.
   */
  private readTranscriptTail(chatId: string, limit: number): TranscriptEntry[] | null {
    const transcriptPath = this.transcriptPath(chatId)
    if (!existsSync(transcriptPath)) return null

    let fd: number
    try {
      fd = openSync(transcriptPath, "r")
    } catch {
      return null
    }

    try {
      const size = fstatSync(fd).size
      if (size === 0) return []

      let chunk = Math.min(size, TRANSCRIPT_TAIL_CHUNK_BYTES)
      for (;;) {
        const start = Math.max(0, size - chunk)
        const buffer = Buffer.allocUnsafe(size - start)
        readSync(fd, buffer, 0, buffer.length, start)

        const lines = buffer.toString("utf8").split("\n")
        // A non-zero offset may land mid-line; that partial line (and any
        // broken multi-byte char in it) is dropped.
        if (start > 0) lines.shift()
        const usable = lines.filter((line) => line.trim())

        if (usable.length >= limit || start === 0) {
          try {
            return usable.slice(-limit).map((line) => JSON.parse(line) as TranscriptEntry)
          } catch {
            return null
          }
        }
        chunk = Math.min(size, chunk * 4)
      }
    } catch {
      return null
    } finally {
      closeSync(fd)
    }
  }

  /**
   * Turn index for a chat, built on first request and extended on append.
   *
   * The cold build streams the file and keeps only summaries — deliberately
   * not via `getTranscriptEntries`, which would cache the full entry list and
   * evict the hot tail window that streaming reads depend on. Summaries are
   * small enough to hold for every open chat; entries are not.
   */
  getChatTurnIndex(chatId: string): ChatTurnSummary[] {
    const cached = this.turnIndexes.get(chatId)
    if (cached) {
      // Refresh LRU recency.
      this.turnIndexes.delete(chatId)
      this.turnIndexes.set(chatId, cached)
      return cached
    }

    const turns: ChatTurnSummary[] = []
    const transcriptPath = this.transcriptPath(chatId)
    const legacyEntries = this.legacyMessagesByChatId.get(chatId)

    if (legacyEntries) {
      for (const entry of legacyEntries) appendTurnEntry(turns, entry)
    } else if (existsSync(transcriptPath)) {
      turns.push(...buildTurnIndexFromBuffer(readFileSyncImmediate(transcriptPath)))
    }

    this.setCachedTurnIndex(chatId, turns)
    return turns
  }

  /**
   * Bounded like the transcript cache: an index is small, but one per chat
   * over a long session is unbounded growth for maps nobody is looking at.
   * Evicting only costs the next open a rebuild.
   */
  private setCachedTurnIndex(chatId: string, turns: ChatTurnSummary[]) {
    this.turnIndexes.delete(chatId)
    while (this.turnIndexes.size >= EventStore.TURN_INDEX_CACHE_LIMIT) {
      const oldest = this.turnIndexes.keys().next().value
      if (oldest === undefined) break
      this.turnIndexes.delete(oldest)
    }
    this.turnIndexes.set(chatId, turns)
  }

  private loadTranscriptFromDisk(chatId: string) {
    const transcriptPath = this.transcriptPath(chatId)
    if (!existsSync(transcriptPath)) {
      return []
    }

    const text = readFileSyncImmediate(transcriptPath, "utf8")
    if (!text.trim()) return []

    const entries: TranscriptEntry[] = []
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim()
      if (!line) continue
      entries.push(JSON.parse(line) as TranscriptEntry)
    }
    return entries
  }

  async openProject(localPath: string, title?: string) {
    const normalized = resolveLocalPath(localPath)
    const existingId = this.state.projectIdsByPath.get(normalized)
    if (existingId) {
      const existing = this.state.projectsById.get(existingId)
      if (existing && !existing.deletedAt) {
        return existing
      }
    }

    const hiddenProject = [...this.state.projectsById.values()]
      .find((project) => project.localPath === normalized && project.deletedAt)
    const projectId = hiddenProject?.id ?? crypto.randomUUID()
    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_opened",
      timestamp: Date.now(),
      projectId,
      localPath: normalized,
      title: title?.trim() || path.basename(normalized) || normalized,
    }
    await this.append(this.projectsLogPath, event)
    return this.state.projectsById.get(projectId)!
  }

  async removeProject(projectId: string) {
    const project = this.getProject(projectId)
    if (!project) {
      throw new Error("Project not found")
    }

    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_removed",
      timestamp: Date.now(),
      projectId,
    }
    await this.append(this.projectsLogPath, event)
  }

  async renameProjectSidebarTitle(projectId: string, title: string) {
    const trimmed = title.trim()
    const project = this.getProject(projectId)
    if (!project) {
      throw new Error("Project not found")
    }
    const nextTitle = trimmed || null
    if ((project.sidebarTitle ?? null) === nextTitle) return

    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_sidebar_renamed",
      timestamp: Date.now(),
      projectId,
      title: nextTitle,
    }
    await this.append(this.projectsLogPath, event)
  }

  async setSidebarProjectOrder(projectIds: string[]) {
    const validProjectIds = projectIds.filter((projectId) => {
      const project = this.state.projectsById.get(projectId)
      return Boolean(project && !project.deletedAt)
    })

    const uniqueProjectIds = [...new Set(validProjectIds)]
    const current = this.sidebarProjectOrder
    if (
      uniqueProjectIds.length === current.length
      && uniqueProjectIds.every((projectId, index) => current[index] === projectId)
    ) {
      return
    }

    this.writeChain = this.writeChain.then(async () => {
      await this.writeSidebarProjectOrderFile(uniqueProjectIds)
      this.sidebarProjectOrder = [...uniqueProjectIds]
    })
    return this.writeChain
  }

  async createChat(projectId: string) {
    const project = this.state.projectsById.get(projectId)
    if (!project || project.deletedAt) {
      throw new Error("Project not found")
    }
    const chatId = crypto.randomUUID()
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_created",
      timestamp: Date.now(),
      chatId,
      projectId,
      title: "New Chat",
    }
    await this.append(this.chatsLogPath, event)
    return this.state.chatsById.get(chatId)!
  }

  async forkChat(sourceChatId: string) {
    const sourceChat = this.requireChat(sourceChatId)
    const sourceSessionToken = sourceChat.sessionToken ?? sourceChat.pendingForkSessionToken ?? null
    if (!sourceChat.provider || !sourceSessionToken) {
      throw new Error("Chat cannot be forked")
    }

    const chatId = crypto.randomUUID()
    const createdAt = Date.now()
    const createEvent: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_created",
      timestamp: createdAt,
      chatId,
      projectId: sourceChat.projectId,
      title: getForkedChatTitle(sourceChat.title),
      // Same project, same tree, same last turn — so the fork derives the same
      // `uncommittedWork` flag as its source and stays in Relevant instead of
      // falling into a date bucket the moment it's created.
      ...(sourceChat.lastTurnEndedAt != null ? { lastTurnEndedAt: sourceChat.lastTurnEndedAt } : {}),
    }
    await this.append(this.chatsLogPath, createEvent)
    await this.setChatProvider(chatId, sourceChat.provider)
    await this.setPlanMode(chatId, sourceChat.planMode)
    await this.setAutoPlan(chatId, sourceChat.autoPlan)
    await this.setPendingForkSessionToken(chatId, sourceSessionToken)

    const sourceEntries = this.getMessages(sourceChatId)
    if (sourceEntries.length > 0) {
      const transcriptPath = this.transcriptPath(chatId)
      const payload = sourceEntries.map((entry) => JSON.stringify(entry)).join("\n")
      this.writeChain = this.writeChain.then(async () => {
        await this.ensureTranscriptsDir()
        await writeFile(transcriptPath, `${payload}\n`, "utf8")
        const chat = this.state.chatsById.get(chatId)
        if (chat) {
          chat.hasMessages = true
          chat.updatedAt = Math.max(chat.updatedAt, createdAt)
          // Mirror what a transcript reload would derive: the fork inherits
          // the copied conversation's recency and previews. Without
          // lastMessageAt the fork reads as an empty draft and stays hidden
          // from recency-driven sidebar sections until its first new message.
          const lastEntryAt = sourceEntries[sourceEntries.length - 1]?.createdAt
          if (lastEntryAt != null) {
            chat.lastMessageAt = Math.max(chat.lastMessageAt ?? 0, lastEntryAt)
          }
          if (sourceChat.lastUserMessagePreview) chat.lastUserMessagePreview = sourceChat.lastUserMessagePreview
          if (sourceChat.lastAgentMessagePreview) chat.lastAgentMessagePreview = sourceChat.lastAgentMessagePreview
          // Same transcript, so the same last-agent-activity timestamp a
          // reload would derive from it.
          if (sourceChat.lastAgentMessageAt != null) {
            chat.lastAgentMessageAt = Math.max(chat.lastAgentMessageAt ?? 0, sourceChat.lastAgentMessageAt)
          }
        }
        // The fork's transcript is the source's in full, so this is complete.
        this.setCachedTranscript(chatId, cloneTranscriptEntries(sourceEntries), 0)
      })
      await this.writeChain
    }

    return this.state.chatsById.get(chatId)!
  }

  async renameChat(chatId: string, title: string) {
    const trimmed = title.trim()
    if (!trimmed) return
    const chat = this.requireChat(chatId)
    if (chat.title === trimmed) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_renamed",
      timestamp: Date.now(),
      chatId,
      title: trimmed,
    }
    await this.append(this.chatsLogPath, event)
  }

  async deleteChat(chatId: string) {
    this.requireChat(chatId)
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_deleted",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.chatsLogPath, event)
  }

  async archiveChat(chatId: string) {
    this.requireChat(chatId)
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_archived",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.chatsLogPath, event)
  }

  async unarchiveChat(chatId: string) {
    this.requireChat(chatId)
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_unarchived",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.chatsLogPath, event)
  }

  async pruneStaleEmptyChats(args?: {
    now?: number
    maxAgeMs?: number
    activeChatIds?: Iterable<string>
    protectedChatIds?: Iterable<string>
  }) {
    const now = args?.now ?? Date.now()
    const maxAgeMs = args?.maxAgeMs ?? STALE_EMPTY_CHAT_MAX_AGE_MS
    const protectedChatIds = new Set([
      ...(args?.activeChatIds ?? []),
      ...(args?.protectedChatIds ?? []),
    ])
    const prunedChatIds: string[] = []

    for (const chat of this.state.chatsById.values()) {
      if (chat.deletedAt || chat.archivedAt || protectedChatIds.has(chat.id)) continue
      if (now - chat.createdAt < maxAgeMs) continue
      if (chat.hasMessages) continue
      // Peek without inserting into the transcript cache — the prune sweep
      // must not evict actively streaming chats.
      const entries = this.transcriptCache.get(chat.id)?.entries
        ?? this.legacyMessagesByChatId.get(chat.id)
        ?? this.loadTranscriptFromDisk(chat.id)
      if (entries.length > 0) {
        chat.hasMessages = true
        continue
      }

      const event: ChatEvent = {
        v: STORE_VERSION,
        type: "chat_deleted",
        timestamp: now,
        chatId: chat.id,
      }
      await this.append(this.chatsLogPath, event)

      const transcriptPath = this.transcriptPath(chat.id)
      await rm(transcriptPath, { force: true })
      this.transcriptCache.delete(chat.id)
      this.transcriptEntryCounts.delete(chat.id)
      this.turnIndexes.delete(chat.id)

      prunedChatIds.push(chat.id)
    }

    return prunedChatIds
  }

  /**
   * The most recent activity across all live chats — the reference point the
   * staleness sweeps measure against. Anchoring to the user's own activity
   * (never the wall clock) means an idle month away moves nothing: chats only
   * become "stale" relative to newer work, not relative to time passing.
   */
  private latestChatActivityAt(): number | null {
    let latest: number | null = null
    for (const chat of this.state.chatsById.values()) {
      if (chat.deletedAt) continue
      const at = chat.lastMessageAt ?? chat.createdAt
      if (latest == null || at > latest) latest = at
    }
    return latest
  }

  /**
   * Garbage-collects long-idle chats by archiving (not deleting) them: any
   * chat whose last activity is more than `maxAgeMs` behind the user's latest
   * chat activity and that isn't already archived/deleted, protected, or
   * empty. Empty stale chats are left for pruneStaleEmptyChats to
   * hard-delete. Sending a message unarchives, so this is non-destructive
   * housekeeping.
   */
  async autoArchiveStaleChats(args?: {
    now?: number
    maxAgeMs?: number
    activeChatIds?: Iterable<string>
    protectedChatIds?: Iterable<string>
  }) {
    const now = args?.now ?? Date.now()
    const maxAgeMs = args?.maxAgeMs ?? STALE_CHAT_AUTO_ARCHIVE_MAX_AGE_MS
    // min() guards against clock skew pushing a chat timestamp into the future.
    const reference = Math.min(now, this.latestChatActivityAt() ?? now)
    const protectedChatIds = new Set([
      ...(args?.activeChatIds ?? []),
      ...(args?.protectedChatIds ?? []),
    ])
    const archivedChatIds: string[] = []

    for (const chat of this.state.chatsById.values()) {
      if (chat.deletedAt || chat.archivedAt || protectedChatIds.has(chat.id)) continue
      // Empty chats are the prune sweep's job (hard delete), not ours.
      if (!chat.hasMessages && chat.lastMessageAt == null) continue
      const lastActivityAt = chat.lastMessageAt ?? chat.createdAt
      if (reference - lastActivityAt < maxAgeMs) continue

      const event: ChatEvent = {
        v: STORE_VERSION,
        type: "chat_archived",
        timestamp: now,
        chatId: chat.id,
      }
      await this.append(this.chatsLogPath, event)
      archivedChatIds.push(chat.id)
    }

    return archivedChatIds
  }

  /**
   * Hard-deletes long-idle chats — archived or not — whose last activity is
   * more than `maxAgeMs` behind the user's latest chat activity, reclaiming
   * their transcript files. The end of the lifecycle after auto-archive;
   * protected (active/draft) chats are spared.
   */
  async deleteStaleChats(args?: {
    now?: number
    maxAgeMs?: number
    activeChatIds?: Iterable<string>
    protectedChatIds?: Iterable<string>
  }) {
    const now = args?.now ?? Date.now()
    const maxAgeMs = args?.maxAgeMs ?? STALE_CHAT_DELETE_MAX_AGE_MS
    // min() guards against clock skew pushing a chat timestamp into the future.
    const reference = Math.min(now, this.latestChatActivityAt() ?? now)
    const protectedChatIds = new Set([
      ...(args?.activeChatIds ?? []),
      ...(args?.protectedChatIds ?? []),
    ])
    const deletedChatIds: string[] = []

    for (const chat of this.state.chatsById.values()) {
      if (chat.deletedAt || protectedChatIds.has(chat.id)) continue
      const lastActivityAt = chat.lastMessageAt ?? chat.createdAt
      if (reference - lastActivityAt < maxAgeMs) continue

      const event: ChatEvent = {
        v: STORE_VERSION,
        type: "chat_deleted",
        timestamp: now,
        chatId: chat.id,
      }
      await this.append(this.chatsLogPath, event)

      const transcriptPath = this.transcriptPath(chat.id)
      await rm(transcriptPath, { force: true })
      this.transcriptCache.delete(chat.id)
      this.transcriptEntryCounts.delete(chat.id)
      this.turnIndexes.delete(chat.id)

      deletedChatIds.push(chat.id)
    }

    return deletedChatIds
  }

  async setChatProvider(chatId: string, provider: AgentProvider) {
    const chat = this.requireChat(chatId)
    if (chat.provider === provider) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_provider_set",
      timestamp: Date.now(),
      chatId,
      provider,
    }
    await this.append(this.chatsLogPath, event)
  }

  async setPlanMode(chatId: string, planMode: boolean) {
    const chat = this.requireChat(chatId)
    if (chat.planMode === planMode) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_plan_mode_set",
      timestamp: Date.now(),
      chatId,
      planMode,
    }
    await this.append(this.chatsLogPath, event)
  }

  async setAutoPlan(chatId: string, autoPlan: boolean) {
    const chat = this.requireChat(chatId)
    if (chat.autoPlan === autoPlan) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_auto_plan_set",
      timestamp: Date.now(),
      chatId,
      autoPlan,
    }
    await this.append(this.chatsLogPath, event)
  }

  async setChatReadState(chatId: string, unread: boolean) {
    const chat = this.requireChat(chatId)
    if (chat.unread === unread) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_read_state_set",
      timestamp: Date.now(),
      chatId,
      unread,
    }
    await this.append(this.chatsLogPath, event)
  }

  async setChatDoneState(chatId: string, done: boolean) {
    const chat = this.requireChat(chatId)
    if (Boolean(chat.doneAt) === done) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_done_state_set",
      timestamp: Date.now(),
      chatId,
      done,
    }
    await this.append(this.chatsLogPath, event)
  }

  /**
   * Persist where the user left off reading. Called on a throttle from the
   * client as it scrolls, so the no-op guard below matters — it is the only
   * write rate-limit in the store.
   */
  async setChatReadAnchor(chatId: string, messageId: string, atEnd: boolean) {
    const chat = this.requireChat(chatId)
    if (chat.readAnchor?.messageId === messageId && chat.readAnchor.atEnd === atEnd) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_read_anchor_set",
      timestamp: Date.now(),
      chatId,
      messageId,
      atEnd,
    }
    await this.append(this.chatsLogPath, event)
  }

  /**
   * Resolve a chat's stored read anchor against the current transcript.
   * Returns null when nothing is stored or the anchored message no longer
   * exists (deleted, or compacted away), so the client can fall back.
   *
   * `distanceFromEnd` lets the client widen its subscription window in one
   * round trip when the anchor sits outside the default recent page.
   */
  getChatReadAnchor(chatId: string): ResolvedChatReadAnchor | null {
    const chat = this.requireChat(chatId)
    const anchor = chat.readAnchor
    if (!anchor) return null

    const entries = this.getTranscriptEntries(chatId)
    const index = entries.findIndex((entry) => entry._id === anchor.messageId)
    if (index === -1) return null

    return {
      messageId: anchor.messageId,
      atEnd: anchor.atEnd,
      distanceFromEnd: entries.length - index,
    }
  }

  /**
   * `_id` of the entry at an absolute index, or null when the index is out of
   * range or sits before the loaded window.
   *
   * Deliberately refuses to widen the window to answer: this exists to check a
   * client's cached position, and a cache that reaches further back than the
   * server is holding is not worth a full transcript read to validate — the
   * caller just sends a full window instead.
   */
  getEntryIdAt(chatId: string, index: number): string | null {
    if (index < 0) return null
    const cached = this.transcriptCache.get(chatId)
    if (!cached) return null
    const offset = index - cached.startIndex
    if (offset < 0 || offset >= cached.entries.length) return null
    return cached.entries[offset]?._id ?? null
  }

  /**
   * Entries by id, with their payloads intact.
   *
   * Backs the tool-payload fetch: snapshots ship tool calls and results without
   * their unbounded fields, and a row that gets opened asks for the real thing.
   * Batched because expanding a tool group asks for every member at once.
   * `debugRaw` is stripped as everywhere else on the wire — the raw JSON view
   * has its own request for that.
   *
   * Ids that no longer exist are simply absent from the result.
   */
  getEntriesById(chatId: string, entryIds: string[]): TranscriptEntry[] {
    this.requireChat(chatId)
    if (entryIds.length === 0) return []
    const wanted = new Set(entryIds)
    const found: TranscriptEntry[] = []
    for (const entry of this.getTranscriptEntries(chatId)) {
      if (!wanted.has(entry._id)) continue
      const { debugRaw, ...rest } = entry
      found.push(rest as TranscriptEntry)
      if (found.length === wanted.size) break
    }
    return found
  }

  /**
   * The raw provider payload for one entry, or null if the entry is gone or
   * never carried one. Snapshots strip `debugRaw`; this backs the raw JSON
   * debug view, which is opened rarely enough that a full transcript read is
   * an acceptable cost.
   */
  getEntryDebugRaw(chatId: string, entryId: string): string | null {
    this.requireChat(chatId)
    const entries = this.getTranscriptEntries(chatId)
    return entries.find((entry) => entry._id === entryId)?.debugRaw ?? null
  }

  async appendMessage(chatId: string, entry: TranscriptEntry) {
    this.requireChat(chatId)
    const payload = `${JSON.stringify(entry)}\n`
    const transcriptPath = this.transcriptPath(chatId)
    this.writeChain = this.writeChain.then(async () => {
      await this.ensureTranscriptsDir()
      await appendFile(transcriptPath, payload, "utf8")
      this.applyMessageMetadata(chatId, entry)
      // Deep clone via the already-serialized payload: the cached entry is
      // byte-identical to what a cold disk read would produce, and callers
      // that keep mutating their entry can't alias into the cache.
      // Extends a cached suffix as happily as a complete list — `startIndex`
      // is unaffected by appending at the end.
      this.transcriptCache.get(chatId)?.entries.push(JSON.parse(payload) as TranscriptEntry)
      // Extend the turn index only if it has been built. An absent index is
      // not stale — it gets built on demand, and this entry is on disk by
      // then, so building it here would just be work nobody asked for.
      const turns = this.turnIndexes.get(chatId)
      if (turns) appendTurnEntry(turns, entry)
    })
    return this.writeChain
  }

  async enqueueMessage(chatId: string, message: Omit<QueuedChatMessage, "id" | "createdAt"> & Partial<Pick<QueuedChatMessage, "id" | "createdAt">>) {
    this.requireChat(chatId)
    const queuedMessage: QueuedChatMessage = {
      id: message.id ?? crypto.randomUUID(),
      content: message.content,
      attachments: [...(message.attachments ?? [])],
      createdAt: message.createdAt ?? Date.now(),
      provider: message.provider,
      model: message.model,
      modelOptions: message.modelOptions,
      planMode: message.planMode,
      autoPlan: message.autoPlan,
    }
    const event: QueuedMessageEvent = {
      v: STORE_VERSION,
      type: "queued_message_enqueued",
      timestamp: queuedMessage.createdAt,
      chatId,
      message: queuedMessage,
    }
    await this.append(this.queuedMessagesLogPath, event)
    return queuedMessage
  }

  async removeQueuedMessage(chatId: string, queuedMessageId: string) {
    this.requireChat(chatId)
    const existing = this.getQueuedMessages(chatId)
    if (!existing.some((entry) => entry.id === queuedMessageId)) {
      throw new Error("Queued message not found")
    }
    const event: QueuedMessageEvent = {
      v: STORE_VERSION,
      type: "queued_message_removed",
      timestamp: Date.now(),
      chatId,
      queuedMessageId,
    }
    await this.append(this.queuedMessagesLogPath, event)
  }

  async recordTurnStarted(chatId: string) {
    this.requireChat(chatId)
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "turn_started",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.turnsLogPath, event)
  }

  async recordTurnFinished(chatId: string) {
    this.requireChat(chatId)
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "turn_finished",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.turnsLogPath, event)
    this.onTurnEnded?.(chatId)
  }

  async recordTurnFailed(chatId: string, error: string) {
    this.requireChat(chatId)
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "turn_failed",
      timestamp: Date.now(),
      chatId,
      error,
    }
    await this.append(this.turnsLogPath, event)
    this.onTurnEnded?.(chatId)
  }

  async recordTurnCancelled(chatId: string) {
    this.requireChat(chatId)
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "turn_cancelled",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.turnsLogPath, event)
    this.onTurnEnded?.(chatId)
  }

  async setSessionToken(chatId: string, sessionToken: string | null) {
    const chat = this.requireChat(chatId)
    if (chat.sessionToken === sessionToken) return
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "session_token_set",
      timestamp: Date.now(),
      chatId,
      sessionToken,
    }
    await this.append(this.turnsLogPath, event)
  }

  async setPendingForkSessionToken(chatId: string, pendingForkSessionToken: string | null) {
    const chat = this.requireChat(chatId)
    if ((chat.pendingForkSessionToken ?? null) === pendingForkSessionToken) return
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "pending_fork_session_token_set",
      timestamp: Date.now(),
      chatId,
      pendingForkSessionToken,
    }
    await this.append(this.turnsLogPath, event)
  }

  getProject(projectId: string) {
    const project = this.state.projectsById.get(projectId)
    if (!project || project.deletedAt) return null
    return project
  }

  requireChat(chatId: string) {
    const chat = this.state.chatsById.get(chatId)
    if (!chat || chat.deletedAt) {
      throw new Error("Chat not found")
    }
    return chat
  }

  getChat(chatId: string) {
    const chat = this.state.chatsById.get(chatId)
    if (!chat || chat.deletedAt) return null
    return chat
  }

  getSidebarProjectOrder() {
    return [...this.sidebarProjectOrder]
  }

  private getMessagesPageFromEntries(entries: TranscriptEntry[], limit: number, beforeIndex?: number): TranscriptPageResult {
    if (entries.length === 0) {
      return { entries: [], hasOlder: false, olderCursor: null }
    }

    const endIndex = beforeIndex === undefined ? entries.length : Math.max(0, Math.min(beforeIndex, entries.length))
    const startIndex = Math.max(0, endIndex - limit)
    return {
      entries: cloneTranscriptEntriesForClient(entries.slice(startIndex, endIndex)),
      hasOlder: startIndex > 0,
      olderCursor: startIndex > 0 ? encodeHistoryCursor(startIndex) : null,
    }
  }

  getMessages(chatId: string) {
    return cloneTranscriptEntries(this.getTranscriptEntries(chatId))
  }

  getQueuedMessages(chatId: string) {
    const entries = this.state.queuedMessagesByChatId.get(chatId) ?? []
    return entries.map((entry) => ({
      ...entry,
      attachments: [...entry.attachments],
    }))
  }

  getQueuedMessage(chatId: string, queuedMessageId: string) {
    return this.getQueuedMessages(chatId).find((entry) => entry.id === queuedMessageId) ?? null
  }

  getRecentMessagesPage(chatId: string, limit: number): ChatHistoryPage {
    if (limit <= 0) {
      return { messages: [], hasOlder: false, olderCursor: null, startIndex: 0 }
    }

    const window = this.getRecentEntryWindow(chatId, limit)
    const startIndex = window.startIndex + Math.max(0, window.entries.length - limit)
    const slice = window.entries.slice(Math.max(0, window.entries.length - limit))

    return {
      messages: cloneTranscriptEntriesForClient(slice),
      hasOlder: startIndex > 0,
      olderCursor: startIndex > 0 ? encodeHistoryCursor(startIndex) : null,
      startIndex,
    }
  }

  /**
   * A cached window covering at least the last `limit` entries.
   *
   * Prefers whatever is already cached (the streaming case — `appendMessage`
   * keeps it current), then a tail read, and only falls back to loading the
   * entire file when the tail read can't serve.
   */
  private getRecentEntryWindow(chatId: string, limit: number): CachedTranscript {
    const cached = this.transcriptCache.get(chatId)
    if (cached && (cached.startIndex === 0 || cached.entries.length >= limit)) {
      this.transcriptCache.delete(chatId)
      this.transcriptCache.set(chatId, cached)
      return cached
    }

    if (this.legacyMessagesByChatId.has(chatId)) {
      return { entries: this.getTranscriptEntries(chatId), startIndex: 0 }
    }

    const tail = this.readTranscriptTail(chatId, limit)
    if (tail) {
      // Only entries at or past this point are held, so the absolute index of
      // the first one is the total minus what we kept.
      const startIndex = Math.max(0, this.countTranscriptEntries(chatId) - tail.length)
      this.setCachedTranscript(chatId, tail, startIndex)
      return { entries: tail, startIndex }
    }

    return { entries: this.getTranscriptEntries(chatId), startIndex: 0 }
  }

  getMessagesPageBefore(chatId: string, beforeCursor: string, limit: number): ChatHistoryPage {
    if (limit <= 0) {
      return { messages: [], hasOlder: false, olderCursor: null, startIndex: 0 }
    }

    const beforeIndex = decodeCursor(beforeCursor)
    const page = this.getMessagesPageFromEntries(this.getTranscriptEntries(chatId), limit, beforeIndex)

    return {
      messages: page.entries,
      hasOlder: page.hasOlder,
      olderCursor: page.olderCursor,
      startIndex: beforeIndex - page.entries.length,
    }
  }

  /**
   * Recent history plus the resolved read anchor, with the window auto-sized
   * to include that anchor when `recentLimit` is left open.
   *
   * Resolving the anchor here is what lets a chat open be one round trip. The
   * common case costs nothing extra: the anchor is found in the default window
   * and no widening happens. Only an anchor scrolled back past the default
   * window triggers a second, wider read.
   */
  getRecentChatHistory(chatId: string, recentLimit?: number) {
    const stored = this.state.chatsById.get(chatId)?.readAnchor
    const baseLimit = recentLimit ?? CHAT_RECENT_LIMIT_DEFAULT
    let limit = baseLimit
    let anchor: ResolvedChatReadAnchor | null = null

    if (stored) {
      anchor = this.resolveAnchorInWindow(chatId, stored, baseLimit)
      if (!anchor && !stored.atEnd) {
        anchor = this.resolveAnchorInWindow(chatId, stored, CHAT_RECENT_LIMIT_MAX)
        if (anchor && recentLimit === undefined) {
          limit = Math.min(anchor.distanceFromEnd + CHAT_READ_ANCHOR_PADDING, CHAT_RECENT_LIMIT_MAX)
        }
      }
    }

    const page = this.getRecentMessagesPage(chatId, limit)
    return {
      messages: page.messages,
      startIndex: page.startIndex,
      history: getHistorySnapshot({
        entries: page.messages,
        hasOlder: page.hasOlder,
        olderCursor: page.olderCursor,
      }, limit),
      readAnchor: anchor,
    }
  }

  /**
   * Locate a stored anchor within the last `limit` entries, or null if it does
   * not appear there (deleted, compacted away, or scrolled back further than
   * the window reaches).
   */
  private resolveAnchorInWindow(
    chatId: string,
    stored: { messageId: string; atEnd: boolean },
    limit: number
  ): ResolvedChatReadAnchor | null {
    const window = this.getRecentEntryWindow(chatId, limit)
    const searchFrom = Math.max(0, window.entries.length - limit)
    for (let index = window.entries.length - 1; index >= searchFrom; index--) {
      if (window.entries[index]!._id !== stored.messageId) continue
      return {
        messageId: stored.messageId,
        atEnd: stored.atEnd,
        distanceFromEnd: window.entries.length - index,
      }
    }
    return null
  }

  listProjects() {
    return [...this.state.projectsById.values()].filter((project) => !project.deletedAt)
  }

  listChatsByProject(projectId: string) {
    return [...this.state.chatsById.values()]
      .filter((chat) => chat.projectId === projectId && !chat.deletedAt && !chat.archivedAt)
      .sort((a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt))
  }

  async getLegacyTranscriptStats(): Promise<LegacyTranscriptStats> {
    const messagesLogSize = await Bun.file(this.messagesLogPath).size
    const sources: LegacyTranscriptStats["sources"] = []
    if (this.snapshotHasLegacyMessages) {
      sources.push("snapshot")
    }
    if (messagesLogSize > 0) {
      sources.push("messages_log")
    }

    let entryCount = 0
    for (const entries of this.legacyMessagesByChatId.values()) {
      entryCount += entries.length
    }

    return {
      hasLegacyData: sources.length > 0 || this.legacyMessagesByChatId.size > 0,
      sources,
      chatCount: this.legacyMessagesByChatId.size,
      entryCount,
    }
  }

  async hasLegacyTranscriptData() {
    return (await this.getLegacyTranscriptStats()).hasLegacyData
  }

  private createSnapshot(): SnapshotFile {
    return {
      v: STORE_VERSION,
      generatedAt: Date.now(),
      projects: this.listProjects().map((project) => ({ ...project })),
      chats: [...this.state.chatsById.values()]
        .filter((chat) => !chat.deletedAt)
        .map((chat) => ({ ...chat })),
      queuedMessages: [...this.state.queuedMessagesByChatId.entries()]
        .map(([chatId, entries]) => ({
          chatId,
          entries: entries.map((entry) => ({
            ...entry,
            attachments: [...entry.attachments],
          })),
        })),
    }
  }

  async compact() {
    const snapshot = this.createSnapshot()
    await Bun.write(this.snapshotPath, JSON.stringify(snapshot, null, 2))
    await Promise.all([
      Bun.write(this.projectsLogPath, ""),
      Bun.write(this.chatsLogPath, ""),
      Bun.write(this.messagesLogPath, ""),
      Bun.write(this.queuedMessagesLogPath, ""),
      Bun.write(this.turnsLogPath, ""),
    ])
  }

  async migrateLegacyTranscripts(onProgress?: (message: string) => void) {
    const stats = await this.getLegacyTranscriptStats()
    if (!stats.hasLegacyData) return false

    const sourceSummary = stats.sources.map((source) => source === "messages_log" ? "messages.jsonl" : "snapshot.json").join(", ")
    onProgress?.(`${LOG_PREFIX} transcript migration detected: ${stats.chatCount} chats, ${stats.entryCount} entries from ${sourceSummary}`)

    const messageSets = [...this.legacyMessagesByChatId.entries()]
    onProgress?.(`${LOG_PREFIX} transcript migration: writing ${messageSets.length} per-chat transcript files`)

    await this.ensureTranscriptsDir()
    const logEveryChat = messageSets.length <= 10
    for (let index = 0; index < messageSets.length; index += 1) {
      const [chatId, entries] = messageSets[index]
      const transcriptPath = this.transcriptPath(chatId)
      const tempPath = `${transcriptPath}.tmp`
      const payload = entries.map((entry) => JSON.stringify(entry)).join("\n")
      await writeFile(tempPath, payload ? `${payload}\n` : "", "utf8")
      await rename(tempPath, transcriptPath)
      if (logEveryChat || (index + 1) % 25 === 0 || index === messageSets.length - 1) {
        onProgress?.(`${LOG_PREFIX} transcript migration: ${index + 1}/${messageSets.length} chats`)
      }
    }

    this.clearLegacyTranscriptState()
    await this.compact()
    this.transcriptCache.clear()
    this.transcriptEntryCounts.clear()
    this.turnIndexes.clear()
    onProgress?.(`${LOG_PREFIX} transcript migration complete`)
    return true
  }

  private async shouldCompact() {
    const sizes = await Promise.all([
      Bun.file(this.projectsLogPath).size,
      Bun.file(this.chatsLogPath).size,
      Bun.file(this.messagesLogPath).size,
      Bun.file(this.queuedMessagesLogPath).size,
      Bun.file(this.turnsLogPath).size,
    ])
    return sizes.reduce((total, size) => total + size, 0) >= COMPACTION_THRESHOLD_BYTES
  }
}
