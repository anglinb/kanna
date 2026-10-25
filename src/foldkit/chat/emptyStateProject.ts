import { Effect, Option } from "effect"
import commandScore from "command-score"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { formatSidebarAgeLabel } from "../../client/lib/formatters"
import { getSidebarChatTimestamp } from "../../client/lib/sidebarChats"
import { computeSidebarThreadSections, flattenSidebarThreads, listedThreads, type SidebarThread } from "../../client/lib/thread-sections"
import { cn } from "../../client/lib/utils"
import { waitingOnLabel } from "../../client/lib/waiting-on"
import { AUTH_SERVICE_ORDER, type SidebarChatRow } from "../../shared/types"
import type { AppModel } from "../app/slice"
import * as ChatInput from "../core/stores/chatInput"
import * as ProviderAuth from "../core/stores/providerAuth"
import { animatedShinyText } from "../ui/animated-shiny-text"
import { ChevronRight, Flower, Loader2, MessageCircle, PencilLine, Search } from "../ui/icons"
import { AUTH_SERVICE_ICONS, PROVIDER_ICONS } from "../ui/provider-icons"
import { domStream } from "../ui/overlay/stream"
import { DelegatorIcon } from "./chatRowMenu"
import { Message } from "./message"
import type { Model } from "./model"

// What the new chat page shows under its hero line (ChatPage/EmptyStateProject,
// EmptyStateAuthCards, EmptyStateUsageCards): onboarding while it applies,
// then the project's chats, a search field and the palette's headings and
// rows. The rows are the palette's row content (ThreadRowContent) in a
// widget row's box (ROW_HOVER_CLASS, WidgetListLabel), restated here: those
// are React files.

type H = HtmlBuilder<Message>

const RECENT_CHAT_LIMIT = 12
const SEARCH_RESULT_LIMIT = 20
/** The cascade's last start (280ms) plus its length (240ms), in index.css. */
const CASCADE_MS = 520

/** widgets/parts.tsx's ROW_HOVER_CLASS. */
const ROW_HOVER_CLASS = "hover:border-border hover:bg-muted data-[hover-card-open]:border-border data-[hover-card-open]:bg-muted data-[state=open]:border-border data-[state=open]:bg-muted [@media(hover:none)]:active:border-border [@media(hover:none)]:active:bg-muted"

/** ProjectChatSections' DELEGATORS_GROUP_KEY. */
const DELEGATORS_GROUP_KEY = "delegators"

interface ProjectChatGroup {
  key: string
  label: string
  threads: SidebarThread[]
}

/**
 * ProjectChatSections' getProjectChatGroups: one project's chats under the
 * sidebar Chats tab's headings, empty groups dropped.
 */
export function getProjectChatGroups(threads: SidebarThread[], nowMs: number, {
  includeArchived = true,
  limit,
}: { includeArchived?: boolean; limit?: number } = {}): ProjectChatGroup[] {
  const sections = computeSidebarThreadSections(threads, nowMs)
  let remaining = limit ?? Number.POSITIVE_INFINITY
  return [
    { key: "pinned", label: "Pinned", threads: sections.pinned },
    { key: DELEGATORS_GROUP_KEY, label: "Delegators", threads: sections.delegators },
    { key: "in-progress", label: "In Progress", threads: sections.inProgress },
    { key: "review", label: "Review", threads: sections.review },
    { key: "relevant", label: "Relevant", threads: sections.relevant },
    ...sections.buckets.map((bucket) => ({ key: bucket.key, label: bucket.label, threads: bucket.threads })),
    ...(includeArchived ? [{ key: "archived", label: "Archived", threads: sections.archived }] : []),
  ].map((group) => {
    const shown = group.threads.slice(0, Math.max(0, remaining))
    remaining -= shown.length
    return { ...group, threads: shown }
  }).filter((group) => group.threads.length > 0)
}

/** command-palette/actions' scorePaletteItem. */
export function scorePaletteItem(query: string, title: string, keywords: string[] = []): number {
  const trimmed = query.trim()
  if (!trimmed) return 1
  let best = commandScore(title, trimmed)
  for (const keyword of keywords) {
    if (best >= 1) break
    const score = commandScore(keyword, trimmed)
    if (score > best) best = score
  }
  return best
}

// THE ROW (ThreadRowContent, StatusMark)

const STATUS_MARK_SLOT_CLASS = "flex size-4 shrink-0 items-center justify-center"

