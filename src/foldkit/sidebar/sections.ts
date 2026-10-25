import type { Html, HtmlBuilder } from "foldkit/html"
import { computeSidebarThreadSections, getArchivedThreads, mergeRelevantThreads, type SidebarThread } from "../../client/lib/thread-sections"
import { cn, normalizeChatId } from "../../client/lib/utils"
import type { AppModel } from "../app/slice"
import * as SidebarSection from "../core/stores/sidebarSection"
import { buttonClass } from "../ui/button"
import { ChevronRight, MoreHorizontal } from "../ui/icons"
import { draftStartTimes, hasDraft, pendingSendTimes } from "./derived"
import { Message } from "./message"
import type { MenuTarget, Model } from "./model"
import { menuTriggerAttributes, threadRow, type ThreadDetailScope } from "./rows"

type H = HtmlBuilder<Message>

/** Whether the sidebar's one menu is open on `target`. */
export function menuOpenOn(model: Model, target: MenuTarget): boolean {
  if (model.rowMenu.phase !== "Open" || !model.menuTarget) return false
  const current = model.menuTarget
  if (current._tag !== target._tag) return false
  if (current._tag === "Chat" && target._tag === "Chat") return current.chatId === target.chatId && current.inCard === target.inCard
  if (current._tag === "Project" && target._tag === "Project") return current.projectId === target.projectId && current.channel === target.channel
  if (current._tag === "Section" && target._tag === "Section") return current.chatIds.join(" ") === target.chatIds.join(" ")
  return false
}

// SECTION HEADER (ThreadSections.tsx's SectionHeader)

export interface SectionHeaderOptions {
  label: string
  /** Present: a collapse toggle. Absent: a static header (In Progress). */
  toggle?: Message
  isExpanded?: boolean
  /** The chats Archive All archives; present adds the "…" button and the menu. */
  archiveAll?: ReadonlyArray<string>
  /** A stable id for the "…" button, so the menu can open below it. */
  key: string
}

/**
 * Section header matching the Projects view's collapsible project headers:
 * the label, a trailing chevron when it folds, and with Archive All a hover
 * "…" button and the same item on right click.
 */
export function sectionHeader(options: SectionHeaderOptions, model: Model, h: H): Html {
  const collapsible = options.toggle !== undefined
  const target: MenuTarget | null = options.archiveAll ? { _tag: "Section", chatIds: [...options.archiveAll] } : null
  const moreId = `sidebar-section-more-${options.key}`
  return h.div([
    ...(target ? menuTriggerAttributes(target, menuOpenOn(model, target), h) : []),
    h.Class(cn(
      "group/section sticky top-0 z-10 relative flex items-center bg-background p-[10px] dark:bg-card",
      collapsible && "cursor-pointer select-none",
    )),
    ...(options.toggle ? [h.OnClick(options.toggle)] : []),
  ], [
    h.div([h.Class("flex items-center gap-1")], [
      h.span([h.Class("max-w-[150px] truncate whitespace-nowrap text-sm text-slate-500 max-md:text-base dark:text-slate-400")], [options.label]),
      collapsible
        ? h.span([h.Class("relative size-3.5 shrink-0")], [
          ChevronRight({ class: cn("translate-y-[1px] size-3.5 shrink-0 text-slate-400 transition-all duration-200", options.isExpanded && "rotate-90") }, h),
        ])
        : null,
    ]),
    target
      ? h.div([h.Class("absolute right-2 flex items-center gap-[1px] opacity-100 md:opacity-0 md:group-hover/section:opacity-100")], [
        h.button([
          h.Id(moreId),
          h.Class(buttonClass({ variant: "ghost", size: "icon", class: "h-5.5 w-5.5 !rounded" })),
          h.OnClick(Message.ClickedMoreButton({ target, buttonId: moreId }), { defaultAction: "Prevent", propagation: "Stop" }),
        ], [MoreHorizontal({ class: "size-3.5 text-slate-500 dark:text-slate-400" }, h)]),
      ])
      : null,
  ])
}

// THREAD SECTIONS (components/chat-ui/sidebar/ThreadSections.tsx)

export interface ThreadSectionsOptions {
  threads: SidebarThread[]
  activeChatId: string | null
  nowMs: number
  /** Which list's folds these are (`useSectionOverrides`). */
  expandScope?: string
  showProjectIcons?: boolean
  detailScope?: ThreadDetailScope
}

/**
 * Pinned, Delegators, In Progress, Relevant, the date buckets, then
 * Archived. Empty sections stay hidden; date buckets and Relevant offer
 * Archive All.
 */
