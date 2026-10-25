import { Option } from "effect"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { formatSidebarAgeLabel } from "../../client/lib/formatters"
import type { ProjectSidebarLabel } from "../../client/lib/project-label"
import { getSidebarChatTimestamp } from "../../client/lib/sidebarChats"
import type { SidebarThread } from "../../client/lib/thread-sections"
import { cn, normalizeChatId } from "../../client/lib/utils"
import { waitingOnLabel } from "../../client/lib/waiting-on"
import type { SidebarChatRow } from "../../shared/types"
import { animatedShinyText } from "../ui/animated-shiny-text"
import type { Child } from "../ui/attributes"
import { buttonClass } from "../ui/button"
import { Archive, GitBranch, Loader2, MessageCircle, PencilLine, RotateCcw, Split } from "../ui/icons"
import { projectIcon } from "../ui/project-icon"
import { DelegatorIcon, PROVIDER_ICONS } from "./icons"
import { Message } from "./message"
import type { MenuTarget } from "./model"

type H = HtmlBuilder<Message>

// STATUS MARK (components/chat-ui/StatusMark.tsx)

/**
 * The slot every mark at the head of a row is drawn in: 16px, the size of the
 * harness icon the status glyph takes the place of, with the glyph centred.
 */
export const STATUS_MARK_SLOT_CLASS = "flex size-4 shrink-0 items-center justify-center"

export type StatusMarkKind = "working" | "waiting_on_subagent" | "waiting" | "unread"

/**
 * The sidebar's status marks, one per thing a row can want: the brand spinner
 * while working, a grey one while waiting on work handed off, a blue ping
 * when waiting on the user, a green ping when unread.
 */