function statusMark(kind: "working" | "waiting_on_subagent" | "waiting" | "unread", label: string | undefined, h: H): Html {
  if (kind === "working" || kind === "waiting_on_subagent") {
    return h.span([h.Class(STATUS_MARK_SLOT_CLASS)], [
      Loader2({ class: cn("size-3.5 animate-spin", kind === "working" ? "text-logo" : "text-muted-foreground"), ...(label ? { attributes: [h.AriaLabel(label)] } : {}) }, h),
    ])
  }
  const blue = kind === "waiting"
  return h.div([
    ...(label ? [h.Role("img"), h.AriaLabel(label)] : []),
    h.Class(cn("relative", STATUS_MARK_SLOT_CLASS)),
  ], [
    h.div([h.Class(cn("absolute size-2.5 rounded-full kanna-ping", blue ? "bg-blue-400/80" : "bg-emerald-400/80"))], []),
    h.div([h.Class(cn("size-2.5 rounded-full ring-2 ring-muted/20 dark:ring-muted/50", blue ? "bg-blue-400" : "bg-emerald-400"))], []),
  ])
}

/** renderChatStatusDot: what a row's head shows while the chat wants something. */
export function chatStatusDot(chat: SidebarChatRow, h: H): Html | null {
  if (chat.status === "starting" || chat.status === "running") return statusMark("working", undefined, h)
  if (chat.status === "waiting_on_subagent") return statusMark("waiting_on_subagent", waitingOnLabel(chat.waitingOn), h)
  if (chat.status === "waiting_for_user") return statusMark("waiting", undefined, h)
  return chat.unread ? statusMark("unread", undefined, h) : null
}

/** ThreadRowContent as the new chat page draws it: status, preview, no dimming, an age. */
function threadRowContent(thread: SidebarThread, options: { hasDraft: boolean; delegatorMark: boolean; detailLabel: string | null }, h: H): ReadonlyArray<Html> {
  const statusDot = !thread.archived ? chatStatusDot(thread.row, h) : null
  const previewText = thread.archived ? "Archived" : thread.row.lastUserMessagePreview?.trim() || null
  const showsDraft = options.hasDraft
  const isMarkedDelegator = options.delegatorMark && Boolean(thread.row.delegator)
  const iconClass = cn("h-4 w-4 shrink-0", showsDraft ? "text-logo" : thread.archived ? "text-muted-foreground/50" : "text-muted-foreground")
  const icon = statusDot ?? (showsDraft
    ? PencilLine({ class: iconClass }, h)
    : isMarkedDelegator
      ? DelegatorIcon({ class: iconClass }, h)
      : thread.row.provider
        ? PROVIDER_ICONS[thread.row.provider]({ class: iconClass }, h)
        : MessageCircle({ class: iconClass }, h))
  const running = thread.row.status === "running" || thread.row.status === "starting"
  return [
    icon,
    running
      ? animatedShinyText({ class: "!mx-0 min-w-0 shrink truncate", animate: thread.row.status === "running", shimmerWidth: Math.max(20, thread.title.length * 3) }, [thread.title], h)
      : h.span([h.Class("min-w-0 shrink truncate")], [thread.title]),
    previewText ? h.span([h.Class("-ml-1 min-w-0 flex-1 truncate text-xs text-muted-foreground")], [previewText]) : null,
    h.span([h.Class("ml-auto flex max-w-[50%] shrink-0 items-center gap-1.5 pl-3 text-xs")], [
      options.detailLabel == null ? null : h.span([h.Class("min-w-0 truncate text-muted-foreground")], [options.detailLabel]),
    ]),
  ].filter((child): child is Html => child !== null)
}

// SETUP (SetupCard)

/**
 * The "finish setup" entry shown on the new chat page until the setup
 * wizard has been completed. Connected services bright, missing ones muted.
 */
