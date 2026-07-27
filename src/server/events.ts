import type { AgentProvider, ProjectSummary, QueuedChatMessage, TranscriptEntry } from "../shared/types"

export interface ProjectRecord extends ProjectSummary {
  sidebarTitle?: string
  deletedAt?: number
}

export interface ChatReadAnchor {
  messageId: string
  atEnd: boolean
  updatedAt: number
}

export interface ChatRecord {
  id: string
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
  archivedAt?: number
  /** Set when the user marks the chat done (e.g. drags it to the board's Done column). Cleared when a new turn starts. */
  doneAt?: number
  unread: boolean
  /**
   * Where the user last left off reading, anchored to a transcript entry `_id`
   * so it survives history paging and re-renders. `atEnd` means they were
   * parked at the bottom following the stream — restore should keep following
   * rather than pin to a message.
   */
  readAnchor?: ChatReadAnchor | null
  provider: AgentProvider | null
  planMode: boolean
  /** "Auto Plan": the harness keeps its EnterPlanMode tool. Claude only. */
  autoPlan: boolean
  sessionToken: string | null
  pendingForkSessionToken?: string | null
  hasMessages?: boolean
  lastMessageAt?: number
  /** When the last turn ended (finished/failed/cancelled) — i.e. when the last agent response was received. */
  lastTurnEndedAt?: number
  lastUserMessagePreview?: string
  lastAgentMessagePreview?: string
  lastTurnOutcome: "success" | "failed" | "cancelled" | null
}

export interface StoreState {
  projectsById: Map<string, ProjectRecord>
  projectIdsByPath: Map<string, string>
  chatsById: Map<string, ChatRecord>
  queuedMessagesByChatId: Map<string, QueuedChatMessage[]>
}

export interface SnapshotFile {
  v: 2
  generatedAt: number
  projects: ProjectRecord[]
  chats: ChatRecord[]
  sidebarProjectOrder?: string[]
  queuedMessages?: Array<{ chatId: string; entries: QueuedChatMessage[] }>
  messages?: Array<{ chatId: string; entries: TranscriptEntry[] }>
}

export type ProjectEvent = {
  v: 2
  type: "project_opened"
  timestamp: number
  projectId: string
  localPath: string
  title: string
} | {
  v: 2
  type: "project_sidebar_renamed"
  timestamp: number
  projectId: string
  title: string | null
} | {
  v: 2
  type: "project_removed"
  timestamp: number
  projectId: string
}

export type ChatEvent =
  | {
      v: 2
      type: "chat_created"
      timestamp: number
      chatId: string
      projectId: string
      title: string
      /**
       * Forks only: the source chat's `lastTurnEndedAt`, carried over so the
       * fork derives the same `uncommittedWork` flag (see read-models). A fork
       * has no turn events of its own, so without this the timestamp would be
       * unset and the fork would drop out of the sidebar's Relevant section
       * even though it's the same work against the same dirty tree. Optional —
       * absent on every plain chat_created, including old logs.
       */
      lastTurnEndedAt?: number
    }
  | {
      v: 2
      type: "chat_renamed"
      timestamp: number
      chatId: string
      title: string
    }
  | {
      v: 2
      type: "chat_deleted"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "chat_archived"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "chat_unarchived"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "chat_provider_set"
      timestamp: number
      chatId: string
      provider: AgentProvider
    }
  | {
      v: 2
      type: "chat_plan_mode_set"
      timestamp: number
      chatId: string
      planMode: boolean
    }
  | {
      v: 2
      type: "chat_auto_plan_set"
      timestamp: number
      chatId: string
      autoPlan: boolean
    }
  | {
      v: 2
      type: "chat_read_state_set"
      timestamp: number
      chatId: string
      unread: boolean
    }
  | {
      v: 2
      type: "chat_done_state_set"
      timestamp: number
      chatId: string
      done: boolean
    }
  | {
      v: 2
      type: "chat_read_anchor_set"
      timestamp: number
      chatId: string
      messageId: string
      atEnd: boolean
    }

export type MessageEvent = {
  v: 2
  type: "message_appended"
  timestamp: number
  chatId: string
  entry: TranscriptEntry
}

export type QueuedMessageEvent =
  | {
      v: 2
      type: "queued_message_enqueued"
      timestamp: number
      chatId: string
      message: QueuedChatMessage
    }
  | {
      v: 2
      type: "queued_message_removed"
      timestamp: number
      chatId: string
      queuedMessageId: string
    }

export type TurnEvent =
  | {
      v: 2
      type: "turn_started"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "turn_finished"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "turn_failed"
      timestamp: number
      chatId: string
      error: string
    }
  | {
      v: 2
      type: "turn_cancelled"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "session_token_set"
      timestamp: number
      chatId: string
      sessionToken: string | null
    }
  | {
      v: 2
      type: "pending_fork_session_token_set"
      timestamp: number
      chatId: string
      pendingForkSessionToken: string | null
    }

export type StoreEvent = ProjectEvent | ChatEvent | MessageEvent | QueuedMessageEvent | TurnEvent

export function createEmptyState(): StoreState {
  return {
    projectsById: new Map(),
    projectIdsByPath: new Map(),
    chatsById: new Map(),
    queuedMessagesByChatId: new Map(),
  }
}

export function cloneTranscriptEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

/** Tool kinds whose rendered result comes from `tool_use_result`, not `content`. */
const STRUCTURED_RESULT_TOOL_KINDS = new Set(["ask_user_question", "exit_plan_mode"])

/**
 * Clone a page of entries for the wire, dropping `debugRaw`.
 *
 * `debugRaw` is the provider's whole raw message and duplicates `content`; it
 * measured at ~66% of a typical chat snapshot, and the snapshot is re-sent on
 * every streamed delta. The client reads it in only two places, both handled
 * here or on demand:
 *
 * - `ask_user_question` / `exit_plan_mode` need `tool_use_result`, so it is
 *   lifted into `structuredResult` (a few hundred bytes) for those two kinds.
 * - The raw JSON debug view fetches the original via `chat.getEntryDebugRaw`.
 *
 * A tool_result whose tool_call falls outside this page is left alone: the
 * client only attaches results to calls it saw in the same pass, so that row
 * never renders as a tool row anyway.
 */
export function cloneTranscriptEntriesForClient(entries: TranscriptEntry[]): TranscriptEntry[] {
  const structuredToolIds = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === "tool_call" && STRUCTURED_RESULT_TOOL_KINDS.has(entry.tool.toolKind)) {
      structuredToolIds.add(entry.tool.toolId)
    }
  }

  return entries.map((entry) => {
    const { debugRaw, ...rest } = entry
    if (debugRaw === undefined) return rest as TranscriptEntry
    if (rest.kind !== "tool_result" || !structuredToolIds.has(rest.toolId)) {
      return rest as TranscriptEntry
    }
    try {
      const parsed = JSON.parse(debugRaw) as { tool_use_result?: unknown }
      if (parsed.tool_use_result === undefined) return rest as TranscriptEntry
      return { ...rest, structuredResult: parsed.tool_use_result } as TranscriptEntry
    } catch {
      // Corrupt debugRaw is not worth failing a page render over.
      return rest as TranscriptEntry
    }
  })
}