export function statusMark(kind: StatusMarkKind, label: string | undefined, h: H): Html {
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

/**
 * Status glyph of a chat row: spinner while running, the same spinner in grey
 * while waiting on a subagent, a blue ping when waiting on the user, a green
 * ping when unread. Null for idle chats, so callers fall back to an icon.
 */
export function chatStatusDot(chat: SidebarChatRow, h: H): Html | null {
  if (chat.status === "starting" || chat.status === "running") return statusMark("working", undefined, h)
  if (chat.status === "waiting_on_subagent") return statusMark("waiting_on_subagent", waitingOnLabel(chat.waitingOn), h)
  if (chat.status === "waiting_for_user") return statusMark("waiting", undefined, h)
  return chat.unread ? statusMark("unread", undefined, h) : null
}

// PROJECT LABEL (components/chat-ui/ProjectLabel.tsx)

/** A project's name as the sidebar shows it: the repo, a branch glyph when off main. */
export function projectLabel(label: ProjectSidebarLabel, options: { class?: string; attributes?: ReadonlyArray<Attribute<Message> | ChildAttribute> }, h: H, children: ReadonlyArray<Child> = []): Html {
  return h.span([h.Class(cn("flex min-w-0 items-center gap-1", options.class)), ...(options.attributes ?? [])], [
    label.branchName ? GitBranch({ class: "size-2.5 shrink-0", strokeWidth: 2.5 }, h) : null,
    h.span([h.Class("min-w-0 truncate")], [label.name]),
    ...children,
  ])
}

// THREAD DETAIL (lib/thread-detail-label.tsx)

export type ThreadDetailScope = "cross-project" | "project-scoped"

/** What a chat row's trailing slot says: its project across projects, its age inside one. */
export function threadDetailLabel(thread: SidebarThread, scope: ThreadDetailScope, nowMs: number, h: H): Child | null {
  if (scope === "cross-project") return projectLabel(thread.projectLabel, {}, h)
  return formatSidebarAgeLabel(getSidebarChatTimestamp(thread.row), nowMs)
}

// THREAD ROW CONTENT (components/chat-ui/ThreadRowContent.tsx)

export interface ThreadRowContentOptions {
  showStatus?: boolean
  showPreview?: boolean
  isActive?: boolean
  dimIdleTitles?: boolean
  hasDraft?: boolean
  showProjectIcon?: boolean
  delegatorMark?: boolean
  detailLabel: Child | null
  hoverActions?: ReadonlyArray<Html>
}

/**
 * The inside of a thread row: status glyph or harness icon, the title
 * (shimmering while running), and the trailing detail, with hover actions
 * swapped in over it on desktop.
 */
export function threadRowContent(thread: SidebarThread, options: ThreadRowContentOptions, h: H): ReadonlyArray<Child> {
  const showStatus = options.showStatus ?? false
  const showPreview = options.showPreview ?? false
  const isActive = options.isActive ?? false
  const dimIdleTitles = options.dimIdleTitles ?? true
  const showsDraft = options.hasDraft ?? false
  const showProjectIcon = options.showProjectIcon ?? false
  const delegatorMark = options.delegatorMark ?? true
  const statusDot = showStatus && !thread.archived ? chatStatusDot(thread.row, h) : null
  const previewText = showPreview
    ? (thread.archived ? "Archived" : thread.row.lastUserMessagePreview?.trim() || null)
    : null
  const isMarkedDelegator = delegatorMark && Boolean(thread.row.delegator)
  const hasUncommittedWork = !thread.archived && Boolean(thread.row.uncommittedWork)
  const iconClass = cn("h-4 w-4 shrink-0", showsDraft ? "text-logo" : thread.archived ? "text-muted-foreground/50" : "text-muted-foreground")
  const needsAttention = thread.row.status !== "idle" || thread.row.unread
  const dimTitle = dimIdleTitles && !isActive && !hasUncommittedWork && !needsAttention

  const icon = (): Html => {
    if (statusDot) return statusDot
    if (showProjectIcon && !showsDraft && !isMarkedDelegator) {
      return projectIcon({ name: thread.projectTitle, iconUrl: thread.projectIconUrl, class: thread.archived ? "opacity-50" : undefined }, h)
    }
    if (showsDraft) return PencilLine({ class: iconClass }, h)
    if (isMarkedDelegator) return DelegatorIcon({ class: iconClass }, h)
    const ProviderIcon = thread.row.provider ? PROVIDER_ICONS[thread.row.provider] : null
    return ProviderIcon ? ProviderIcon({ class: iconClass }, h) : MessageCircle({ class: iconClass }, h)
  }

  const running = thread.row.status === "running" || thread.row.status === "starting"
  const detailLabel = options.detailLabel
  return [
    icon(),
    running
      ? animatedShinyText({
        class: "!mx-0 min-w-0 shrink truncate",
        animate: thread.row.status === "running",
        shimmerWidth: Math.max(20, thread.title.length * 3),
      }, [thread.title], h)
      : h.span([h.Class(cn("min-w-0 shrink truncate", dimTitle && "text-slate-500 dark:text-slate-400"))], [thread.title]),
    previewText
      ? h.span([h.Class("-ml-1 min-w-0 flex-1 truncate text-xs text-muted-foreground")], [previewText])
      : null,
    options.hoverActions
      ? h.span([h.Class("ml-auto relative flex h-6 min-w-12 max-w-[50%] shrink-0 items-center justify-end pl-3 text-xs")], [
        h.span([h.Class("peer/actions absolute inset-y-0 right-0 z-10 hidden md:flex items-center justify-end gap-0 md:opacity-0 md:hover:opacity-100")], options.hoverActions),
        h.span([h.Class("pointer-events-none flex min-w-0 items-center text-muted-foreground transition-opacity md:peer-hover/actions:opacity-0")], [
          h.span([h.Class("min-w-0 truncate")], [detailLabel ?? ""]),
        ]),
      ])
      : h.span([h.Class("ml-auto flex max-w-[50%] shrink-0 items-center gap-1.5 pl-3 text-xs")], [
        detailLabel == null ? null : h.span([h.Class("min-w-0 truncate text-muted-foreground")], [detailLabel]),
      ]),
  ].filter((child): child is Html => child !== null)
}

// MENU TRIGGER (Radix's ContextMenuTrigger asChild)

/**
 * Where the menu opens. A right click opens at the contextmenu event's
 * point, and a MouseEvent's coordinates are whole pixels, cut down from the
 * pointer's (Chromium truncates); a long touch press opens at the
 * PointerEvent's own, fractional point.
 */
function menuPoint(pointerType: string, clientX: number, clientY: number) {
  return pointerType === "mouse"
    ? { x: Math.trunc(clientX), y: Math.trunc(clientY) }
    : { x: clientX, y: clientY }
}

/**
 * What a right-click menu's trigger carries: `data-state`, and the right
 * click (or a long touch press) that opens the sidebar's one menu for
 * `target`.
 */
export function menuTriggerAttributes(target: MenuTarget, isOpen: boolean, h: H): ReadonlyArray<Attribute<Message>> {
  return [
    h.DataAttribute("state", isOpen ? "open" : "closed"),
    h.OnContextMenu(Message.RequestedMenu({ target })),
    h.OnPointerDown((pointerType, button, _screenX, _screenY, _timeStamp, clientX, clientY) =>
      Option.some(Message.PressedMenuTrigger({ target, pointerType, button, ...menuPoint(pointerType, clientX, clientY) }))),
    h.OnPointerMove((_x, _y, pointerType) =>
      pointerType !== "mouse" ? Option.some(Message.MovedOnMenuTrigger({ pointerType })) : Option.none()),
    h.OnPointerUp((_x, _y, pointerType) =>
      pointerType !== "mouse" ? Option.some(Message.MovedOnMenuTrigger({ pointerType })) : Option.none()),
  ]
}

// THREAD ROW (components/chat-ui/sidebar/ThreadRow.tsx)

const HOVER_ACTION_CLASS = buttonClass({ variant: "ghost", size: "icon", class: "h-6 w-6 shrink-0 cursor-pointer rounded-sm hover:!bg-transparent !border-0" })

export interface ThreadRowOptions {
  isActive: boolean
  archived?: boolean
  detailScope: ThreadDetailScope
  nowMs: number
  /** The number-jump keycap, while the modifier is held. */
  detailLabelOverride?: Html
  dimIdleTitles?: boolean
  showProjectIcon?: boolean
  delegatorMark?: boolean
  hasDraft: boolean
  /** The sidebar's one menu is open on this row. */
  menuOpen: boolean
  /** The list's hover card is up for this row. */
  hoverCardOpen: boolean
}

/**
 * The canonical sidebar chat row: a clickable div (so the hover-action
 * buttons can nest inside it), carrying `data-chat-id` for the
 * scroll-to-active lookup and the one hover card, and its right-click menu's
 * trigger.
 */
export function threadRow(thread: SidebarThread, options: ThreadRowOptions, h: H): Html {
  const archived = options.archived ?? false
  const chatId = thread.row.chatId
  const detailLabel = options.detailLabelOverride ?? threadDetailLabel(thread, options.detailScope, options.nowMs, h)
  const stop = { propagation: "Stop" as const }
  const hoverActions: ReadonlyArray<Html> = archived
    ? [
      h.button([
        h.Class(HOVER_ACTION_CLASS),
        h.OnClick(Message.ClickedRestoreChat({ chatId }), stop),
        h.Title("Restore chat"),
      ], [RotateCcw({ class: "size-3.5" }, h)]),
    ]
    : [
      ...(thread.row.canFork
        ? [h.button([
          h.Class(HOVER_ACTION_CLASS),
          h.OnClick(Message.ClickedForkChat({ chatId }), stop),
          h.Title("Fork chat"),
        ], [Split({ class: "size-3.5" }, h)])]
        : []),
      h.button([
        h.Class(HOVER_ACTION_CLASS),
        h.OnClick(Message.ClickedArchiveChat({ chatId }), stop),
        h.Title("Archive chat"),
      ], [Archive({ class: "size-3.5" }, h)]),
    ]

  return h.keyed("div")(thread.chatId, [
    ...menuTriggerAttributes({ _tag: "Chat", chatId, archived, inCard: false }, options.menuOpen, h),
    h.DataAttribute("chat-id", normalizeChatId(thread.chatId)),
    ...(options.hoverCardOpen ? [h.DataAttribute("hover-card-open", "")] : []),
    h.Class(cn(
      "group flex w-full cursor-pointer select-none items-center gap-2.5 rounded-lg border px-2 py-1.5 max-md:py-1.5 text-left text-sm max-md:text-base active:scale-[0.985] transition-transform",
      options.isActive
        ? "bg-muted hover:bg-muted border-border"
        : "border-border/0 hover:border-border hover:bg-muted/20 dark:hover:border-slate-400/10 data-[hover-card-open]:border-border data-[hover-card-open]:bg-muted/20 dark:data-[hover-card-open]:border-slate-400/10",
    )),
    h.OnClick(Message.ClickedChat({ chatId: thread.chatId, archived })),
  ], threadRowContent(thread, {
    showStatus: true,
    isActive: options.isActive,
    dimIdleTitles: options.dimIdleTitles,
    hasDraft: options.hasDraft,
    showProjectIcon: options.showProjectIcon,
    delegatorMark: options.delegatorMark,
    detailLabel,
    hoverActions,
  }, h))
}
