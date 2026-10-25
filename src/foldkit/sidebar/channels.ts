import type { Html, HtmlBuilder } from "foldkit/html"
import { computeChannelSections, getChannelPeekGroups, type ChannelPeekGroup } from "../../client/lib/channel-sections"
import { isSubChat, isUnreadForUser } from "../../client/lib/thread-sections"
import { cn, normalizeChatId } from "../../client/lib/utils"
import type { SidebarProjectGroup } from "../../shared/types"
import type { AppModel } from "../app/slice"
import * as SidebarSection from "../core/stores/sidebarSection"
import { ChevronDown, SquarePen } from "../ui/icons"
import { projectIcon } from "../ui/project-icon"
import { draftStartTimes, hasDraft, pendingSendTimes } from "./derived"
import { chatHoverCard, LIST_HOVER_ATTRIBUTE, LIST_HOVER_CARD_ROOM_BELOW, listHoverCard, ListHoverTracker } from "./hoverCard"
import { Message } from "./message"
import type { MenuTarget, Model } from "./model"
import { chatStatusDot, menuTriggerAttributes, threadDetailLabel, threadRowContent } from "./rows"
import { menuOpenOn, sectionHeader } from "./sections"

type H = HtmlBuilder<Message>

// The Channels view (components/channels/ChannelList.tsx): every project as
// a channel, sorted into the Chats view's sections, each with a card of its
// chats beside it on hover.

/** What a channel's card holds (ChannelPeek's memo): the first groups, or all once "Show more" pinned it. */
export function channelPeekGroups(group: SidebarProjectGroup, pinned: boolean, app: AppModel, nowMs: number) {
  const drafts = draftStartTimes(app)
  const pending = pendingSendTimes(app)
  const all = getChannelPeekGroups(group, nowMs, drafts, pending, true)
  const first = getChannelPeekGroups(group, nowMs, drafts, pending)
  const countChats = (groups: ChannelPeekGroup[]) => groups.reduce((count, peekGroup) => count + peekGroup.threads.length, 0)
  // "Show more" takes a row. Hiding a single chat behind it saves nothing.
  const showAll = pinned || countChats(all) - countChats(first) <= 1
  return { peekGroups: showAll ? all : first, canShowMore: !showAll }
}

function channelPeek(group: SidebarProjectGroup, activeChatId: string | null, app: AppModel, model: Model, h: H): ReadonlyArray<Html> {
  const { peekGroups, canShowMore } = channelPeekGroups(group, model.pinnedChannelId === group.groupKey, app, model.nowMs)
  return [
    h.button([
      h.Type("button"),
      h.OnClick(Message.ClickedPeekNewChat({ projectId: group.groupKey })),
      h.Class("group/peek block w-full py-px text-left"),
    ], [
      h.span([h.Class("flex w-full items-center gap-2.5 rounded-lg border border-border/0 px-2 py-1.5 text-sm text-muted-foreground transition-colors group-hover/peek:border-border group-hover/peek:bg-muted group-hover/peek:text-foreground")], [
        SquarePen({ class: "size-4 shrink-0" }, h),
        h.span([], ["New Chat"]),
      ]),
    ]),
    // The chats' own list, which carries their hover card; keyed by the
    // channel, so moving to another channel starts it afresh.
    h.keyed("div")(`peek-${group.groupKey}`, [
      h.Attribute(LIST_HOVER_ATTRIBUTE, "peek"),
      h.OnMount(ListHoverTracker({ list: "peek" })),
      h.Class("overflow-y-auto overscroll-contain"),
      h.Style({ "max-height": `max(280px, calc(var(${LIST_HOVER_CARD_ROOM_BELOW}, 60vh) - 44px))` }),
    ], [
      ...peekGroups.map((peekGroup) => h.keyed("div")(peekGroup.key, [], [
        peekGroups.length > 1
          ? h.div([h.Class("px-1.5 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground")], [peekGroup.label])
          : null,
        ...peekGroup.threads.map((thread) => {
          const target: MenuTarget = { _tag: "Chat", chatId: thread.row.chatId, archived: false, inCard: true }
          const rowId = normalizeChatId(thread.chatId)
          return h.keyed("button")(thread.chatId, [
            ...menuTriggerAttributes(target, menuOpenOn(model, target), h),
            h.Type("button"),
            h.DataAttribute("chat-id", rowId),
            ...(model.hovered.peek === rowId && model.hasFinePointer ? [h.DataAttribute("hover-card-open", "")] : []),
            h.OnClick(Message.ClickedPeekChat({ chatId: thread.chatId })),
            h.Class("group/peek block w-full py-px text-left"),
          ], [
            h.span([h.Class(cn(
              "flex w-full items-center gap-2.5 rounded-lg border px-2 py-1.5 text-sm transition-colors",
              rowId === activeChatId
                ? "border-border bg-muted"
                : "border-border/0 group-hover/peek:border-border group-hover/peek:bg-muted group-data-[hover-card-open]/peek:border-border group-data-[hover-card-open]/peek:bg-muted",
            ))], threadRowContent(thread, {
              showStatus: true,
              dimIdleTitles: false,
              hasDraft: hasDraft(app, thread.chatId),
              delegatorMark: !(peekGroup.key === "delegators" && peekGroups.length > 1),
              detailLabel: threadDetailLabel(thread, "project-scoped", model.nowMs, h),
            }, h)),
          ])
        }),
      ])),
      canShowMore
        ? h.button([
          h.Type("button"),
          h.OnClick(Message.ClickedPeekShowMore({ projectId: group.groupKey })),
          h.Class("group/peek block w-full py-px text-left"),
        ], [
          h.span([h.Class("flex w-full items-center gap-2.5 rounded-lg border border-border/0 px-2 py-1.5 text-sm text-muted-foreground transition-colors group-hover/peek:border-border group-hover/peek:bg-muted")], [
            ChevronDown({ class: "size-4 shrink-0" }, h),
            h.span([], ["Show more"]),
          ]),
        ])
        : null,
    ]),
    // Each chat's own card, beside this one, 2px off it.
    chatHoverCard({ list: "peek", sideOffset: 9 }, app, model, h),
  ].filter((child): child is Html => child !== null)
}