export function threadSections(options: ThreadSectionsOptions, app: AppModel, model: Model, h: H): Html | null {
  const expandScope = options.expandScope ?? "chats"
  const showProjectIcons = options.showProjectIcons ?? false
  const detailScope = options.detailScope ?? "cross-project"
  const drafts = draftStartTimes(app)
  const sections = computeSidebarThreadSections(options.threads, options.nowMs, drafts, pendingSendTimes(app))
  const relevant = mergeRelevantThreads(sections, drafts)
  const normalizedActiveChatId = options.activeChatId ? normalizeChatId(options.activeChatId) : null
  const expandOverrides = SidebarSection.sectionOverrides(app.stores.sidebarSection, expandScope)
  const toggle = (key: string, defaultExpanded: boolean) =>
    Message.ToggledSection({ scope: expandScope, sectionKey: key, expanded: !(expandOverrides[key] ?? defaultExpanded) })

  const pinnedGroups = [
    { key: "pinned", heading: "Pinned", threads: sections.pinned, collapsible: true },
    { key: "delegators", heading: "Delegators", threads: sections.delegators, collapsible: true },
    { key: "in-progress", heading: "In Progress", threads: sections.inProgress, collapsible: false },
  ].filter((group) => group.threads.length > 0)

  if (
    pinnedGroups.length === 0
    && relevant.length === 0
    && sections.buckets.length === 0
    && sections.archived.length === 0
  ) return null

  const row = (thread: SidebarThread, rowOptions: { archived?: boolean; delegatorMark?: boolean } = {}) => {
    const archived = rowOptions.archived ?? false
    return threadRow(thread, {
      isActive: normalizeChatId(thread.chatId) === normalizedActiveChatId,
      archived,
      detailScope,
      nowMs: options.nowMs,
      dimIdleTitles: false,
      showProjectIcon: showProjectIcons,
      delegatorMark: rowOptions.delegatorMark ?? true,
      hasDraft: hasDraft(app, thread.row.chatId),
      menuOpen: menuOpenOn(model, { _tag: "Chat", chatId: thread.row.chatId, archived, inCard: false }),
      hoverCardOpen: model.hovered.chats === normalizeChatId(thread.chatId),
    }, h)
  }

  const section = (key: string, header: Html, rows: ReadonlyArray<Html> | null) =>
    h.keyed("div")(key, [], [
      header,
      rows ? h.div([h.Class("space-y-[2px] mb-3")], rows) : null,
    ])

  return h.keyed("div")("thread-sections", [], [
    ...pinnedGroups.map((group) => {
      const isExpanded = !group.collapsible || (expandOverrides[group.key] ?? true)
      return section(
        group.key,
        sectionHeader({
          key: `${expandScope}-${group.key}`,
          label: group.heading,
          isExpanded,
          toggle: group.collapsible ? toggle(group.key, true) : undefined,
        }, model, h),
        isExpanded ? group.threads.map((thread) => row(thread, { delegatorMark: group.key !== "delegators" })) : null,
      )
    }),
    ...(relevant.length > 0
      ? [(() => {
        const isExpanded = expandOverrides["relevant"] ?? true
        return section(
          "relevant",
          sectionHeader({
            key: `${expandScope}-relevant`,
            label: "Relevant",
            isExpanded,
            toggle: toggle("relevant", true),
            archiveAll: relevant.map((thread) => thread.row.chatId),
          }, model, h),
          isExpanded ? relevant.map((thread) => row(thread)) : null,
        )
      })()]
      : []),
    ...sections.buckets.map((bucket) => {
      const isExpanded = expandOverrides[bucket.key] ?? bucket.defaultExpanded
      return section(
        bucket.key,
        sectionHeader({
          key: `${expandScope}-${bucket.key}`,
          label: bucket.label,
          isExpanded,
          toggle: toggle(bucket.key, bucket.defaultExpanded),
          archiveAll: bucket.threads.map((thread) => thread.row.chatId),
        }, model, h),
        isExpanded ? bucket.threads.map((thread) => row(thread)) : null,
      )
    }),
    ...(sections.archived.length > 0
      ? [(() => {
        const isExpanded = expandOverrides["archived"] ?? false
        return section(
          "archived",
          sectionHeader({ key: `${expandScope}-archived`, label: "Archived", isExpanded, toggle: toggle("archived", false) }, model, h),
          isExpanded ? sections.archived.map((thread) => row(thread, { archived: true })) : null,
        )
      })()]
      : []),
  ])
}

// ARCHIVED VIEW (components/chat-ui/sidebar/ArchivedSection.tsx)

/** Every archived chat in the workspace, most recently archived first, one flat list. */
export function archivedSection(threads: SidebarThread[], activeChatId: string | null, nowMs: number, app: AppModel, model: Model, h: H): Html {
  const archived = getArchivedThreads(threads)
  const normalizedActiveChatId = activeChatId ? normalizeChatId(activeChatId) : null
  return h.keyed("div")("archived-section", [], [
    sectionHeader({ key: "archived-view", label: "Archived" }, model, h),
    archived.length === 0
      ? h.p([h.Class("p-2 mt-4 text-center text-sm text-slate-400")], ["No archived chats"])
      : h.div([h.Class("space-y-[2px] mb-3")], archived.map((thread) => threadRow(thread, {
        isActive: normalizeChatId(thread.chatId) === normalizedActiveChatId,
        archived: true,
        detailScope: "cross-project",
        nowMs,
        dimIdleTitles: false,
        hasDraft: hasDraft(app, thread.row.chatId),
        menuOpen: menuOpenOn(model, { _tag: "Chat", chatId: thread.row.chatId, archived: true, inCard: false }),
        hoverCardOpen: model.hovered.chats === normalizeChatId(thread.chatId),
      }, h))),
  ])
}