export function setupCardView(app: AppModel, h: H): Html | null {
  const auth = app.stores.providerAuth
  if (!ProviderAuth.showSetupCard(auth)) return null
  const status = ProviderAuth.setupStatus(auth)
  const subtitle = !status.anyAgentConnected ? "Connect your coding agents to start building." : "Connect the rest of your accounts."
  return h.button([
    h.Type("button"),
    h.OnClick(Message.ClickedSetup()),
    h.Class(cn("group w-full rounded-2xl border border-border bg-card/40 px-3.5 py-3 text-left transition-colors hover:border-primary/30 hover:bg-muted/40")),
  ], [
    h.div([h.Class("flex items-center justify-between gap-3")], [
      h.div([h.Class("flex min-w-0 items-center gap-2.5")], [
        Flower({ class: "h-4 w-4 shrink-0 text-logo" }, h),
        h.span([h.Class("truncate text-sm font-semibold text-foreground")], ["Set up Kanna"]),
      ]),
      h.span([h.Class("inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border px-2.5 py-1 text-xs font-semibold text-foreground transition-colors group-hover:bg-muted")], [
        "Setup",
        ChevronRight({ class: "h-3.5 w-3.5 -mr-0.5" }, h),
      ]),
    ]),
    h.div([h.Class("mt-2.5 flex items-center gap-3")], [
      h.div([h.Class("flex items-center gap-2.5")], AUTH_SERVICE_ORDER.map((id) => {
        const connected = ProviderAuth.selectAuthService(auth.snapshot, id)?.authStatus === "signed_in"
        return AUTH_SERVICE_ICONS[id]({ class: cn("h-4 w-4", connected ? "text-foreground" : "text-muted-foreground/40") }, h)
      })),
      h.span([h.Class("min-w-0 truncate text-xs text-muted-foreground")], [subtitle]),
    ]),
  ])
}

// THE PROJECT'S CHATS (EmptyStateProjectChats)

/**
 * As the list appears: the clock its ages read against (React's
 * `useState(() => Date.now())`), the cascade's end, and whether the search
 * has pinned under the header (an observer on its sentinel, since
 * `@container scroll-state(stuck)` isn't in every browser Kanna runs in).
 */
const ProjectChatsMount = Mount.defineStream("EmptyStateProjectChats", {
  messages: [Message.StartedProjectChats, Message.ElapsedProjectChatsCascade, Message.ChangedProjectChatsStuck],
  execute: ({ element }) => domStream<typeof Message.StartedProjectChats.Type | typeof Message.ElapsedProjectChatsCascade.Type | typeof Message.ChangedProjectChatsStuck.Type>((emit) => {
    emit(Message.StartedProjectChats({ nowMs: Date.now() }))
    const timeout = window.setTimeout(() => emit(Message.ElapsedProjectChatsCascade()), CASCADE_MS)
    const sentinel = element.querySelector<HTMLElement>("[data-project-chats-sentinel]")
    const root = sentinel?.closest<HTMLElement>("[data-empty-state-scroller]")
    let observer: IntersectionObserver | null = null
    if (sentinel && root) {
      const offset = Number.parseFloat(getComputedStyle(root).getPropertyValue("--empty-state-header-offset")) || 0
      observer = new IntersectionObserver(([entry]) => {
        if (!entry) return
        // Out of view below (a short window) isn't stuck; only above is.
        const rootTop = entry.rootBounds?.top ?? 0
        emit(Message.ChangedProjectChatsStuck({ stuck: !entry.isIntersecting && entry.boundingClientRect.top < rootTop }))
      }, { root, rootMargin: `-${offset}px 0px 0px 0px`, threshold: 0 })
      observer.observe(sentinel)
    }
    return () => {
      window.clearTimeout(timeout)
      observer?.disconnect()
    }
  }),
})

/** The search field keeps Escape to itself while it has a query to clear. */
const ProjectChatsSearchMount = Mount.define("EmptyStateProjectChatsSearch", {
  messages: [Message.CompletedSideEffect],
  execute: ({ element }) => Effect.gen(function* () {
    const stop = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (element as HTMLInputElement).value) event.stopPropagation()
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => element.addEventListener("keydown", stop as EventListener)),
      () => Effect.sync(() => element.removeEventListener("keydown", stop as EventListener)),
    )
    return Message.CompletedSideEffect()
  }),
})

export function projectThreads(app: AppModel, projectId: string, activeChatId: string | null): SidebarThread[] {
  const group = app.stores.sidebar.data.projectGroups.find((entry) => entry.groupKey === projectId)
  return group ? listedThreads(flattenSidebarThreads({ projectGroups: [group] })).filter((thread) => thread.chatId !== activeChatId) : []
}

