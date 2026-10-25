import type { Html, HtmlBuilder } from "foldkit/html"
import { formatSidebarAgeLabel } from "../../client/lib/formatters"
import type { ProjectSidebarLabel } from "../../client/lib/project-label"
import { getSidebarChatTimestamp } from "../../client/lib/sidebarChats"
import { computeSidebarThreadSections, type SidebarThread } from "../../client/lib/thread-sections"
import { cn } from "../../client/lib/utils"
import { waitingOnLabel } from "../../client/lib/waiting-on"
import type { SidebarChatRow } from "../../shared/types"
import { animatedShinyText } from "../ui/animated-shiny-text"
import type { Child } from "../ui/attributes"
import { GitBranch, Loader2, MessageCircle, PencilLine } from "../ui/icons"
import { DelegatorIcon, providerIcon } from "./icons"

// The palette's chat rows: chat-ui/ThreadRowContent.tsx (the parts the
// palette uses: no hover actions, no project icon), StatusMark.tsx,
// ProjectLabel.tsx, lib/thread-detail-label.tsx and the palette's
// ProjectChatSections.tsx grouping.

// STATUS MARKS (chat-ui/StatusMark.tsx)

const STATUS_MARK_SLOT_CLASS = "flex size-4 shrink-0 items-center justify-center"

type StatusMarkKind = "working" | "waiting_on_subagent" | "waiting" | "unread"

function statusMark<Message>(kind: StatusMarkKind, label: string | undefined, h: HtmlBuilder<Message>): Html {
  if (kind === "working" || kind === "waiting_on_subagent") {
    return h.span([h.Class(STATUS_MARK_SLOT_CLASS)], [
      Loader2({
        class: cn("size-3.5 animate-spin", kind === "working" ? "text-logo" : "text-muted-foreground"),
        // React passed `aria-label={label}` even when undefined, and
        // lucide-react drops its aria-hidden for any aria-* prop it is
        // handed: the spinner is an unnamed image. An empty label keeps that.
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

/** ThreadRowContent's `renderChatStatusDot`. */
function chatStatusDot<Message>(chat: SidebarChatRow, h: HtmlBuilder<Message>): Html | null {
  if (chat.status === "starting" || chat.status === "running") return statusMark("working", undefined, h)
  if (chat.status === "waiting_on_subagent") return statusMark("waiting_on_subagent", waitingOnLabel(chat.waitingOn), h)
  if (chat.status === "waiting_for_user") return statusMark("waiting", undefined, h)
  return chat.unread ? statusMark("unread", undefined, h) : null
}

// DETAIL LABEL (lib/thread-detail-label.tsx, chat-ui/ProjectLabel.tsx)

export type ThreadDetailScope = "cross-project" | "project-scoped"

function projectLabel<Message>(label: ProjectSidebarLabel, h: HtmlBuilder<Message>): Html {
  return h.span([h.Class("flex min-w-0 items-center gap-1")], [
    ...(label.branchName ? [GitBranch({ class: "size-2.5 shrink-0", strokeWidth: 2.5 }, h)] : []),
    h.span([h.Class("min-w-0 truncate")], [label.name]),
  ])
}

function threadDetailLabel<Message>(thread: SidebarThread, scope: ThreadDetailScope, nowMs: number, h: HtmlBuilder<Message>): Child | null {
  if (scope === "cross-project") return projectLabel(thread.projectLabel, h)
  return formatSidebarAgeLabel(getSidebarChatTimestamp(thread.row), nowMs)
}

// THE ROW

export interface ThreadRowOptions {
  showStatus: boolean
  hasDraft: boolean
  delegatorMark: boolean
  scope: ThreadDetailScope
  nowMs: number
}

/** ThreadRowContent with the palette's props: preview on, titles never dimmed. */
export function threadRowContent<Message>(thread: SidebarThread, options: ThreadRowOptions, h: HtmlBuilder<Message>): ReadonlyArray<Child> {
  const statusDot = options.showStatus && !thread.archived ? chatStatusDot(thread.row, h) : null
  const previewText = thread.archived ? "Archived" : thread.row.lastUserMessagePreview?.trim() || null
  const showsDraft = options.hasDraft
  const isMarkedDelegator = options.delegatorMark && Boolean(thread.row.delegator)
  const iconClass = cn("h-4 w-4 shrink-0", showsDraft ? "text-logo" : thread.archived ? "text-muted-foreground/50" : "text-muted-foreground")
  const icon = statusDot
    ?? (showsDraft
      ? PencilLine({ class: iconClass }, h)
      : isMarkedDelegator
        ? DelegatorIcon({ class: iconClass }, h)
        : thread.row.provider
          ? providerIcon(thread.row.provider, iconClass, h)
          : MessageCircle({ class: iconClass }, h))
  const detail = threadDetailLabel(thread, options.scope, options.nowMs, h)
  const running = thread.row.status === "running" || thread.row.status === "starting"
  return [
    icon,
    running
      ? animatedShinyText({
        class: "!mx-0 min-w-0 shrink truncate",
        animate: thread.row.status === "running",
        shimmerWidth: Math.max(20, thread.title.length * 3),
      }, [thread.title], h)
      : h.span([h.Class("min-w-0 shrink truncate")], [thread.title]),
    ...(previewText ? [h.span([h.Class("-ml-1 min-w-0 flex-1 truncate text-xs text-muted-foreground")], [previewText])] : []),
    h.span([h.Class("ml-auto flex max-w-[50%] shrink-0 items-center gap-1.5 pl-3 text-xs")], detail === null
      ? []
      : [h.span([h.Class("min-w-0 truncate text-muted-foreground")], [detail])]),
  ]
}

// PROJECT CHAT SECTIONS (command-palette/ProjectChatSections.tsx)

/** The key of the group headed "Delegators": its rows are drawn without the delegator's mark. */
export const DELEGATORS_GROUP_KEY = "delegators"

export interface ProjectChatGroup {
  key: string
  label: string
  threads: SidebarThread[]
}

/**
 * One project's chats under the sidebar Chats tab's headings: Pinned,
 * Delegators, In Progress, Review, Relevant, date buckets, Archived, with
 * empty groups dropped.
 */
export function getProjectChatGroups(threads: SidebarThread[], nowMs: number): ProjectChatGroup[] {
  const sections = computeSidebarThreadSections(threads, nowMs)
  return [
    { key: "pinned", label: "Pinned", threads: sections.pinned },
    { key: DELEGATORS_GROUP_KEY, label: "Delegators", threads: sections.delegators },
    { key: "in-progress", label: "In Progress", threads: sections.inProgress },
    { key: "review", label: "Review", threads: sections.review },
    { key: "relevant", label: "Relevant", threads: sections.relevant },
    ...sections.buckets.map((bucket) => ({ key: bucket.key, label: bucket.label, threads: bucket.threads })),
    { key: "archived", label: "Archived", threads: sections.archived },
  ].filter((group) => group.threads.length > 0)
}
