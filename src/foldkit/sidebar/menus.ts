import type { Html, HtmlBuilder } from "foldkit/html"
import type { SidebarThread } from "../../client/lib/thread-sections"
import { getRepoUrlLabel } from "../../shared/git-url"
import type { SidebarProjectGroup } from "../../shared/types"
import type { AppModel } from "../app/slice"
import type { Child } from "../ui/attributes"
import * as ContextMenu from "../ui/context-menu"
import {
  Archive,
  Code,
  Copy,
  EyeOff,
  FolderOpen,
  Github,
  Pencil,
  PencilOff,
  Pin,
  PinOff,
  RotateCcw,
  Split,
  SquarePen,
  Trash2,
  UserRoundPlus,
} from "../ui/icons"
import { editorLabel, everyThread, hasDraft } from "./derived"
import { DelegatorIcon } from "./icons"
import { Message } from "./message"
import type { MenuTarget, Model } from "./model"

type H = HtmlBuilder<Message>

// The sidebar's right-click menus (components/chat-ui/sidebar/Menus.tsx):
// a chat's (ChatRowMenu, as ThreadRowMenu fills it in), a project's
// (ProjectSectionMenu) and a date section's (Archive All). One menu for the
// whole sidebar, built for whatever it was opened on.

/** The chat a Chat target names, archived ones and sub-chats included. */
export function findThread(app: AppModel, chatId: string): SidebarThread | null {
  return everyThread(app.stores.sidebar.data).find((thread) => thread.row.chatId === chatId) ?? null
}

export function findProject(app: AppModel, projectId: string): SidebarProjectGroup | null {
  return app.stores.sidebar.data.projectGroups.find((group) => group.groupKey === projectId) ?? null
}

/** Grok chats get no chat tools, so one can't delegate; a delegator can always stop. */
function canToggleDelegator(thread: SidebarThread, archived: boolean) {
  return !archived && (Boolean(thread.row.delegator) || thread.row.provider !== "grok")
}

const DESTRUCTIVE_ITEM_CLASS = "text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"

function chatItems(thread: SidebarThread, archived: boolean, app: AppModel): ContextMenu.MenuEntry[] {
  const entries: ContextMenu.MenuEntry[] = []
  if (!archived) entries.push(ContextMenu.item({ value: "pin" }))
  if (canToggleDelegator(thread, archived)) entries.push(ContextMenu.item({ value: "delegator", title: "Takes effect on this chat's next turn" }))
  if (hasDraft(app, thread.row.chatId)) entries.push(ContextMenu.item({ value: "clear-draft" }), ContextMenu.separator())
  if (archived) entries.push(ContextMenu.item({ value: "restore" }), ContextMenu.separator())
  entries.push(
    ContextMenu.item({ value: "rename" }),
    ContextMenu.item({ value: "share" }),
    ContextMenu.item({ value: "fork", disabled: !thread.row.canFork }),
    ContextMenu.separator(),
    ContextMenu.item({ value: "new-chat" }),
    ContextMenu.item({ value: "copy-path" }),
    ContextMenu.item({ value: "open-finder" }),
    ContextMenu.item({ value: "open-editor" }),
  )
  if (thread.projectLabel.repoUrl) entries.push(ContextMenu.item({ value: "open-repo" }))
  entries.push(ContextMenu.separator())
  if (!archived) entries.push(ContextMenu.item({ value: "archive" }))
  entries.push(ContextMenu.item({ value: "delete", className: DESTRUCTIVE_ITEM_CLASS }))
  return entries
}

function projectItems(group: SidebarProjectGroup, channel: boolean, newChatDisabled: boolean): ContextMenu.MenuEntry[] {
  return [
    ContextMenu.item({ value: "new-chat", disabled: newChatDisabled }),
    ...(channel ? [ContextMenu.item({ value: "pin" })] : []),
    ContextMenu.item({ value: "rename" }),
    ContextMenu.item({ value: "copy-path" }),
    ContextMenu.item({ value: "show-archived" }),
    ContextMenu.item({ value: "open-finder" }),
    ContextMenu.item({ value: "open-editor" }),
    ...(group.repoUrl ? [ContextMenu.item({ value: "open-repo" })] : []),
    ContextMenu.item({ value: "hide" }),
  ]
}

/** An item's icon and label, as `<Icon className="h-3.5 w-3.5" /><span className="text-xs font-medium">`. */
function labelled(icon: Html, label: string, h: H): ReadonlyArray<Child> {
  return [icon, h.span([h.Class("text-xs font-medium")], [label])]
}