export function projectChatGroups(threads: SidebarThread[], query: string, nowMs: number): ProjectChatGroup[] {
  const trimmedQuery = query.trim()
  if (trimmedQuery) {
    const matches = threads
      .map((thread) => ({ thread, score: scorePaletteItem(trimmedQuery, thread.title, [thread.row.lastUserMessagePreview ?? ""]) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || right.thread.lastActivityAt - left.thread.lastActivityAt)
      .slice(0, SEARCH_RESULT_LIMIT)
      .map((entry) => entry.thread)
    return [{ key: "results", label: "Results", threads: matches }]
  }
  return getProjectChatGroups(threads, nowMs, { includeArchived: false, limit: RECENT_CHAT_LIMIT })
}

/**
 * The project's chats: a search field, then the palette's headings and rows
 * less the archive and the chat you're on. Typing swaps the headings for one
 * list ranked by match. Enter opens the top match; Escape clears.
 * `cascadeIn` plays the rows in one after another, once.
 */
export function projectChatsView(model: Model, app: AppModel, projectId: string, activeChatId: string | null, cascadeIn: boolean, h: H): Html | null {
  const threads = projectThreads(app, projectId, activeChatId)
  // Nothing to find in a project without chats: no field, no list.
  if (threads.length === 0) return null
  const state = model.projectChats
  const nowMs = state.nowMs ?? Date.now()
  const query = state.query
  const trimmedQuery = query.trim()
  const groups = projectChatGroups(threads, query, nowMs)
  const firstMatch = groups[0]?.threads[0]
  const cascading = cascadeIn && !state.cascadeDone

  return h.keyed("div")(`project-chats-${activeChatId ?? ""}-${projectId}`, [
    h.Class(cn("relative mx-auto flex w-full max-w-xl flex-col gap-px text-left", cascading && "kanna-empty-state-cascade")),
    h.OnMount(ProjectChatsMount()),
  ], [
    h.div([h.DataAttribute("project-chats-sentinel", ""), h.AriaHidden(true), h.Class("pointer-events-none absolute inset-x-0 top-0 h-px")], []),
    h.label([
      ...(state.stuck ? [h.DataAttribute("stuck", "true")] : []),
      h.Class("sticky top-[var(--empty-state-header-offset,0px)] z-10 flex h-9 items-center gap-2 border-b border-border bg-background px-1.5 text-sm transition-colors focus-within:border-foreground/25 before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:hidden before:h-[var(--empty-state-header-offset,0px)] before:bg-background data-[stuck]:before:block"),
    ], [
      h.span([h.Class("flex w-4 shrink-0 items-center justify-center text-muted-foreground")], [Search({ class: "size-3.5" }, h)]),
      h.input([
        h.Type("search"),
        h.Value(query),
        h.OnInput((value) => Message.ChangedProjectChatsQuery({ value })),
        h.OnKeyDownPreventDefault((key) => {
          if (key === "Enter" && firstMatch && trimmedQuery) return Option.some(Message.ClickedProjectChat({ chatId: firstMatch.chatId }))
          if (key === "Escape" && query) return Option.some(Message.ChangedProjectChatsQuery({ value: "" }))
          return Option.none()
        }),
        h.Placeholder("Search chats"),
        h.AriaLabel("Search this project's chats"),
        h.Autocomplete("off"),
        h.Spellcheck(false),
        h.Class("h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"),
        h.OnMount(ProjectChatsSearchMount()),
      ]),
    ]),
    ...(trimmedQuery && !firstMatch
      ? [h.p([h.Class("px-[30px] pt-2.5 text-sm text-muted-foreground")], [`No chats match “${trimmedQuery}”`])]
      // Flat, not wrapped per group: the labels' padding is what spaces
      // the groups, and the rows on either side of a label touch it.
      : groups.flatMap((group) => [
        h.keyed("div")(`label-${group.key}`, [h.Class("flex w-full min-w-0 items-center gap-1 px-1.5 pb-1 pt-2.5 text-left first:pt-1")], [
          h.span([h.Class("min-w-0 truncate text-sm text-slate-500 dark:text-slate-400")], [group.label]),
        ]),
        ...group.threads.map((thread) => h.keyed("button")(`row-${group.key}-${thread.chatId}`, [
          h.Type("button"),
          h.OnClick(Message.ClickedProjectChat({ chatId: thread.chatId })),
          h.Class(cn("flex w-full min-w-0 items-center gap-2 rounded-lg border border-transparent px-[5px] py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring", ROW_HOVER_CLASS)),
        ], threadRowContent(thread, {
          hasDraft: ChatInput.chatHasDraft(app.stores.chatInput, thread.chatId),
          // Search results are one flat group, with no heading to say it.
          delegatorMark: group.key !== DELEGATORS_GROUP_KEY,
          detailLabel: formatSidebarAgeLabel(getSidebarChatTimestamp(thread.row), nowMs),
        }, h))),
      ])),
  ])
}