function channelRow(group: SidebarProjectGroup, active: boolean, hoverCardOpen: boolean, model: Model, h: H): Html {
  const menuPinned = group.groupKey === model.pinnedChannelId
  const unread = group.chats.some(isUnreadForUser)
  const attentionCount = group.chats.filter((chat) => isUnreadForUser(chat) || chat.status === "waiting_for_user").length
  const leadChat = group.chats.find((chat) => chat.status === "running" || chat.status === "starting")
    ?? group.chats.find((chat) => chat.status === "waiting_for_user")
    ?? group.chats.find((chat) => chat.status === "waiting_on_subagent" && !isSubChat(chat))
    ?? group.chats.find(isUnreadForUser)
  const statusMark = leadChat ? chatStatusDot(leadChat, h) : null
  const target: MenuTarget = { _tag: "Project", projectId: group.groupKey, channel: true }
  return h.keyed("button")(group.groupKey, [
    ...menuTriggerAttributes(target, menuOpenOn(model, target), h),
    h.Type("button"),
    h.DataAttribute("channel-id", group.groupKey),
    ...(hoverCardOpen ? [h.DataAttribute("hover-card-open", "")] : []),
    h.OnClick(Message.ClickedChannel({ projectId: group.groupKey })),
    ...(active ? [h.AriaCurrent("page")] : []),
    h.Class("group/channel block w-full py-px text-left"),
  ], [
    h.span([h.Class(cn(
      "flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-sm transition-colors max-md:py-2 max-md:text-base",
      active
        ? "border-border bg-muted text-foreground"
        : menuPinned
          ? "border-border bg-muted"
          : "border-border/0 group-hover/channel:border-border group-hover/channel:bg-muted group-data-[hover-card-open]/channel:border-border group-data-[hover-card-open]/channel:bg-muted",
      !active && (unread ? "text-foreground" : "text-muted-foreground"),
      unread && "font-semibold",
    ))], [
      h.span([h.Class("flex size-4 shrink-0 items-center justify-center")], [
        statusMark ?? projectIcon({ name: group.title, iconUrl: group.iconUrl }, h),
      ]),
      h.span([h.Class("min-w-0 flex-1 truncate")], [group.title]),
      attentionCount > 0
        ? h.span([h.Class("flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-foreground/10 px-1 text-[11px] font-bold leading-none text-foreground")], [String(attentionCount)])
        : null,
    ]),
  ])
}

export interface ChannelListOptions {
  projectGroups: SidebarProjectGroup[]
  activeProjectId: string | null
  activeChatId: string | null
  /** A phone or a touch screen: a channel's chats are a page, with no card. */
  opensAsPage: boolean
}

export function channelList(options: ChannelListOptions, app: AppModel, model: Model, h: H): Html {
  const sections = computeChannelSections(options.projectGroups, model.nowMs, draftStartTimes(app), pendingSendTimes(app))
  const expandOverrides = SidebarSection.sectionOverrides(app.stores.sidebarSection, "channels")
  const shownKey = model.pinnedChannelId ?? model.hovered.channels
  const cardGroup = !options.opensAsPage && model.hasFinePointer && shownKey
    ? options.projectGroups.find((group) => group.groupKey === shownKey) ?? null
    : null
  const activeChat = options.activeChatId ? normalizeChatId(options.activeChatId) : null

  return h.keyed("div")("channel-list", [
    h.Attribute(LIST_HOVER_ATTRIBUTE, "channels"),
    h.DataAttribute("hover-pinned", model.pinnedChannelId ?? ""),
    h.OnMount(ListHoverTracker({ list: "channels" })),
  ], [
    ...sections.map((section) => {
      const isExpanded = !section.collapsible || (expandOverrides[section.key] ?? section.defaultExpanded)
      return h.keyed("div")(section.key, [], [
        sectionHeader({
          key: `channels-${section.key}`,
          label: section.label,
          isExpanded,
          toggle: section.collapsible ? Message.ToggledSection({ scope: "channels", sectionKey: section.key, expanded: !isExpanded }) : undefined,
        }, model, h),
        isExpanded
          ? h.div([h.Class("mb-3 flex flex-col")], section.groups.map((group) =>
            channelRow(group, group.groupKey === options.activeProjectId, cardGroup?.groupKey === group.groupKey, model, h)))
          : null,
      ])
    }),
    cardGroup
      ? listHoverCard({
        list: "channels",
        rowKey: cardGroup.groupKey,
        sideOffset: 10,
        alignOffset: -3,
        className: "rounded-[12px] bg-background px-1 py-[3px] backdrop-blur-none dark:bg-card",
      }, channelPeek(cardGroup, activeChat, app, model, h), h)
      : null,
  ])
}