export function rowMenu(app: AppModel, model: Model, h: H): Html {
  const target = model.menuTarget
  const editor = editorLabel(app)
  let items: ContextMenu.MenuEntry[] = []
  let className: string | undefined
  let renderItem: (value: string) => ReadonlyArray<Child> = () => []

  if (target?._tag === "Chat") {
    const thread = findThread(app, target.chatId)
    if (thread) {
      items = chatItems(thread, target.archived, app)
      const pinned = Boolean(thread.row.pinnedAt)
      const delegator = Boolean(thread.row.delegator)
      const repoUrl = thread.projectLabel.repoUrl
      renderItem = (value) => {
        switch (value) {
          case "pin": return labelled(pinned ? PinOff({ class: "h-3.5 w-3.5" }, h) : Pin({ class: "h-3.5 w-3.5" }, h), pinned ? "Unpin" : "Pin", h)
          case "delegator": return labelled(DelegatorIcon({ class: "h-3.5 w-3.5" }, h), delegator ? "Stop Delegating" : "Make Delegator", h)
          case "clear-draft": return labelled(PencilOff({ class: "h-3.5 w-3.5" }, h), "Clear Draft", h)
          case "restore": return labelled(RotateCcw({ class: "h-3.5 w-3.5" }, h), "Restore", h)
          case "rename": return labelled(Pencil({ class: "h-3.5 w-3.5" }, h), "Rename", h)
          case "share": return labelled(UserRoundPlus({ class: "h-3.5 w-3.5" }, h), "Share", h)
          case "fork": return labelled(Split({ class: "h-3.5 w-3.5" }, h), "Fork", h)
          case "new-chat": return labelled(SquarePen({ class: "h-3.5 w-3.5" }, h), "New Chat", h)
          case "copy-path": return labelled(Copy({ class: "h-3.5 w-3.5" }, h), "Copy Path", h)
          case "open-finder": return labelled(FolderOpen({ class: "h-3.5 w-3.5" }, h), "Open in Finder", h)
          case "open-editor": return labelled(Code({ class: "h-3.5 w-3.5" }, h), `Open in ${editor}`, h)
          case "open-repo": return labelled(Github({ class: "h-3.5 w-3.5" }, h), `Open on ${repoUrl ? getRepoUrlLabel(repoUrl) : ""}`, h)
          case "archive": return labelled(Archive({ class: "h-3.5 w-3.5" }, h), "Archive Chat", h)
          case "delete": return labelled(Trash2({ class: "h-3.5 w-3.5" }, h), "Delete Chat", h)
          default: return []
        }
      }
    }
  } else if (target?._tag === "Project") {
    const group = findProject(app, target.projectId)
    if (group) {
      // The Projects view's New Chat waits for the connection; a channel's doesn't ask.
      const newChatDisabled = !target.channel && app.connectionStatus !== "connected"
      items = projectItems(group, target.channel, newChatDisabled)
      className = "[&_svg]:size-3.5"
      const pinned = group.pinnedAt != null
      renderItem = (value) => {
        switch (value) {
          case "new-chat": return [SquarePen({}, h), h.span([], ["New Chat"])]
          case "pin": return labelled(pinned ? PinOff({ class: "h-3.5 w-3.5" }, h) : Pin({ class: "h-3.5 w-3.5" }, h), pinned ? "Unpin" : "Pin", h)
          case "rename": return labelled(Pencil({ class: "h-3.5 w-3.5" }, h), "Rename", h)
          case "copy-path": return labelled(Copy({ class: "h-3.5 w-3.5" }, h), "Copy Path", h)
          case "show-archived": return labelled(Archive({ class: "h-3.5 w-3.5" }, h), "Show Archived", h)
          case "open-finder": return labelled(FolderOpen({ class: "h-3.5 w-3.5" }, h), "Show in Finder", h)
          case "open-editor": return labelled(Code({ class: "h-3.5 w-3.5" }, h), `Open in ${editor}`, h)
          case "open-repo": return labelled(Github({ class: "h-3.5 w-3.5" }, h), `Open on ${group.repoUrl ? getRepoUrlLabel(group.repoUrl) : ""}`, h)
          case "hide": return labelled(EyeOff({ class: "h-3.5 w-3.5" }, h), "Hide", h)
          default: return []
        }
      }
    }
  } else if (target?._tag === "Section") {
    items = [ContextMenu.item({ value: "archive-all" })]
    renderItem = (value) => (value === "archive-all" ? labelled(Archive({ class: "h-3.5 w-3.5" }, h), "Archive All", h) : [])
  }

  return h.submodel({
    slotId: "sidebar-row-menu",
    model: model.rowMenu,
    view: ContextMenu.view,
    viewInputs: {
      items,
      className,
      renderItem,
      toView: ({ portal }) => portal,
    },
    toParentMessage: (message) => Message.GotRowMenuMessage({ message }),
  })
}

/** Whether a target still names something in the snapshot (a menu on a chat that left closes). */
export function menuTargetExists(app: AppModel, target: MenuTarget): boolean {
  if (target._tag === "Chat") return findThread(app, target.chatId) !== null
  if (target._tag === "Project") return findProject(app, target.projectId) !== null
  return true
}
