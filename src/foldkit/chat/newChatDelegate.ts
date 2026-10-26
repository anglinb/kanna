import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { isProcessingStatus } from "../../client/app/derived"
import { projectDelegators, resolveDelegateTarget } from "../../client/lib/delegators"
import { getProjectSidebarLabel } from "../../client/lib/project-label"
import { flattenSidebarThreads, type SidebarThread } from "../../client/lib/thread-sections"
import type { AgentProvider } from "../../shared/types"
import type { AppModel } from "../app/slice"
import type { SendOptions } from "../core/chatSession"
import { opaque } from "../core/schema"
import { errorMessage, sendCommand } from "../core/socket"
import * as Sidebar from "../core/stores/sidebar"
import { Message } from "./message"
import type { PageFacts } from "./page"

// useNewChatDelegate (ChatPage/useNewChatDelegate.tsx): delegating from the
// new chat page. Which of the project's delegators a message typed there
// goes to (`resolveDelegateTarget`), what the composer's delegate control
// shows (`page.delegate`), and the send, which the page takes over from the
// composer while a target is set: the message goes to the delegator, and
// the app follows it there. Nothing of the page's chat is used but its
// project.

/** What the composer's DelegateControl shows and changes (`ComposerDelegate`). */
export interface NewChatDelegate {
  delegators: ReadonlyArray<SidebarThread>
  target: SidebarThread | null
  projectName: string
  /** What the composer shows as where the message goes. */
  targetSummary: { chatId: string; title: string; provider: AgentProvider | null } | null
}

/**
 * Not on a delegator's own empty page: what is typed there is for it. Nor on
 * a page whose chat is still loading, where the empty state is only being
 * held over from the last page. A chat known to be new has the control in
 * its composer from its first frame.
 *
 * Only in a project that has a delegator: a project's first delegator is
 * made from the command palette or a chat's menu, and the control is here
 * from then on.
 */
export function newChatDelegate(app: AppModel, facts: PageFacts): NewChatDelegate | null {
  const enabled = facts.showEmptyState && (!facts.isChatLoading || facts.isKnownNewChat) && !facts.isDelegator
  const projectId = facts.projectId
  if (!enabled || !projectId) return null
  const group = app.stores.sidebar.data.projectGroups.find((item) => item.groupKey === projectId) ?? null
  if (!group) return null
  const delegators = projectDelegators(flattenSidebarThreads({ projectGroups: [group] }), group.groupKey)
  if (delegators.length === 0) return null
  const target = resolveDelegateTarget(delegators, app.stores.delegate.projects[projectId])
  return {
    delegators,
    target,
    projectName: getProjectSidebarLabel(group).name,
    targetSummary: target ? { chatId: target.chatId, title: target.title, provider: target.row.provider ?? null } : null,
  }
}

/** A delegator in the middle of a turn takes the message as its own composer would give it: queued. */
export function delegatorIsBusy(app: AppModel, chatId: string) {
  return isProcessingStatus(Sidebar.findSidebarChat(app.stores.sidebar, chatId)?.status)
}

/** The send, once the page knows where it goes and (when it isn't queued) has marked it sending. */
export const SendToDelegator = Command.define("SendToDelegator", {
  args: {
    chatId: Schema.String,
    content: Schema.String,
    options: opaque<SendOptions>("SendOptions"),
    queued: Schema.Boolean,
  },
  messages: [Message.SucceededDelegatedSend, Message.FailedDelegatedSend],
  execute: ({ chatId, content, options, queued }) => {
    const message = {
      chatId,
      content,
      attachments: options.attachments ?? [],
      provider: options.provider,
      accountId: options.accountId,
      model: options.model,
      modelOptions: options.modelOptions,
      planMode: options.planMode,
      autoPlan: options.autoPlan,
    }
    return sendCommand(queued ? { type: "message.enqueue", ...message } : { type: "chat.send", ...message }).pipe(
      Effect.as(Message.SucceededDelegatedSend({ chatId })),
      Effect.catch((error) => Effect.succeed(Message.FailedDelegatedSend({ chatId, content, error: errorMessage(error) }))),
    )
  },
})

/** `markSending(chatId, Date.now())`: update can't read the clock. */
export const StampDelegatedSend = Command.define("StampDelegatedSend", {
  args: { chatId: Schema.String, content: Schema.String, options: opaque<SendOptions>("SendOptions") },
  messages: [Message.StampedDelegatedSend],
  execute: ({ chatId, content, options }) => Effect.sync(() => Message.StampedDelegatedSend({ chatId, content, options, sentAt: Date.now() })),
})
