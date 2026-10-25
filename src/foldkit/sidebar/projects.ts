import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { getPathBasename } from "../../client/lib/formatters"
import { getProjectSidebarLabel, type ProjectSidebarLabel } from "../../client/lib/project-label"
import { cn, normalizeChatId } from "../../client/lib/utils"
import { APP_NAME } from "../../shared/branding"
import type { SidebarChatRow, SidebarProjectGroup } from "../../shared/types"
import type { AppModel } from "../app/slice"
import { buttonClass } from "../ui/button"
import { ChevronRight, MoreHorizontal, SquarePen } from "../ui/icons"
import { activeChatId, hasDraft, isProjectCollapsed, threadByChatId } from "./derived"
import { Message } from "./message"
import type { MenuTarget, Model } from "./model"
import { PortalToBody } from "./mounts"
import { menuTriggerAttributes, projectLabel, threadRow } from "./rows"
import { menuOpenOn } from "./sections"
import { tooltip } from "./tooltips"

type H = HtmlBuilder<Message>

// The Projects view (components/chat-ui/sidebar/LocalProjectsSection.tsx):
// each project a collapsible group of its chats, its header carrying the
// project's menu, and (in the old sidebar, on desktop) dragged to reorder.

const DRAG_REORDER_TRIGGER_OFFSET_PX = 20

interface RectLike {
  top: number
  height: number
}

/**
 * Where a dragged group would land (LocalProjectsSection's
 * `getProjectGroupReorderPreviewTargetId`, copied from the React file): the
 * group whose middle the dragged one's top, 20px in, has crossed.
 */
export function getProjectGroupReorderPreviewTargetId({
  activeId,
  groupIds,
  collisionRect,
  droppableRects,
}: {
  activeId: string
  groupIds: ReadonlyArray<string>
  collisionRect: Pick<RectLike, "top">
  droppableRects: { get(id: string): RectLike | undefined }
}) {
  const activeIndex = groupIds.indexOf(activeId)
  if (activeIndex === -1) return null
  const activeRect = droppableRects.get(activeId)
  if (!activeRect) return null
  const previewTriggerY = collisionRect.top + DRAG_REORDER_TRIGGER_OFFSET_PX
  const centerY = (rect: RectLike) => rect.top + rect.height / 2
  if (collisionRect.top > activeRect.top) {
    for (let index = groupIds.length - 1; index > activeIndex; index--) {
      const rect = droppableRects.get(groupIds[index]!)
      if (!rect) continue
      if (previewTriggerY >= centerY(rect)) return groupIds[index]!
    }
    return activeId
  }
  if (collisionRect.top < activeRect.top) {
    for (let index = 0; index < activeIndex; index++) {
      const rect = droppableRects.get(groupIds[index]!)
      if (!rect) continue
      if (previewTriggerY <= centerY(rect)) return groupIds[index]!
    }
    return activeId
  }
  return activeId
}

/** dnd-kit's `arrayMove`. */
export function arrayMove<T>(items: ReadonlyArray<T>, from: number, to: number): T[] {
  const next = [...items]
  next.splice(to < 0 ? next.length + to : to, 0, next.splice(from, 1)[0]!)
  return next
}

/** What DndContext puts at the end of <body> for screen readers, whether or not anything drags. */
const DND_INSTRUCTIONS = "To pick up a draggable item, press the space bar. While dragging, use the arrow keys to move the item. Press space again to drop the item in its new position, or press escape to cancel."
export const DND_DESCRIBED_BY_ID = "DndDescribedBy-0"

function dndAccessibility(h: H): ReadonlyArray<Html> {
  return [
    h.keyed("div")(DND_DESCRIBED_BY_ID, [h.Id(DND_DESCRIBED_BY_ID), h.Style({ display: "none" }), h.OnMount(PortalToBody())], [DND_INSTRUCTIONS]),
    h.keyed("div")("DndLiveRegion-0", [
      h.Id("DndLiveRegion-0"),
      h.Role("status"),
      h.AriaLive("assertive"),
      h.AriaAtomic(true),
      h.Style({
        position: "fixed",
        top: "0px",
        left: "0px",
        width: "1px",
        height: "1px",
        margin: "-1px",
        border: "0px",
        padding: "0px",
        overflow: "hidden",
        clip: "rect(0px, 0px, 0px, 0px)",
        "clip-path": "inset(100%)",
        "white-space": "nowrap",
      }),
      h.OnMount(PortalToBody()),
    ]),
  ]
}

export interface LocalProjectsOptions {
  projectGroups: SidebarProjectGroup[]
  isConnected: boolean
  /** New Sidebar mode: by activity, no reorder, every chat shown. */
  newSidebar: boolean
  numberJumpKeycap: (chatId: string) => Html | undefined
}

