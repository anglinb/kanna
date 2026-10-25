import type { Html, HtmlBuilder } from "foldkit/html"
import { formatSidebarAgeLabel } from "../../client/lib/formatters"
import { getSidebarChatTimestamp } from "../../client/lib/sidebarChats"
import type { AppModel } from "../app/slice"
import { buttonClass } from "../ui/button"
import * as Dialog from "../ui/dialog"
import { RotateCcw } from "../ui/icons"
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

/**
 * One project's archived chats (chat-ui/sidebar/ArchivedChatsDialog.tsx),
 * opened from its menu's Show Archived. Opening a chat closes it; restoring
 * leaves it open, since putting several back is one errand.
 */
export function archivedChatsDialog(app: AppModel, model: Model, h: H): Html {
  const project = model.archivedProjectId
    ? app.stores.sidebar.data.projectGroups.find((group) => group.groupKey === model.archivedProjectId) ?? null
    : null
  const chats = project?.archivedChats ?? []
  return h.submodel({
    slotId: "sidebar-archived-chats",
    model: model.archivedDialog,
    view: Dialog.view,
    viewInputs: {
      size: "md",
      content: ({ titleId, descriptionId }) => [
        Dialog.dialogHeader({}, [
          Dialog.dialogTitle({ id: titleId }, ["Archived Chats"], h),
          Dialog.dialogDescription({ id: descriptionId }, [project?.localPath ?? ""], h),
        ], h),
        Dialog.dialogBody({ class: "space-y-1" }, chats.length
          ? chats.map((chat) => h.keyed("div")(chat.chatId, [
            h.Class("group flex items-center gap-1 rounded-lg border border-border/0 pr-1 transition-colors hover:border-border hover:bg-muted"),
          ], [
            h.button([
              h.Type("button"),
              h.Class("flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-2 text-left"),
              h.OnClick(Message.ClickedArchivedDialogChat({ chatId: chat.chatId })),
            ], [
              h.span([h.Class("min-w-0 truncate text-sm")], [chat.title]),
              h.span([h.Class("shrink-0 text-xs text-muted-foreground")], [
                formatSidebarAgeLabel(chat.archivedAt ?? getSidebarChatTimestamp(chat), model.nowMs) ?? "",
              ]),
            ]),
            h.button([
              h.Class(buttonClass({ variant: "ghost", size: "icon", class: "h-7 w-7 shrink-0 rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" })),
              h.Title("Restore chat"),
              h.AriaLabel(`Restore ${chat.title}`),
              h.OnClick(Message.ClickedArchivedDialogRestore({ chatId: chat.chatId })),
            ], [RotateCcw({ class: "size-3.5" }, h)]),
          ]))
          : [h.p([h.Class("px-1 py-3 text-sm text-muted-foreground")], ["No archived chats"])], h),
      ],
    },
    toParentMessage: (message) => Message.GotArchivedDialogMessage({ message }),
  })
}
