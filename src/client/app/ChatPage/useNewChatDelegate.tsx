import { useCallback, useMemo } from "react"
import { useNavigate } from "react-router-dom"
import type { AgentProvider, ChatAttachment, ModelOptions } from "../../../shared/types"
import { createDelegator } from "../../components/chat-ui/create-delegator"
import { DelegateControl, type ComposerDelegate } from "../../components/chat-ui/DelegateControl"
import type { useAppDialog } from "../../components/ui/app-dialog"
import { projectDelegators, resolveDelegateTarget } from "../../lib/delegators"
import { getProjectSidebarLabel } from "../../lib/project-label"
import { flattenSidebarThreads } from "../../lib/thread-sections"
import { useDelegateStore } from "../../stores/delegateStore"
import { clearSending, markSending } from "../../stores/pendingSendStore"
import { findSidebarChat, useSidebarStore } from "../../stores/sidebarStore"
import { isProcessingStatus } from "../derived"
import type { KannaSocket } from "../socket"

/** What a send carries from the composer; see `ChatInput`'s `buildSubmitOptions`. */
export interface DelegatedSendOptions {
  accountId?: string
  provider?: AgentProvider
  model?: string
  modelOptions?: ModelOptions
  planMode?: boolean
  autoPlan?: boolean
  attachments?: ChatAttachment[]
}

/**
 * Delegating from the new chat page: which of the project's delegators a
 * message typed there goes to (`resolveDelegateTarget`), the control that
 * shows and changes it, and the send.
 *
 * While delegating, the page is still the new chat page, and the chat it is
 * on stays empty: the message goes to the delegator, and the app follows it
 * there. Nothing of the page's chat is used but its project.
 */
export function useNewChatDelegate({ enabled, projectId, socket, dialog }: {
  /** The page is a new chat's: empty. */
  enabled: boolean
  projectId: string | null
  socket: KannaSocket
  dialog: ReturnType<typeof useAppDialog>
}): {
  delegate: ComposerDelegate | undefined
  /** Sends to the delegator and opens it. Rejects if the send does, so the composer keeps the text. */
  sendToDelegator: (chatId: string, content: string, options?: DelegatedSendOptions) => Promise<void>
} {
  const navigate = useNavigate()
  // The group, which keeps its identity across pushes that did not touch it.
  const group = useSidebarStore((state) => (
    enabled && projectId ? state.data.projectGroups.find((item) => item.groupKey === projectId) ?? null : null
  ))
  const delegators = useMemo(
    () => (group ? projectDelegators(flattenSidebarThreads({ projectGroups: [group] }), group.groupKey) : []),
    [group],
  )
  const preference = useDelegateStore((store) => (projectId ? store.projects[projectId] : undefined))
  const target = useMemo(() => resolveDelegateTarget(delegators, preference), [delegators, preference])
  const projectName = group ? getProjectSidebarLabel(group).name : "this project"

  const handlePick = useCallback((chatId: string | null) => {
    if (!projectId) return
    const store = useDelegateStore.getState()
    // Turning it off keeps which one was last used, for turning it back on.
    store.setPreference(projectId, chatId ? { on: true, chatId } : { on: false, chatId: store.projects[projectId]?.chatId })
  }, [projectId])

  const handleCreate = useCallback(() => {
    if (projectId) void createDelegator({ projectId, socket, dialog })
  }, [dialog, projectId, socket])

  const targetChatId = target?.chatId ?? null
  const targetTitle = target?.title ?? ""
  const targetProvider = target?.row.provider ?? null
  // Only in a project that has a delegator. A grey "Delegate" under every
  // new chat's input put the feature in front of projects that have never
  // used it; a project's first delegator is made from the command palette
  // or a chat's menu (`createDelegator`), and the control is here from then
  // on. It is one item in a single row of options, so the row's other items
  // move along by its width when it comes and nothing changes height.
  const hasDelegators = delegators.length > 0
  const delegate = useMemo<ComposerDelegate | undefined>(() => (enabled && projectId && hasDelegators ? {
    control: (
      <DelegateControl
        delegators={delegators}
        target={target}
        projectName={projectName}
        onPick={handlePick}
        onCreate={handleCreate}
      />
    ),
    target: targetChatId ? { chatId: targetChatId, title: targetTitle, provider: targetProvider } : null,
    // `target` is covered by the three fields read off it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  } : undefined), [delegators, enabled, handleCreate, handlePick, hasDelegators, projectId, projectName, targetChatId, targetProvider, targetTitle])

  const sendToDelegator = useCallback(async (chatId: string, content: string, options?: DelegatedSendOptions) => {
    const message = {
      chatId,
      content,
      attachments: options?.attachments ?? [],
      provider: options?.provider,
      accountId: options?.accountId,
      model: options?.model,
      modelOptions: options?.modelOptions,
      planMode: options?.planMode,
      autoPlan: options?.autoPlan,
    }
    try {
      // A delegator in the middle of a turn takes the message as its own
      // composer would give it: queued, for when the turn ends.
      if (isProcessingStatus(findSidebarChat(chatId)?.status)) {
        await socket.command({ type: "message.enqueue", ...message })
      } else {
        // Holds the delegator's place in the sidebar until the server says
        // it is running; see `usePendingSendStore`.
        markSending(chatId, Date.now())
        await socket.command({ type: "chat.send", ...message })
      }
    } catch (error) {
      clearSending(chatId)
      // The page has nowhere of its own to say so: its error line is the
      // transcript's, and this message was never in this chat's.
      void dialog.alert({
        title: "Could not send to the delegator",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: "OK",
      })
      throw error
    }
    if (projectId) useDelegateStore.getState().setPreference(projectId, { on: true, chatId })
    navigate(`/chat/${chatId}`)
  }, [dialog, navigate, projectId, socket])

  return { delegate, sendToDelegator }
}
