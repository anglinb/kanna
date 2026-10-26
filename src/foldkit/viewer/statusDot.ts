import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import { waitingOnLabel } from "../../client/lib/waiting-on"
import type { SidebarChatRow } from "../../shared/types"
import { Loader2 } from "../ui/icons"

// renderChatStatusDot (ThreadRowContent) and StatusMark, for the previewed
// chat's header icon: the sidebar's and the chat page's copies are each
// typed to their own slice's Messages (and importing chat/ from here would
// be a cycle), and these handle none.

const STATUS_MARK_SLOT_CLASS = "flex size-4 shrink-0 items-center justify-center"

type StatusMarkKind = "working" | "waiting_on_subagent" | "waiting" | "unread"

function statusMark<Message>(kind: StatusMarkKind, label: string | undefined, h: HtmlBuilder<Message>): Html {
  if (kind === "working" || kind === "waiting_on_subagent") {
    return h.span([h.Class(STATUS_MARK_SLOT_CLASS)], [
      Loader2({
        class: cn("size-3.5 animate-spin", kind === "working" ? "text-logo" : "text-muted-foreground"),
        // React passed `aria-label={label}` even when undefined: an unnamed image.
        attributes: [h.Attribute("aria-label", label ?? "")],
      }, h),
    ])
  }
  const blue = kind === "waiting"
  return h.div([
    ...(label ? [h.Role("img"), h.AriaLabel(label)] : []),
    h.Class(cn("relative", STATUS_MARK_SLOT_CLASS)),
  ], [
    h.div([h.Class(cn("absolute size-2.5 rounded-full kanna-ping", blue ? "bg-blue-400/80" : "bg-emerald-400/80"))]),
    h.div([h.Class(cn("size-2.5 rounded-full ring-2 ring-muted/20 dark:ring-muted/50", blue ? "bg-blue-400" : "bg-emerald-400"))]),
  ])
}

/** A chat's status glyph, or null for an idle chat (the caller falls back to an icon). */
export function chatStatusDot<Message>(chat: SidebarChatRow, h: HtmlBuilder<Message>): Html | null {
  if (chat.status === "starting" || chat.status === "running") return statusMark("working", undefined, h)
  if (chat.status === "waiting_on_subagent") return statusMark("waiting_on_subagent", waitingOnLabel(chat.waitingOn), h)
  if (chat.status === "waiting_for_user") return statusMark("waiting", undefined, h)
  return chat.unread ? statusMark("unread", undefined, h) : null
}
