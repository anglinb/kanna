import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useShallow } from "zustand/react/shallow"
import { PROVIDERS, withPiFaveModels, type AgentProvider, type AppSettingsPatch, type AskUserQuestionAnswerMap, type AppSettingsSnapshot, type ChatDiffSnapshot, type FaveModel, type KeybindingsSnapshot, type LlmProviderSnapshot, type LlmProviderValidationResult, type ModelOptions, type ProviderCatalogEntry, type QueuedChatMessage, type StandaloneTranscriptExportCommandResult, type TranscriptEntry, type UpdateSnapshot } from "../../shared/types"
import { NEW_CHAT_COMPOSER_ID, useChatPreferencesStore } from "../stores/chatPreferencesStore"
import { useRightSidebarStore } from "../stores/rightSidebarStore"
import { useTerminalLayoutStore } from "../stores/terminalLayoutStore"
import { getEditorPresetLabel, useTerminalPreferencesStore } from "../stores/terminalPreferencesStore"
import { useChatInputStore } from "../stores/chatInputStore"
import type { BranchActionFailure, BranchActionSuccess, ChatSnapshot, LocalProjectsSnapshot, SidebarChatRow, SidebarData } from "../../shared/types"
import type { AskUserQuestionItem } from "../components/messages/types"
import type { OpenLocalLinkTarget } from "../components/messages/shared"
import { useAppDialog } from "../components/ui/app-dialog"
import { useTheme } from "../hooks/useTheme"
import { processTranscriptMessages } from "../lib/parseTranscript"
import { formatProjectRepoBranch } from "../lib/project-label"
import { canCancelStatus, getLatestToolIds, isProcessingStatus } from "./derived"
import { useSecretRequests, type SecretRequestsState } from "./useSecretRequests"
import { useChatReminder, type ChatReminderState } from "./useChatReminder"
import {
  applySidebarProjectOrder,
  getActiveChatSnapshot,
  getMostRecentlyActiveProjectId,
  getNewestRemainingChatId,
  getPreviousPrompt,
  getProjectIdForChat,
  NEW_CHAT_OPTIMISTIC_SCOPE,
  reconcileOptimisticUserPrompts,
  resolveComposeIntent,
  type OptimisticProcessingState,
  type OptimisticUserPrompt,
  type ProjectRequest,
  type StartChatIntent,
} from "./kannaStateHelpers"
import {
  applyIncrementalChatSnapshot,
  sameChatSnapshotCore,
  sameDiffs,
  shouldPreserveExistingProjectDiffs,
} from "./snapshotEquality"
import {
  cachedWindowToMessages,
  createTranscriptCacheWriter,
  readCachedWindow,
  toCachedSpan,
} from "./chatTranscriptCache"
import { CLOUD_WS_ENDPOINT_PATH, type CloudWsEndpointResponse } from "../../shared/cloud-api"
import { KannaSocket, type SocketStatus } from "./socket"
import { useAppSettingsSync } from "./useAppSettingsSync"
import { useChatCommands } from "./useChatCommands"
import { useChatReadAnchor, type ChatReadAnchorState } from "./useChatReadAnchor"
import { useSendMessage } from "./useSendMessage"
import { useShareExport } from "./useShareExport"
import { useUpdateRestart } from "./useUpdateRestart"
import { DEFAULT_REMINDER_PROMPT } from "../../shared/reminders"
import type { EditorOpenSettings, OpenExternalAction } from "../../shared/protocol"

export {
  getUiUpdateReadinessPath,
  getUiUpdateRestartReconnectAction,
  shouldHandleUiUpdateReloadRequest,
} from "./useUpdateRestart"

export {
  applySidebarProjectOrder,
  countMatchingUserPrompts,
  getActiveChatSnapshot,
  getMostRecentlyActiveProjectId,
  getNewestRemainingChatId,
  getNextMeasuredInputHeight,
  getPreviousPrompt,
  getTranscriptPaddingBottom,
  getUserPromptSignature,
  reconcileOptimisticUserPrompts,
  resolveComposeIntent,
  shouldAutoFollowTranscript,
  shouldMarkActiveChatRead,
  TRANSCRIPT_PADDING_BOTTOM_OFFSET,
  type OptimisticUserPrompt,
  type ProjectRequest,
  type StartChatIntent,
} from "./kannaStateHelpers"

/** Stable identity so an empty transcript does not re-derive rows each render. */
const EMPTY_TRANSCRIPT_ENTRIES: TranscriptEntry[] = []

function sameOriginWsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}/ws`
}

/**
 * Resolved before every (re)connect. The machine always serves
 * /api/cloud/ws-endpoint: through the kanna.sh proxy it returns the direct
 * tunnel URL plus a fresh short-lived connect token (so the WebSocket
 * bypasses the proxy); locally it returns wsUrl null and we connect
 * same-origin. Any failure falls back to same-origin, keeping local behavior
 * unchanged.
 */
async function wsUrlProvider(): Promise<string> {
  try {
    const response = await fetch(CLOUD_WS_ENDPOINT_PATH, {
      headers: { Accept: "application/json" },
    })
    if (response.ok) {
      const payload = await response.json() as CloudWsEndpointResponse
      if (payload.wsUrl) {
        const url = new URL(payload.wsUrl)
        if (payload.connectToken) {
          url.searchParams.set("token", payload.connectToken)
        }
        return url.toString()
      }
    }
  } catch {
    // Endpoint unreachable — connect same-origin.
  }
  return sameOriginWsUrl()
}

/**
 * A socket for pages that live outside KannaLayout (e.g. the OpenRouter OAuth
 * callback popup) — same URL resolution as the main app socket.
 */
export function createStandaloneKannaSocket() {
  return new KannaSocket(wsUrlProvider)
}

function useKannaSocket() {
  const socketRef = useRef<KannaSocket | null>(null)
  if (!socketRef.current) {
    socketRef.current = new KannaSocket(wsUrlProvider)
  }

  useEffect(() => {
    const socket = socketRef.current
    socket?.start()
    return () => {
      socket?.dispose()
    }
  }, [])

  return socketRef.current as KannaSocket
}

export interface KannaState {
  socket: KannaSocket
  /** Agent-raised credential prompts, rendered inline above the composer. */
  secretRequests: SecretRequestsState
  /** The active chat's pending reminder, for the dock indicator. */
  chatReminder: ChatReminderState
  activeChatId: string | null
  activeProjectId: string | null
  sidebarData: SidebarData
  localProjects: LocalProjectsSnapshot | null
  updateSnapshot: UpdateSnapshot | null
  chatSnapshot: ChatSnapshot | null
  /** Server-stored read position for the active chat; drives restore on open. */
  readAnchorState: ChatReadAnchorState
  /** Report the message at the top of the viewport (throttled write). */
  reportReadAnchor: (messageId: string, atEnd: boolean) => void
  chatDiffSnapshot: ChatDiffSnapshot | null
  keybindings: KeybindingsSnapshot | null
  appSettings: AppSettingsSnapshot | null
  llmProvider: LlmProviderSnapshot | null
  connectionStatus: SocketStatus
  sidebarReady: boolean
  localProjectsReady: boolean
  commandError: string | null
  startingLocalPath: string | null
  sidebarOpen: boolean
  sidebarCollapsed: boolean
  messages: ReturnType<typeof processTranscriptMessages>
  queuedMessages: QueuedChatMessage[]
  previousPrompt: string | null
  latestToolIds: ReturnType<typeof getLatestToolIds>
  runtime: ChatSnapshot["runtime"] | null
  runtimeStatus: string | null
  availableProviders: ProviderCatalogEntry[]
  isProcessing: boolean
  canCancel: boolean
  isDraining: boolean
  isExportingStandalone: boolean
  standaloneShareUrl: string | null
  standaloneShareComplete: boolean
  navbarLocalPath?: string
  /**
   * `repo/branch` for the project `navbarLocalPath` points at, null when that
   * folder isn't in a repo (or hasn't been probed) — the composer placeholder
   * names the checkout when there is one and the path when there isn't.
   */
  navbarRepoLabel: string | null
  editorLabel: string
  hasSelectedProject: boolean
  openSidebar: () => void
  closeSidebar: () => void
  collapseSidebar: () => void
  expandSidebar: () => void
  handleCreateChat: (projectId: string) => Promise<void>
  handleForkChat: (chat: SidebarChatRow) => Promise<void>
  handleOpenLocalProject: (localPath: string) => Promise<void>
  handleCreateProject: (project: ProjectRequest) => Promise<void>
  handleCheckForUpdates: (options?: { force?: boolean }) => Promise<void>
  handleInstallUpdate: () => Promise<void>
  handleInstallNightly: () => Promise<void>
  handleInstallStable: () => Promise<void>
  handleReadAppSettings: () => Promise<void>
  handleWriteAppSettings: (patch: AppSettingsPatch) => Promise<void>
  handleReadLlmProvider: () => Promise<void>
  handleWriteLlmProvider: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Promise<void>
  handleWriteFaveModels: (faveModels: FaveModel[]) => Promise<void>
  handleValidateLlmProvider: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Promise<LlmProviderValidationResult>
  handleSignOut: () => Promise<void>
  handleSend: (content: string, options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean; autoPlan?: boolean }) => Promise<void>
  handleSteerQueuedMessage: (queuedMessageId: string) => Promise<void>
  handleRemoveQueuedMessage: (queuedMessageId: string) => Promise<void>
  handleCancel: () => Promise<void>
  handleStopDraining: () => Promise<void>
  handleRenameChat: (chat: SidebarChatRow) => Promise<void>
  handleRenameProject: (projectId: string, sidebarTitle: string | undefined, realTitle: string) => Promise<void>
  handleShareChat: (chatId?: string | null) => Promise<void>
  handleArchiveChat: (chat: SidebarChatRow) => Promise<void>
  handleOpenArchivedChat: (chatId: string) => Promise<void>
  handleRestoreChat: (chatId: string) => Promise<void>
  handleDeleteChat: (chat: SidebarChatRow) => Promise<void>
  handleSetChatUnread: (chatId: string, unread: boolean) => Promise<void>
  handleSetChatReminder: (chatId: string, dueAt: number) => Promise<void>
  handleClearChatReminder: (chatId: string) => Promise<void>
  handleSetupGit: (chatId: string) => Promise<void>
  handleHideProject: (projectId: string) => Promise<void>
  handleReorderProjectGroups: (projectIds: string[]) => Promise<void>
  handleCopyPath: (localPath: string) => Promise<void>
  handleOpenExternal: (action: OpenExternalAction, editor?: EditorOpenSettings) => Promise<void>
  handleOpenExternalPath: (action: "open_finder" | "open_editor", localPath: string) => Promise<void>
  handleOpenLocalLink: (target: OpenLocalLinkTarget, action?: OpenExternalAction, editor?: EditorOpenSettings) => Promise<void>
  handleCompose: () => void
  handleAskUserQuestion: (
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap
  ) => Promise<void>
  handleExitPlanMode: (
    toolUseId: string,
    confirmed: boolean,
    clearContext?: boolean,
    message?: string
  ) => Promise<void>
  handleExportStandalone: (chatId?: string | null) => Promise<StandaloneTranscriptExportCommandResult | null>
  handleCloseStandaloneShareDialog: () => void
  handleOpenStandaloneShareLink: () => void
  handleCopyStandaloneShareLink: () => Promise<boolean>
}

export function useKannaState(activeChatId: string | null): KannaState {
  const navigate = useNavigate()
  const socket = useKannaSocket()
  const secretRequests = useSecretRequests(socket)
  const dialog = useAppDialog()
  const { resolvedTheme } = useTheme()

  const [sidebarData, setSidebarData] = useState<SidebarData>({ projectGroups: [] })
  const [optimisticSidebarProjectOrder, setOptimisticSidebarProjectOrder] = useState<string[] | null>(null)
  const [localProjects, setLocalProjects] = useState<LocalProjectsSnapshot | null>(null)
  const [chatSnapshot, setChatSnapshot] = useState<ChatSnapshot | null>(null)
  const transcriptCacheWriter = useMemo(() => createTranscriptCacheWriter(), [])
  const [projectDiffSnapshots, setProjectDiffSnapshots] = useState<Record<string, ChatDiffSnapshot | null>>({})
  const [connectionStatus, setConnectionStatus] = useState<SocketStatus>("connecting")
  const [sidebarReady, setSidebarReady] = useState(false)
  const [localProjectsReady, setLocalProjectsReady] = useState(false)
  const [chatReady, setChatReady] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [startingLocalPath, setStartingLocalPath] = useState<string | null>(null)
  const [pendingChatId, setPendingChatId] = useState<string | null>(null)
  const [optimisticUserPrompts, setOptimisticUserPrompts] = useState<OptimisticUserPrompt[]>([])
  const [optimisticProcessing, setOptimisticProcessing] = useState<OptimisticProcessingState | null>(null)
  const draftChatIds = useChatInputStore(useShallow((state) => Object.keys(state.drafts).sort()))
  const attachmentDraftChatIds = useChatInputStore(
    useShallow((state) => Object.keys(state.attachmentDrafts).sort())
  )
  const lastActiveProjectDiffRef = useRef<{ projectId: string | null; diffs: ChatDiffSnapshot | null }>({
    projectId: null,
    diffs: null,
  })
  const editorLabel = getEditorPresetLabel(useTerminalPreferencesStore((store) => store.editorPreset))
  const sidebarProjectGroups = useMemo(
    () => applySidebarProjectOrder(sidebarData.projectGroups, optimisticSidebarProjectOrder),
    [optimisticSidebarProjectOrder, sidebarData.projectGroups]
  )
  const chatReminder = useChatReminder(socket, activeChatId, sidebarProjectGroups)
  const resolvedSidebarData = useMemo(
    () => (
      sidebarProjectGroups === sidebarData.projectGroups
        ? sidebarData
        : {
            ...sidebarData,
            projectGroups: sidebarProjectGroups,
          }
    ),
    [sidebarData, sidebarProjectGroups]
  )

  useEffect(() => socket.onStatus(setConnectionStatus), [socket])

  useEffect(() => {
    return socket.subscribe<SidebarData>({ type: "sidebar" }, (snapshot) => {
      setSidebarData(snapshot)
      setOptimisticSidebarProjectOrder((current) => (
        current && applySidebarProjectOrder(snapshot.projectGroups, current) === snapshot.projectGroups
          ? null
          : current
      ))
      setSidebarReady(true)
      setCommandError(null)
    })
  }, [socket])

  useEffect(() => {
    if (connectionStatus !== "connected") return

    const protectedChatIds = [...new Set([...draftChatIds, ...attachmentDraftChatIds])].sort()
    void socket.command({ type: "chat.setDraftProtection", chatIds: protectedChatIds }).catch((error) => {
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }, [attachmentDraftChatIds, connectionStatus, draftChatIds, socket])

  useEffect(() => {
    return socket.subscribe<LocalProjectsSnapshot>({ type: "local-projects" }, (snapshot) => {
      setLocalProjects(snapshot)
      setLocalProjectsReady(true)
      setCommandError(null)
    })
  }, [socket])

  const { updateSnapshot, handleCheckForUpdates, handleInstallUpdate, handleInstallNightly, handleInstallStable } = useUpdateRestart({
    socket,
    connectionStatus,
    dialog,
    setCommandError,
  })

  const {
    keybindings,
    appSettings,
    llmProvider,
    handleReadAppSettings,
    handleWriteAppSettings,
    handleReadLlmProvider,
    handleWriteLlmProvider,
    handleWriteFaveModels,
    handleValidateLlmProvider,
  } = useAppSettingsSync({ socket, connectionStatus, setCommandError })

  useEffect(() => {
    if (!activeChatId) {
      setChatSnapshot(null)
      setChatReady(true)
      return
    }

    setChatSnapshot(null)
    setChatReady(false)

    let cancelled = false
    let unsubscribe: (() => void) | null = null
    // Base for the first incremental push: the server resumes from the cached
    // span, so its first body starts where this window ends rather than
    // repeating it.
    let base: { messages: TranscriptEntry[]; startIndex: number } | null = null

    function handleSnapshot(snapshot: ChatSnapshot | null) {
      setChatSnapshot((current) => {
        // Incremental bodies carry only the entries added since the last push,
        // so they splice onto the window rather than replacing it.
        const next = applyIncrementalChatSnapshot(current ?? base, snapshot)
        if (next === null && snapshot?.incremental) {
          // Unplaceable body — keep what is on screen rather than render a
          // transcript with a hole; the next full push repairs it.
          return current
        }
        // The cache only ever seeds the first push; after that the live
        // snapshot is the base.
        base = null
        return sameChatSnapshotCore(current, next) ? current : next
      })
      setChatReady(true)
      setCommandError(null)
    }

    // The cache read is a few milliseconds and only gates the subscription, not
    // the render; a miss subscribes with no span and gets a full window.
    void readCachedWindow(activeChatId).then((cached) => {
      if (cancelled) return
      const span = toCachedSpan(cached)
      if (cached && span) base = cachedWindowToMessages(cached)
      // No `recentLimit`: the server sizes the window to reach the stored read
      // anchor and returns it inline. Passing one here would re-subscribe (and
      // re-send the whole transcript) once the anchor resolved.
      unsubscribe = socket.subscribe<ChatSnapshot | null>(
        { type: "chat", chatId: activeChatId, ...(span ? { cachedSpan: span } : {}) },
        handleSnapshot
      )
    })

    return () => {
      cancelled = true
      unsubscribe?.()
      // A chat closed mid-turn never reaches a settled write, so take what is
      // pending rather than lose the window.
      transcriptCacheWriter.flush()
    }
  }, [activeChatId, socket, transcriptCacheWriter])


  useEffect(() => {
    if (selectedProjectId) return
    const seed = getMostRecentlyActiveProjectId(sidebarProjectGroups)
    if (seed) {
      setSelectedProjectId(seed)
    }
  }, [selectedProjectId, sidebarProjectGroups])

  useEffect(() => {
    if (!activeChatId) return
    if (!sidebarReady || !chatReady) return
    // Archived chats are viewable in place (viewing doesn't unarchive), so
    // they count as existing — only truly unknown/deleted chats bounce home.
    const exists = sidebarProjectGroups.some((group) =>
      group.chats.some((chat) => chat.chatId === activeChatId)
      || (group.archivedChats ?? []).some((chat) => chat.chatId === activeChatId))
    if (exists) {
      if (pendingChatId === activeChatId) {
        setPendingChatId(null)
      }
      return
    }
    if (pendingChatId === activeChatId) {
      return
    }
    navigate("/")
  }, [activeChatId, chatReady, navigate, pendingChatId, sidebarProjectGroups, sidebarReady])

  useEffect(() => {
    if (!chatSnapshot) return
    setSelectedProjectId(chatSnapshot.runtime.projectId)
    if (pendingChatId === chatSnapshot.runtime.chatId) {
      setPendingChatId(null)
    }
  }, [chatSnapshot, pendingChatId])

  // Mark a chat read when the user navigates *away* from it, not when it opens.
  // A chat that receives new activity while it's the active chat stays unread
  // (badge visible) until the user leaves it. We look up the outgoing chat's
  // unread state through a ref so this effect only re-runs on chat switches, and
  // skip chats that no longer exist (avoids spurious markRead commands).
  const sidebarGroupsRef = useRef(sidebarProjectGroups)
  useEffect(() => {
    sidebarGroupsRef.current = sidebarProjectGroups
  }, [sidebarProjectGroups])

  // Chats the user deliberately marked unread while they were the active chat.
  // Without this the effect below would clear the flag the instant they
  // navigated away — which is precisely when "mark as unread" is supposed to
  // start meaning something. One suppression per mark: leaving consumes it, so
  // the next visit reads and clears as normal.
  const deliberatelyUnreadRef = useRef(new Set<string>())

  const previousActiveChatIdRef = useRef<string | null>(null)
  useEffect(() => {
    const previousChatId = previousActiveChatIdRef.current
    previousActiveChatIdRef.current = activeChatId ?? null
    if (!previousChatId || previousChatId === activeChatId) return
    if (deliberatelyUnreadRef.current.delete(previousChatId)) return
    const previousChat = sidebarGroupsRef.current
      .flatMap((group) => group.chats)
      .find((chat) => chat.chatId === previousChatId)
    if (!previousChat?.unread) return
    void socket.command({ type: "chat.markRead", chatId: previousChatId }).catch((error) => {
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }, [activeChatId, socket])

  const activeChatSnapshot = useMemo(
    () => getActiveChatSnapshot(chatSnapshot, activeChatId),
    [activeChatId, chatSnapshot]
  )

  // Reads the anchor off the snapshot (the server resolves it against the
  // window it chose) and owns the throttled write-back.
  const {
    anchorState: readAnchorState,
    reportReadAnchor,
  } = useChatReadAnchor(socket, activeChatId, activeChatSnapshot?.readAnchor, chatReady)

  const activeProjectId = useMemo(
    () => activeChatSnapshot?.runtime.projectId
      ?? getProjectIdForChat(sidebarProjectGroups, activeChatId)
      ?? selectedProjectId,
    [activeChatId, activeChatSnapshot?.runtime.projectId, selectedProjectId, sidebarProjectGroups]
  )
  const chatDiffSnapshot = useMemo(() => {
    const currentDiffs = activeProjectId ? (projectDiffSnapshots[activeProjectId] ?? null) : null
    if (activeProjectId && currentDiffs) {
      lastActiveProjectDiffRef.current = {
        projectId: activeProjectId,
        diffs: currentDiffs,
      }
      return currentDiffs
    }

    if (activeProjectId && lastActiveProjectDiffRef.current.projectId === activeProjectId) {
      return lastActiveProjectDiffRef.current.diffs
    }

    return currentDiffs
  }, [activeProjectId, projectDiffSnapshots])

  useEffect(() => {
    if (!activeProjectId) {
      return
    }

    const unsubscribe = socket.subscribe<ChatDiffSnapshot | null>({ type: "project-git", projectId: activeProjectId }, (snapshot) => {
      setProjectDiffSnapshots((current) => {
        const nextDiffs = snapshot ?? null
        if (shouldPreserveExistingProjectDiffs(current[activeProjectId] ?? null, nextDiffs)) {
          return current
        }
        if (sameDiffs(current[activeProjectId] ?? null, nextDiffs)) {
          return current
        }
        return {
          ...current,
          [activeProjectId]: nextDiffs,
        }
      })
      setCommandError(null)
    })

    return unsubscribe
  }, [activeProjectId, socket])
  const serverTranscriptEntries = activeChatSnapshot?.messages ?? EMPTY_TRANSCRIPT_ENTRIES
  const optimisticScopeId = activeChatId ?? NEW_CHAT_OPTIMISTIC_SCOPE
  const optimisticTranscriptEntries = useMemo(
    () => optimisticUserPrompts
      .filter((prompt) => prompt.scopeId === optimisticScopeId)
      .map((prompt) => prompt.entry),
    [optimisticScopeId, optimisticUserPrompts]
  )
  const transcriptEntries = useMemo(
    () => [...serverTranscriptEntries, ...optimisticTranscriptEntries],
    [optimisticTranscriptEntries, serverTranscriptEntries]
  )
  const messages = useMemo(() => processTranscriptMessages(transcriptEntries), [transcriptEntries])
  const previousPrompt = useMemo(() => getPreviousPrompt(messages), [messages])
  const latestToolIds = useMemo(() => getLatestToolIds(messages), [messages])
  const runtime = activeChatSnapshot?.runtime ?? null
  const queuedMessages = activeChatSnapshot?.queuedMessages ?? []
  const optimisticRuntimeStatus = optimisticProcessing?.scopeId === optimisticScopeId && (!runtime || runtime.status === "idle")
    ? "starting"
    : null
  const effectiveRuntimeStatus = optimisticRuntimeStatus ?? runtime?.status ?? null
  // Outside a chat snapshot (new-chat composer, settings) the pi catalog is
  // derived from the same fave models the server applies, so both always match.
  const fallbackProviders = useMemo(
    () => withPiFaveModels(PROVIDERS, llmProvider?.faveModels ?? []),
    [llmProvider?.faveModels]
  )
  const availableProviders = activeChatSnapshot?.availableProviders ?? fallbackProviders
  const isProcessing = isProcessingStatus(effectiveRuntimeStatus ?? undefined)

  // Written after a turn settles, not during: the window changes many times a
  // second while streaming and the server is the source of truth throughout.
  useEffect(() => {
    if (!activeChatId || !chatSnapshot) return
    transcriptCacheWriter.schedule(activeChatId, chatSnapshot, isProcessing)
  }, [activeChatId, chatSnapshot, isProcessing, transcriptCacheWriter])

  const canCancel = canCancelStatus(effectiveRuntimeStatus ?? undefined)
  const isDraining = runtime?.isDraining ?? false
  const fallbackLocalProjectPath = localProjects?.projects[0]?.localPath ?? null
  const navbarLocalPath =
    runtime?.localPath
    ?? fallbackLocalProjectPath
    ?? sidebarProjectGroups[0]?.localPath
  // The composer names the project the way the sidebar does — `repo/branch` —
  // so the id is matched first and the path only stands in when there's no
  // active project (the new-chat composer falling back to a local project).
  const navbarProjectGroup =
    sidebarProjectGroups.find((group) => group.groupKey === activeProjectId)
    ?? sidebarProjectGroups.find((group) => group.localPath === navbarLocalPath)
  const navbarRepoLabel = navbarProjectGroup ? formatProjectRepoBranch(navbarProjectGroup) : null
  const hasSelectedProject = Boolean(
    selectedProjectId
    ?? runtime?.projectId
    ?? sidebarProjectGroups[0]?.groupKey
    ?? fallbackLocalProjectPath
  )

  useEffect(() => {
    if (optimisticProcessing?.scopeId !== optimisticScopeId) {
      return
    }
    if (runtime?.status && runtime.status !== "idle") {
      setOptimisticProcessing(null)
    }
  }, [optimisticProcessing, optimisticScopeId, runtime?.status])

  useEffect(() => {
    if (!optimisticProcessing?.ackedAt || optimisticProcessing.scopeId !== optimisticScopeId) {
      return
    }
    if (runtime?.status && runtime.status !== "idle") {
      return
    }
    const timeoutId = window.setTimeout(() => {
      setOptimisticProcessing((current) => (
        current?.scopeId === optimisticScopeId && current.ackedAt === optimisticProcessing.ackedAt
          ? null
          : current
      ))
    }, 300)
    return () => window.clearTimeout(timeoutId)
  }, [optimisticProcessing, optimisticScopeId, runtime?.status])

  useEffect(() => {
    setOptimisticUserPrompts((current) => {
      const reconciled = reconcileOptimisticUserPrompts(current, optimisticScopeId, serverTranscriptEntries)
      if (reconciled.length === current.length && reconciled.every((prompt, index) => prompt === current[index])) {
        return current
      }
      return reconciled
    })
  }, [optimisticScopeId, serverTranscriptEntries])

  const createChatForProject = useCallback(async (projectId: string) => {
    const chatPreferences = useChatPreferencesStore.getState()
    const sourceComposerState = activeChatId
      ? chatPreferences.getComposerState(activeChatId)
      : chatPreferences.getComposerState(NEW_CHAT_COMPOSER_ID)
    const result = await socket.command<{ chatId: string }>({ type: "chat.create", projectId })
    chatPreferences.initializeComposerForChat(result.chatId, { sourceState: sourceComposerState })
    setSelectedProjectId(projectId)
    setPendingChatId(result.chatId)
    navigate(`/chat/${result.chatId}`)
    setSidebarOpen(false)
    setCommandError(null)
  }, [activeChatId, navigate, socket])

  const resolveProjectIdForStartChat = useCallback(async (intent: StartChatIntent): Promise<{ projectId: string; localPath?: string }> => {
    if (intent.kind === "project_id") {
      return { projectId: intent.projectId }
    }

    if (intent.kind === "local_path") {
      const result = await socket.command<{ projectId: string }>({ type: "project.open", localPath: intent.localPath })
      return { projectId: result.projectId, localPath: intent.localPath }
    }

    const command: Parameters<typeof socket.command>[0] = intent.project.mode === "clone" && intent.project.cloneUrl
      ? { type: "project.clone", cloneUrl: intent.project.cloneUrl, localPath: intent.project.localPath, fallbackPath: intent.project.fallbackPath, title: intent.project.title }
      : intent.project.mode === "create"
        ? { type: "project.create", localPath: intent.project.localPath, title: intent.project.title }
        : { type: "project.open", localPath: intent.project.localPath }
    const result = await socket.command<{ projectId: string; localPath?: string }>(command)
    return { projectId: result.projectId, localPath: result.localPath ?? intent.project.localPath }
  }, [socket])

  const startChatFromIntent = useCallback(async (intent: StartChatIntent) => {
    try {
      const localPath = intent.kind === "project_id"
        ? null
        : intent.kind === "local_path"
          ? intent.localPath
          : intent.project.localPath
      if (localPath) {
        setStartingLocalPath(localPath)
      }

      const { projectId } = await resolveProjectIdForStartChat(intent)
      await createChatForProject(projectId)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      // Re-throw project requests so the command palette can show the
      // failure inline (clone/create/open rows).
      if (intent.kind === "project_request") {
        throw error
      }
    } finally {
      setStartingLocalPath(null)
    }
  }, [createChatForProject, resolveProjectIdForStartChat])

  const handleCreateChat = useCallback(async (projectId: string) => {
    await startChatFromIntent({ kind: "project_id", projectId })
  }, [startChatFromIntent])

  const handleForkChat = useCallback(async (chat: SidebarChatRow) => {
    try {
      const result = await socket.command<{ chatId: string }>({
        type: "chat.fork",
        chatId: chat.chatId,
      })
      const chatPreferences = useChatPreferencesStore.getState()
      chatPreferences.initializeComposerForChat(result.chatId, {
        sourceState: chatPreferences.getComposerState(chat.chatId),
      })
      setPendingChatId(result.chatId)
      navigate(`/chat/${result.chatId}`)
      setSidebarOpen(false)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [navigate, socket])

  const handleOpenLocalProject = useCallback(async (localPath: string) => {
    await startChatFromIntent({ kind: "local_path", localPath })
  }, [startChatFromIntent])

  const handleCreateProject = useCallback(async (project: ProjectRequest) => {
    await startChatFromIntent({ kind: "project_request", project })
  }, [startChatFromIntent])

  const handleSignOut = useCallback(async () => {
    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        headers: {
          Accept: "application/json",
        },
      })

      if (!response.ok) {
        throw new Error(`Sign out failed with status ${response.status}`)
      }

      setCommandError(null)
      window.location.reload()
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const handleSend = useSendMessage({
    socket,
    navigate,
    activeChatId,
    setCommandError,
    setSelectedProjectId,
    setPendingChatId,
    setOptimisticProcessing,
    setOptimisticUserPrompts,
    sendContext: {
      isProcessing,
      optimisticUserPrompts,
      serverTranscriptEntries,
      sidebarProjectGroups,
      selectedProjectId,
      fallbackLocalProjectPath,
    },
  })

  const handleDeleteChat = useCallback(async (chat: SidebarChatRow) => {
    const confirmed = await dialog.confirm({
      title: "Delete Chat",
      description: `Delete "${chat.title}"? This cannot be undone.`,
      confirmLabel: "Delete",
      confirmVariant: "destructive",
    })
    if (!confirmed) return
    try {
      await socket.command({ type: "chat.delete", chatId: chat.chatId })
      if (chat.chatId === activeChatId) {
        const nextChatId = getNewestRemainingChatId(sidebarProjectGroups, chat.chatId)
        navigate(nextChatId ? `/chat/${nextChatId}` : "/")
      }
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, dialog, navigate, sidebarProjectGroups, socket])

  const handleArchiveChat = useCallback(async (chat: SidebarChatRow) => {
    try {
      await socket.command({ type: "chat.archive", chatId: chat.chatId })
      if (chat.chatId === activeChatId) {
        const nextChatId = getNewestRemainingChatId(sidebarProjectGroups, chat.chatId)
        navigate(nextChatId ? `/chat/${nextChatId}` : "/")
      }
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, navigate, sidebarProjectGroups, socket])

  const handleSetChatUnread = useCallback(async (chatId: string, unread: boolean) => {
    // Only the active chat needs shielding from the read-on-leave effect: it
    // fires for the chat being left, so any other row is already safe. Marking
    // read again drops the shield rather than leaving it to misfire later.
    if (unread && chatId === activeChatId) {
      deliberatelyUnreadRef.current.add(chatId)
    } else {
      deliberatelyUnreadRef.current.delete(chatId)
    }
    try {
      await socket.command({ type: "chat.setUnread", chatId, unread })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  // The menu's presets carry the default prompt, so a sidebar reminder wakes
  // the chat rather than only flagging it. Reminders with no prompt are the
  // agent-facing path (`kanna remind` without a message).
  const handleSetChatReminder = useCallback(async (chatId: string, dueAt: number) => {
    try {
      await socket.command({
        type: "chat.setReminder",
        chatId,
        dueAt,
        prompt: DEFAULT_REMINDER_PROMPT,
      })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  const handleClearChatReminder = useCallback(async (chatId: string) => {
    try {
      await socket.command({ type: "chat.clearReminder", chatId })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  // Viewing an archived chat is read-only navigation — it stays archived.
  // Restoring is explicit (context menu) or implicit via sending a message
  // (the server unarchives on chat.send).
  const handleOpenArchivedChat = useCallback(async (chatId: string) => {
    navigate(`/chat/${chatId}`)
  }, [navigate])

  const handleRestoreChat = useCallback(async (chatId: string) => {
    try {
      await socket.command({ type: "chat.unarchive", chatId })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  /**
   * "Setup Git" from a sidebar hover card: the same confirm-then-`git init` the
   * chat navbar's branch slot runs, for a chat that isn't necessarily the one
   * you have open. The server resolves the project from the chat, and
   * `chat.initGit` is a no-op success on a folder that turns out to already be
   * a repo — so a stale snapshot costs nothing.
   *
   * Unlike the navbar's copy this doesn't open the git panel afterwards: you
   * were pointing at a row in the sidebar, not asking to go anywhere.
   */
  const handleSetupGit = useCallback(async (chatId: string) => {
    const confirmed = await dialog.confirm({
      title: "Initialize Git?",
      description: "Initialize a local git repository in this project?",
      confirmLabel: "Init Git",
      cancelLabel: "Cancel",
    })
    if (!confirmed) return

    try {
      const result = await socket.command<BranchActionSuccess | BranchActionFailure>({
        type: "chat.initGit",
        chatId,
      })
      if (!result.ok) {
        await dialog.alert({
          title: result.title,
          description: `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: "OK",
        })
      }
    } catch (error) {
      await dialog.alert({
        title: "Initialize git failed",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: "OK",
      })
    }
  }, [dialog, socket])

  const handleHideProject = useCallback(async (projectId: string) => {
    try {
      await socket.command({ type: "project.remove", projectId })
      useTerminalLayoutStore.getState().clearProject(projectId)
      useRightSidebarStore.getState().clearProject(projectId)
      if (runtime?.projectId === projectId) {
        navigate("/")
      }
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [navigate, runtime?.projectId, socket])

  const handleReorderProjectGroups = useCallback(async (projectIds: string[]) => {
    setOptimisticSidebarProjectOrder(projectIds)
    try {
      await socket.command({ type: "sidebar.reorderProjectGroups", projectIds })
      setCommandError(null)
    } catch (error) {
      setOptimisticSidebarProjectOrder(null)
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  const {
    handleSteerQueuedMessage,
    handleRemoveQueuedMessage,
    handleCancel,
    handleStopDraining,
    handleRenameChat,
    handleRenameProject,
    handleAskUserQuestion,
    handleExitPlanMode,
    handleCopyPath,
    handleOpenExternal,
    handleOpenLocalLink,
    handleOpenExternalPath,
  } = useChatCommands({
    socket,
    dialog,
    activeChatId,
    setCommandError,
    defaultOpenLocalPath: navbarLocalPath,
  })

  const {
    isExportingStandalone,
    standaloneShareUrl,
    standaloneShareComplete,
    handleExportStandalone,
    handleShareChat,
    handleCloseStandaloneShareDialog,
    handleCopyStandaloneShareLink,
    handleOpenStandaloneShareLink,
  } = useShareExport({ socket, activeChatId, resolvedTheme, dialog, setCommandError })

  const handleCompose = useCallback(() => {
    const intent = resolveComposeIntent({
      selectedProjectId,
      sidebarProjectId: getMostRecentlyActiveProjectId(sidebarProjectGroups),
      fallbackLocalProjectPath,
    })
    if (intent) {
      void startChatFromIntent(intent)
      return
    }

    navigate("/")
  }, [fallbackLocalProjectPath, navigate, selectedProjectId, sidebarProjectGroups, startChatFromIntent])

  const openSidebar = useCallback(() => setSidebarOpen(true), [])
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  const collapseSidebar = useCallback(() => setSidebarCollapsed(true), [])
  const expandSidebar = useCallback(() => setSidebarCollapsed(false), [])

  return {
    socket,
    secretRequests,
    chatReminder,
    activeChatId,
    activeProjectId,
    sidebarData: resolvedSidebarData,
    localProjects,
    updateSnapshot,
    chatSnapshot,
    readAnchorState,
    reportReadAnchor,
    chatDiffSnapshot,
    keybindings,
    appSettings,
    llmProvider,
    connectionStatus,
    sidebarReady,
    localProjectsReady,
    commandError,
    startingLocalPath,
    sidebarOpen,
    sidebarCollapsed,
    messages,
    queuedMessages,
    previousPrompt,
    latestToolIds,
    runtime,
    runtimeStatus: effectiveRuntimeStatus,
    availableProviders,
    isProcessing,
    canCancel,
    isDraining,
    isExportingStandalone,
    standaloneShareUrl,
    standaloneShareComplete,
    navbarLocalPath,
    navbarRepoLabel,
    editorLabel,
    hasSelectedProject,
    openSidebar,
    closeSidebar,
    collapseSidebar,
    expandSidebar,
    handleCreateChat,
    handleForkChat,
    handleOpenLocalProject,
    handleCreateProject,
    handleCheckForUpdates,
    handleInstallUpdate,
    handleInstallNightly,
    handleInstallStable,
    handleReadAppSettings,
    handleWriteAppSettings,
    handleReadLlmProvider,
    handleWriteLlmProvider,
    handleWriteFaveModels,
    handleValidateLlmProvider,
    handleSignOut,
    handleSend,
    handleSteerQueuedMessage,
    handleRemoveQueuedMessage,
    handleCancel,
    handleStopDraining,
    handleRenameChat,
    handleRenameProject,
    handleShareChat,
    handleArchiveChat,
    handleOpenArchivedChat,
    handleRestoreChat,
    handleDeleteChat,
    handleSetChatUnread,
    handleSetChatReminder,
    handleClearChatReminder,
    handleSetupGit,
    handleHideProject,
    handleReorderProjectGroups,
    handleCopyPath,
    handleOpenExternal,
    handleOpenExternalPath,
    handleOpenLocalLink,
    handleCompose,
    handleAskUserQuestion,
    handleExitPlanMode,
    handleExportStandalone,
    handleCloseStandaloneShareDialog,
    handleOpenStandaloneShareLink,
    handleCopyStandaloneShareLink,
  }
}