export function localProjectsSection(options: LocalProjectsOptions, app: AppModel, model: Model, h: H): Html {
  const isReorderEnabled = !options.newSidebar && !model.isPhoneLayout
  const threadsById = threadByChatId(app)
  const chatId = activeChatId(app)
  const drag = model.projectDrag?.active ? model.projectDrag : null
  const groupIds = options.projectGroups.map((group) => group.groupKey)
  const activeIndex = drag ? groupIds.indexOf(drag.projectId) : -1
  const overIndex = drag?.overId ? groupIds.indexOf(drag.overId) : -1

  const renderChatRow = (chat: SidebarChatRow): Html | null => {
    const thread = threadsById.get(chat.chatId)
    if (!thread) return null
    return threadRow(thread, {
      isActive: chatId === normalizeChatId(chat.chatId),
      detailScope: "project-scoped",
      nowMs: model.nowMs,
      detailLabelOverride: options.numberJumpKeycap(chat.chatId),
      hasDraft: hasDraft(app, chat.chatId),
      menuOpen: menuOpenOn(model, { _tag: "Chat", chatId: chat.chatId, archived: false, inCard: false }),
      hoverCardOpen: model.hovered.chats === normalizeChatId(chat.chatId),
    }, h)
  }

  /** verticalListSortingStrategy: the dragged group follows the pointer, the ones it passes step aside. */
  const dragTransform = (index: number): string | null => {
    if (!drag || activeIndex === -1) return null
    if (index === activeIndex) return `translate3d(0px, ${drag.deltaY}px, 0)`
    if (overIndex === -1) return null
    const height = drag.activeHeight
    if (activeIndex < overIndex && index > activeIndex && index <= overIndex) return `translate3d(0px, ${-height}px, 0)`
    if (activeIndex > overIndex && index < activeIndex && index >= overIndex) return `translate3d(0px, ${height}px, 0)`
    return null
  }

  const group = (projectGroup: SidebarProjectGroup, index: number): Html => {
    const { groupKey, localPath, title } = projectGroup
    const label: ProjectSidebarLabel = options.newSidebar ? getProjectSidebarLabel(projectGroup) : { name: title, text: title }
    const headerLabel: ProjectSidebarLabel = label.name ? label : { ...label, name: getPathBasename(localPath) }
    const collapsed = isProjectCollapsed(model, projectGroup)
    const isExpanded = options.newSidebar || model.expandedGroups.includes(groupKey)
    const isEmptyProject = projectGroup.chats.length === 0
    const hasMore = projectGroup.olderChats.length > 0
    const isDragging = drag?.projectId === groupKey
    const newChatDisabled = !options.isConnected
    const target: MenuTarget = { _tag: "Project", projectId: groupKey, channel: false }
    const moreId = `sidebar-project-more-${groupKey}`
    const transform = dragTransform(index)

    const header = h.div([
      ...menuTriggerAttributes(target, menuOpenOn(model, target), h),
      h.Class(cn(
        "sticky top-0 bg-background dark:bg-card z-10 relative p-[10px] flex items-center justify-between",
        "md:cursor-grab md:active:cursor-grabbing md:select-none md:touch-none",
        isDragging && "cursor-grabbing",
      )),
      h.OnClick(Message.ToggledProjectGroup({ projectId: groupKey })),
      ...(isReorderEnabled
        ? [h.OnPointerDown((pointerType, button, _screenX, _screenY, _timeStamp, _clientX, clientY, pointerId) =>
          (button === 0 || pointerType !== "mouse") ? Option.some(Message.PressedProjectHeader({ projectId: groupKey, pointerId, y: clientY })) : Option.none())]
        : []),
    ], [
      h.div([h.Class("flex min-w-0 flex-1 items-center gap-1.5 pr-14")], [
        tooltip(`project-label-${groupKey}`, { side: "right", sideOffset: 4, content: [localPath] }, model, h, (trigger, portal) =>
          projectLabel(headerLabel, { class: "whitespace-nowrap text-sm max-md:text-base", attributes: trigger }, h, [portal])),
        h.span([h.Class("relative size-3.5 shrink-0 cursor-pointer")], [
          // `${!collapsed && 'rotate-90'}` in React, which writes "false" when folded.
          ChevronRight({ class: `translate-y-[1px] size-3.5 shrink-0 text-slate-400 transition-all duration-200 ${!collapsed && "rotate-90"}` }, h),
        ]),
      ]),
      h.div([h.Class("absolute right-2 flex items-center gap-[1px] opacity-100 md:opacity-0 md:group-hover/section:opacity-100")], [
        tooltip(`project-more-${groupKey}`, { side: "right", sideOffset: 4, content: ["More"] }, model, h, (trigger, portal) =>
          h.button([
            ...trigger,
            h.Id(moreId),
            h.Class(buttonClass({ variant: "ghost", size: "icon", class: "h-5.5 w-5.5 !rounded" })),
            h.OnClick(Message.ClickedMoreButton({ target, buttonId: moreId }), { defaultAction: "Prevent", propagation: "Stop" }),
          ], [MoreHorizontal({ class: "size-3.5 text-slate-500 dark:text-slate-400" }, h), portal])),
        tooltip(`project-new-${groupKey}`, { side: "right", sideOffset: 4, content: [!options.isConnected ? `Start ${APP_NAME} to connect` : "New Chat"] }, model, h, (trigger, portal) =>
          h.button([
            ...trigger,
            h.Class(buttonClass({ variant: "ghost", size: "icon", class: cn("h-5.5 w-5.5 !rounded", newChatDisabled && "opacity-50 cursor-not-allowed") })),
            ...(newChatDisabled ? [h.Disabled(true)] : []),
            h.OnClick(Message.ClickedNewProjectChat({ localPath }), { propagation: "Stop" }),
          ], [SquarePen({ class: "size-3.5 text-slate-500 dark:text-slate-400" }, h), portal])),
      ]),
    ])

    const chats = (): ReadonlyArray<Html> => {
      if (isEmptyProject) {
        return [h.button([
          h.Type("button"),
          ...(newChatDisabled ? [h.Disabled(true)] : []),
          h.Title(!options.isConnected ? `Start ${APP_NAME} to connect` : "New Chat"),
          h.Class(cn(
            "group flex w-full items-center gap-2.5 rounded-lg border px-2 py-1.5 max-md:py-1.5 text-left text-sm max-md:text-base cursor-pointer hover:border-border hover:bg-muted/20 active:scale-[0.985] transition-transform",
            "border-border/0 dark:hover:border-slate-400/10",
            newChatDisabled && "cursor-not-allowed opacity-50 active:scale-100",
          )),
          h.OnClick(Message.ClickedNewProjectChat({ localPath })),
        ], [
          h.div([h.Class("h-4 w-4 shrink-0"), h.AriaHidden(true)]),
          h.span([h.Class("min-w-0 shrink truncate text-slate-500 dark:text-slate-400")], ["New Chat"]),
          h.div([h.Class("ml-auto h-6 min-w-12 shrink-0 pl-3"), h.AriaHidden(true)]),
        ])]
      }
      return [
        ...projectGroup.previewChats.map(renderChatRow),
        !options.newSidebar && hasMore && isExpanded
          ? h.button([
            h.OnClick(Message.ToggledExpandedGroup({ projectId: groupKey })),
            h.Class("pl-2.5 py-1 text-xs text-muted-foreground/60 hover:text-foreground/60 transition-colors flex flex-row items-center gap-2 justify-center"),
          ], ["Show less"])
          : null,
        ...(isExpanded ? projectGroup.olderChats.map(renderChatRow) : []),
        !options.newSidebar && hasMore && !isExpanded
          ? h.button([
            h.OnClick(Message.ToggledExpandedGroup({ projectId: groupKey })),
            h.Class("pl-2.5 py-1 text-xs text-muted-foreground/60 hover:text-foreground/60 transition-colors flex flex-row items-center gap-1 justify-center"),
          ], ["Show more"])
          : null,
      ].filter((child): child is Html => child !== null)
    }

    return h.keyed("div")(groupKey, [
      h.DataAttribute("project-group", groupKey),
      ...(transform ? [h.Style({ transform, ...(isDragging ? {} : { transition: "transform 250ms ease" }) })] : []),
      h.Class(cn("group/section", isDragging && "opacity-50 shadow-lg z-50 relative")),
      ...(isReorderEnabled
        ? [
          h.Role("button"),
          h.Tabindex(0),
          h.AriaDisabled(false),
          h.AriaRoleDescription("sortable"),
          h.AriaDescribedBy(DND_DESCRIBED_BY_ID),
        ]
        : []),
    ], [
      header,
      !collapsed && (isEmptyProject ? true : projectGroup.previewChats.length > 0 || hasMore)
        ? h.div([h.Class("space-y-[2px] mb-3")], chats())
        : null,
    ])
  }

  // DndContext renders no element of its own; its screen-reader nodes go to <body>.
  return h.div([h.Class("contents")], [
    ...options.projectGroups.map(group),
    ...dndAccessibility(h),
  ])
}
