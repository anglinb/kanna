import type { HtmlBuilder } from "foldkit/html"
import { Compass as CompassNode } from "lucide"
import type { SidebarThread } from "../../client/lib/thread-sections"
import { getRepoUrlLabel } from "../../shared/git-url"
import { AppAction } from "../app/action"
import * as Stores from "../app/stores"
import * as ChatInput from "../core/stores/chatInput"
import type { Child } from "../ui/attributes"
import * as ContextMenu from "../ui/context-menu"
import { defineIcon } from "../ui/icon"
import { Archive, Code, Copy, FolderOpen, Github, Pencil, PencilOff, Pin, PinOff, RotateCcw, Split, SquarePen, Trash2, UserRoundPlus } from "../ui/icons"

// A chat's right-click menu (ThreadRowMenu → ChatRowMenu, in
// components/chat-ui/sidebar), as context-menu entries: the same items, in
// the same order, doing the same things, wherever a chat stands for its
// sidebar row on this page (the navbar's title, a tab).

/** The delegator's mark: Lucide's compass (components/chat-ui/delegator-icon). */
export const DelegatorIcon = defineIcon("compass", CompassNode)

export interface ChatRowMenuContext {
  thread: SidebarThread
  archived: boolean
  editorLabel: string
  hasDraft: boolean
  /** A tab's own items, ahead of the chat's, set off by a separator. */
  leadingItems?: ReadonlyArray<ContextMenu.MenuEntry>
}

const DESTRUCTIVE_ITEM_CLASS = "text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"

function canToggleDelegator(context: ChatRowMenuContext) {
  // Grok chats are not given the chat tools, so one cannot delegate. One
  // that already is a delegator can still be made ordinary again.
  const delegator = Boolean(context.thread.row.delegator)
  return !context.archived && (delegator || context.thread.row.provider !== "grok")
}

export function chatRowMenuEntries(context: ChatRowMenuContext): ContextMenu.MenuEntry[] {
  const { archived } = context
  const repoUrl = context.thread.projectLabel.repoUrl
  return [
    ...(context.leadingItems && context.leadingItems.length > 0 ? [...context.leadingItems, ContextMenu.separator()] : []),
    ...(!archived ? [ContextMenu.item({ value: "chat:pin" })] : []),
    // The chat's agent is told at the start of a turn, so one that is
    // running goes on as it was until its next.
    ...(canToggleDelegator(context) ? [ContextMenu.item({ value: "chat:delegator", title: "Takes effect on this chat's next turn" })] : []),
    // Draft leads: its own section, for something only this chat has and
    // only while it has it.
    ...(context.hasDraft ? [ContextMenu.item({ value: "chat:clear-draft" }), ContextMenu.separator()] : []),
    ...(archived ? [ContextMenu.item({ value: "chat:restore" }), ContextMenu.separator()] : []),
    // Chat actions
    ContextMenu.item({ value: "chat:rename" }),
    ContextMenu.item({ value: "chat:share" }),
    ContextMenu.item({ value: "chat:fork", disabled: !context.thread.row.canFork }),
    ContextMenu.separator(),
    // Project actions
    ContextMenu.item({ value: "chat:new-chat" }),
    ContextMenu.item({ value: "chat:copy-path" }),
    ContextMenu.item({ value: "chat:open-finder" }),
    ContextMenu.item({ value: "chat:open-editor" }),
    ...(repoUrl ? [ContextMenu.item({ value: "chat:open-repo" })] : []),
    ContextMenu.separator(),
    // Chat lifecycle
    ...(!archived ? [ContextMenu.item({ value: "chat:archive" })] : []),
    ContextMenu.item({ value: "chat:delete", className: DESTRUCTIVE_ITEM_CLASS }),
  ]
}

function row<Message>(icon: Child, label: string, h: HtmlBuilder<Message>): ReadonlyArray<Child> {
  return [icon, h.span([h.Class("text-xs font-medium")], [label])]
}

