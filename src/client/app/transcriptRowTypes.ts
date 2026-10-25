import type { AgentProvider, HydratedTranscriptMessage } from "../../shared/types"

// The transcript's resolved rows, as types only: the pure helpers that
// read them (transcriptTurns, transcriptScrollAnchors) and the Foldkit
// transcript take them from here, not from the React component.

export interface SessionHandoff {
  fromProvider: AgentProvider
  toProvider: AgentProvider
}

export interface SessionRestore {
  provider: AgentProvider
}

export interface ResolvedSingleTranscriptRow {
  kind: "single"
  id: string
  message: HydratedTranscriptMessage
  index: number
  isLoading: boolean
  localPath?: string
  isFirstSystem: boolean
  isModelChange: boolean
  /** Set on a system_init that follows a harness switch (handoff_boundary). */
  handoff?: SessionHandoff
  /** Set on a system_init that follows a session restore (session_restored). */
  restored?: SessionRestore
  isFirstAccount: boolean
  isLatestAskUserQuestion: boolean
  isLatestExitPlanMode: boolean
  isLatestTodoWrite: boolean
  hideResult: boolean
  isFinalStatus: boolean
  nextPromptTimestamp?: string
  /** On a result: who sent the prompt that follows, when not the user. */
  nextPromptOrigin?: string
  /** On a prompt nobody typed that no result's boundary introduces: it draws its own. */
  showsOwnBoundary?: boolean
}

export interface ResolvedToolGroupTranscriptRow {
  kind: "tool-group"
  id: string
  startIndex: number
  messages: HydratedTranscriptMessage[]
  isLoading: boolean
  localPath?: string
}

export type ResolvedTranscriptRow = ResolvedSingleTranscriptRow | ResolvedToolGroupTranscriptRow
