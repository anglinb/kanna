import type { Html } from "foldkit/html"
import type { SubagentActivity } from "../../shared/types"
import { chatOpenMenuEntries, renderChatOpenMenuItem } from "../chat/chatReference"
import type { Child } from "../ui/attributes"
import * as ContextMenu from "../ui/context-menu"
import { Ban, Code, Copy, Eye, FolderOpen, Globe, GlobeLock, MessageSquare, Pencil, SquareArrowOutUpRight, Square, Trash2 } from "../ui/icons"
import type { ColumnContext, H } from "./context"
import { canIgnoreDiffFile, canIgnoreDiffFolder } from "./gitLogic"
import { Message } from "./message"
import { taskKindName, taskRowActions } from "./tasks"

// The column's one right-click menu (each row's ContextMenu in React), on
// whichever row it was opened: its items by target, and what they're
// called. A choice comes back as `Selected` with the item's value; the
// update does the work (React's onSelect).

const DESTRUCTIVE = "text-destructive focus:text-destructive"
const DISCARD = "text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"

/** An item's icon and label, as the diff rows set them. */
function labelled(icon: Html, label: string, h: H): ReadonlyArray<Child> {
  return [icon, h.span([h.Class("text-xs font-medium")], [label])]
}

/** An item's icon and label, as the other rows set them. */
function plain(icon: Html, label: string, h: H): ReadonlyArray<Child> {
  return [icon, h.span([], [label])]
}

export function findTask(context: ColumnContext, taskId: string): SubagentActivity | undefined {
  return (context.app.chat?.snapshot?.runtime.subagents ?? []).find((task) => task.id === taskId)
}

export function rowMenuView(context: ColumnContext, toolIds: ReadonlyMap<string, string>, h: H): Html {
  const { model, diffs } = context
  const target = model.menuTarget
  let items: ContextMenu.MenuEntry[] = []
  let renderItem: (value: string) => ReadonlyArray<Child> = () => []

  if (target?._tag === "DiffFile") {
    const file = diffs.files.find((candidate) => candidate.path === target.path)
    if (file) {
      const canIgnore = canIgnoreDiffFile(file)
      const canIgnoreFolder = canIgnoreDiffFolder(file)
      items = [
        ContextMenu.item({ value: "review" }),
        ContextMenu.item({ value: "open-editor" }),
        ContextMenu.item({ value: "open-finder" }),
        ContextMenu.item({ value: "discard", className: DISCARD }),
        ContextMenu.item({ value: "ignore-file", disabled: !canIgnore }),
        ContextMenu.item({ value: "ignore-folder", disabled: !canIgnoreFolder }),
        ContextMenu.separator(),
        ContextMenu.item({ value: "copy-path" }),
        ContextMenu.item({ value: "copy-relative" }),
      ]
      renderItem = (value) => {
        switch (value) {
          case "review": return labelled(Eye({ class: "h-3.5 w-3.5" }, h), "Review", h)
          case "open-editor": return labelled(Code({ class: "h-3.5 w-3.5" }, h), `Open in ${context.editorLabel}`, h)
          case "open-finder": return labelled(FolderOpen({ class: "h-3.5 w-3.5" }, h), "Open in Finder", h)
          case "discard": return labelled(Trash2({ class: "h-3.5 w-3.5" }, h), "Discard Changes", h)
          case "ignore-file": return labelled(Ban({ class: "h-3.5 w-3.5" }, h), "Ignore File", h)
          case "ignore-folder": return labelled(Ban({ class: "h-3.5 w-3.5" }, h), "Ignore folder...", h)
          case "copy-path": return labelled(Copy({ class: "h-3.5 w-3.5" }, h), "Copy File Path", h)
          case "copy-relative": return labelled(Copy({ class: "h-3.5 w-3.5" }, h), "Copy Relative Path", h)
          default: return []
        }
      }
    }
  } else if (target?._tag === "Task") {
    const task = findTask(context, target.taskId)
    if (task) {
      const actions = taskRowActions(task, { canJump: toolIds.has(task.id), isStopping: model.stopping.includes(task.id) })
      const stopLabel = task.chatId ? "Stop Chat" : `Stop ${taskKindName(task.type)}`
      items = [
        ...(task.chatId ? chatOpenMenuEntries(context.app, task.chatId) : []),
        ...(actions.showInChat ? [ContextMenu.item({ value: "show-in-chat" })] : []),
        ...(actions.stop ? [ContextMenu.item({ value: "stop", className: DESTRUCTIVE })] : []),
      ]
      renderItem = (value) => {
        if (value === "show-in-chat") return plain(MessageSquare({ class: "size-3.5" }, h), "Show in Chat", h)
        if (value === "stop") return plain(Square({ class: "size-3.5" }, h), stopLabel, h)
        return renderChatOpenMenuItem(value, context.app, h) ?? []
      }
    }
  } else if (target?._tag === "Schedule") {
    items = [ContextMenu.item({ value: "edit" })]
    renderItem = () => plain(Pencil({ class: "size-3.5" }, h), "Edit Schedule…", h)
  } else if (target?._tag === "Port") {
    const server = model.ports.servers.find((candidate) => candidate.port === target.port)
    if (server) {
      const exposing = model.ports.exposingPorts.includes(server.port)
      const publicSharing = context.app.stores.serverCapabilities.value?.publicSharing === true
      items = [
        ContextMenu.item({ value: "open" }),
        ...(server.publicUrl
          ? [ContextMenu.item({ value: "copy-public" }), ContextMenu.item({ value: "unexpose" })]
          : publicSharing ? [ContextMenu.item({ value: "expose", disabled: exposing })] : []),
        ContextMenu.item({ value: "kill", className: DESTRUCTIVE }),
      ]
      renderItem = (value) => {
        switch (value) {
          case "open": return plain(SquareArrowOutUpRight({ class: "size-3.5" }, h), "Open in New Tab", h)
          case "copy-public": return plain(Copy({ class: "size-3.5" }, h), "Copy Public URL", h)
          case "unexpose": return plain(GlobeLock({ class: "size-3.5" }, h), "Stop Exposing", h)
          case "expose": return plain(Globe({ class: "size-3.5" }, h), "Expose to Internet", h)
          case "kill": return plain(Trash2({ class: "size-3.5" }, h), "Kill Process", h)
          default: return []
        }
      }
    }
  } else if (target?._tag === "QuickAction") {
    items = [ContextMenu.item({ value: "delete", className: DESTRUCTIVE })]
    renderItem = () => plain(Trash2({ class: "size-3.5" }, h), "Delete", h)
  }

  return h.submodel({
    slotId: "widgets-row-menu",
    model: model.menu,
    view: ContextMenu.view,
    viewInputs: { items, renderItem, toView: ({ portal }) => portal },
    toParentMessage: (message) => Message.GotMenuMessage({ message }),
  })
}