/** The children of one of the chat's items, or null for a value that isn't one. */
export function renderChatRowMenuItem<Message>(value: string, context: ChatRowMenuContext, h: HtmlBuilder<Message>): ReadonlyArray<Child> | null {
  const icon = "h-3.5 w-3.5"
  const pinned = Boolean(context.thread.row.pinnedAt)
  const delegator = Boolean(context.thread.row.delegator)
  switch (value) {
    case "chat:pin": return row(pinned ? PinOff({ class: icon }, h) : Pin({ class: icon }, h), pinned ? "Unpin" : "Pin", h)
    case "chat:delegator": return row(DelegatorIcon({ class: icon }, h), delegator ? "Stop Delegating" : "Make Delegator", h)
    case "chat:clear-draft": return row(PencilOff({ class: icon }, h), "Clear Draft", h)
    case "chat:restore": return row(RotateCcw({ class: icon }, h), "Restore", h)
    case "chat:rename": return row(Pencil({ class: icon }, h), "Rename", h)
    case "chat:share": return row(UserRoundPlus({ class: icon }, h), "Share", h)
    case "chat:fork": return row(Split({ class: icon }, h), "Fork", h)
    case "chat:new-chat": return row(SquarePen({ class: icon }, h), "New Chat", h)
    case "chat:copy-path": return row(Copy({ class: icon }, h), "Copy Path", h)
    case "chat:open-finder": return row(FolderOpen({ class: icon }, h), "Open in Finder", h)
    case "chat:open-editor": return row(Code({ class: icon }, h), `Open in ${context.editorLabel}`, h)
    case "chat:open-repo": return row(Github({ class: icon }, h), `Open on ${getRepoUrlLabel(context.thread.projectLabel.repoUrl)}`, h)
    case "chat:archive": return row(Archive({ class: icon }, h), "Archive Chat", h)
    case "chat:delete": return row(Trash2({ class: icon }, h), "Delete Chat", h)
    default: return null
  }
}

/** What choosing one of the chat's items asks for: an app action, the forge page in this browser, or nothing. */
export type ChatRowMenuChoice =
  | { _tag: "Action"; action: AppAction }
  | { _tag: "OpenUrl"; url: string }
  | { _tag: "None" }

export function chooseChatRowMenuItem(value: string, context: ChatRowMenuContext): ChatRowMenuChoice | null {
  const chat = context.thread.row
  const action = (appAction: AppAction): ChatRowMenuChoice => ({ _tag: "Action", action: appAction })
  switch (value) {
    case "chat:pin": return action(AppAction.TogglePinChat({ chatId: chat.chatId, pinned: !chat.pinnedAt }))
    case "chat:delegator": return action(AppAction.SetDelegator({ chatId: chat.chatId, delegator: !chat.delegator }))
    case "chat:clear-draft": return action(AppAction.Store({
      message: Stores.Message.GotChatInputMessage({ message: ChatInput.Message.ClearedDraft({ chatId: chat.chatId }) }),
    }))
    case "chat:restore": return action(AppAction.RestoreChat({ chatId: chat.chatId }))
    case "chat:rename": return action(AppAction.RenameChat({ chatId: chat.chatId, title: chat.title }))
    case "chat:share": return action(AppAction.ShareChat({ chatId: chat.chatId }))
    case "chat:fork": return chat.canFork ? action(AppAction.ForkChat({ chatId: chat.chatId })) : { _tag: "None" }
    case "chat:new-chat": return action(AppAction.CreateChat({ projectId: context.thread.projectId }))
    case "chat:copy-path": return action(AppAction.CopyPath({ localPath: chat.localPath }))
    case "chat:open-finder": return action(AppAction.OpenExternalPath({ action: "open_finder", localPath: chat.localPath }))
    case "chat:open-editor": return action(AppAction.OpenExternalPath({ action: "open_editor", localPath: chat.localPath }))
    case "chat:open-repo": return context.thread.projectLabel.repoUrl ? { _tag: "OpenUrl", url: context.thread.projectLabel.repoUrl } : { _tag: "None" }
    case "chat:archive": return action(AppAction.ArchiveChat({ chatId: chat.chatId }))
    case "chat:delete": return action(AppAction.DeleteChat({ chatId: chat.chatId, title: chat.title }))
    default: return null
  }
}
