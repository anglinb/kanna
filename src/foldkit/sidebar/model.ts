import { Schema } from "effect"
import type { PairSessionState } from "../../client/lib/pairSession"
import { SIDEBAR_WIDTH_STORAGE_KEY } from "../../client/lib/storageKeys"
import { SIDEBAR_MAX_WIDTH_PX } from "../../client/lib/sidebarWidth"
import { opaque } from "../core/schema"
import { readStorageItem } from "../core/storage"
import * as ChatCard from "../ui/chat-hover-card"
import * as ContextMenu from "../ui/context-menu"
import * as Dialog from "../ui/dialog"
import * as Popover from "../ui/popover"
import * as Tooltip from "../ui/tooltip"

// The left sidebar's own state: what KannaSidebar.tsx and the components it
// renders kept in React state and refs. Everything it only reads (the
// sidebar snapshot, the view, focus mode, section folds, drafts, settings)
// stays in the root's stores and comes in through `app`.

export const DEFAULT_SIDEBAR_WIDTH = 275
export const MIN_SIDEBAR_WIDTH = 220
export const MAX_SIDEBAR_WIDTH = SIDEBAR_MAX_WIDTH_PX

export function clampSidebarWidth(width: number) {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)))
}

export function readStoredSidebarWidth(storage?: Storage) {
  const stored = readStorageItem(SIDEBAR_WIDTH_STORAGE_KEY, storage)
  return stored ? clampSidebarWidth(Number(stored)) : DEFAULT_SIDEBAR_WIDTH
}

/**
 * What a right-click menu is open on. One menu for the whole sidebar (at most
 * one is ever up), told what it is for when it opens.
 *
 *  - Chat: a chat row, anywhere a chat is listed (`ThreadRowMenu`). `inCard`
 *    for the chats in a channel's card, whose navigating items close the card.
 *  - Project: a project header (Projects view) or a channel (`ProjectSectionMenu`).
 *  - Section: a date bucket or Relevant's header, with the chats it held
 *    when the menu opened (Archive All).
 */
export const MenuTarget = Schema.Union([
  Schema.TaggedStruct("Chat", { chatId: Schema.String, archived: Schema.Boolean, inCard: Schema.Boolean }),
  Schema.TaggedStruct("Project", { projectId: Schema.String, channel: Schema.Boolean }),
  Schema.TaggedStruct("Section", { chatIds: Schema.Array(Schema.String) }),
])
export type MenuTarget = typeof MenuTarget.Type

/** The lists that carry a hover card (`ListHoverCard`): the sidebar's chats, the channels, and the chats in a channel's card. */
export const HoverList = Schema.Literals(["chats", "channels", "peek"])
export type HoverList = typeof HoverList.Type

/** A project header being dragged to a new place (dnd-kit's sortable, by hand). */
export const ProjectDrag = Schema.Struct({
  projectId: Schema.String,
  pointerId: Schema.Number,
  startY: Schema.Number,
  /** Past the 2px activation distance: until then it is a click. */
  active: Schema.Boolean,
  deltaY: Schema.Number,
  /** Where it would land now (dnd-kit's `over`), as a project id. */
  overId: Schema.NullOr(Schema.String),
  /** The dragged group's height: how far the groups it passes step aside. */
  activeHeight: Schema.Number,
})
export type ProjectDrag = typeof ProjectDrag.Type

const HoverKeys = Schema.Struct({
  chats: Schema.NullOr(Schema.String),
  channels: Schema.NullOr(Schema.String),
  peek: Schema.NullOr(Schema.String),
})

export const Model = Schema.Struct({
  /** Anchor for ages and date buckets; moved every 30s, as KannaSidebar's `nowMs`. */
  nowMs: Schema.Number,
  /**
   * Project groups folded or opened in the Projects view, against their
   * `defaultCollapsed` (which React applied the first time it saw a group).
   */
  projectFolds: Schema.Record(Schema.String, Schema.Boolean),
  /** Groups showing their older chats ("Show more"). */
  expandedGroups: Schema.Array(Schema.String),
  showNumberJumpHints: Schema.Boolean,
  sidebarWidth: Schema.Number,
  resizeStart: Schema.NullOr(Schema.Struct({ pointerX: Schema.Number, width: Schema.Number })),
  /** The collapsed card shown over the chat while the mouse is at the window's edge. */
  peeking: Schema.Boolean,
  hasFinePointer: Schema.Boolean,
  isPhoneLayout: Schema.Boolean,
  /** Installed as an app (display-mode: standalone): the footer clears the home indicator. */
  isStandalone: Schema.Boolean,
  /** Which project's archived chats the dialog shows. */
  archivedProjectId: Schema.NullOr(Schema.String),
  archivedDialog: Dialog.Model,
  rowMenu: ContextMenu.Model,
  menuTarget: Schema.NullOr(MenuTarget),
  viewSwitcher: Popover.Model,
  machineSwitcher: Popover.Model,
  pairDialog: Dialog.Model,
  /** The machine being switched to (MachineSwitcher's `switchingTo`). */
  switchingTo: Schema.NullOr(Schema.String),
  switchVersion: Schema.Number,
  /** This machine's Kanna Cloud pairing (useCloudPairSession). */
  pairSession: opaque<PairSessionState>("PairSessionState"),
  pairStarting: Schema.Boolean,
  /** A claim URL was asked for once already this load: reopening never burns a code. */
  pairBegun: Schema.Boolean,
  pairPollVersion: Schema.Number,
  /** The claim link was just copied: the button shows a check for 1.6s. */
  pairCopied: Schema.Boolean,
  pairCopyVersion: Schema.Number,
  /** Tooltips, one per trigger, made the first time each is pointed at. */
  tooltips: Schema.Record(Schema.String, Tooltip.Model),
  /** The row each list's hover card is up for. */
  hovered: HoverKeys,
  /** The channel whose card is pinned open ("Show more"). */
  pinnedChannelId: Schema.NullOr(Schema.String),
  /** The chat card's fetches and what the open card holds (ui/chat-hover-card.ts), for both of its lists. */
  card: ChatCard.CardData,
  /** A Cmd/Ctrl-click on a chat, heard before the row's own click. */
  backgroundClickChatId: Schema.NullOr(Schema.String),
  projectDrag: Schema.NullOr(ProjectDrag),
  /** dnd-kit's live-region announcement: the last thing a drag said (its default announcements). */
  dndAnnouncement: Schema.String,
})
export type Model = typeof Model.Type

export const ROW_MENU_ID = "sidebar-row-menu"

function matchesMedia(query: string) {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches
}

export const PHONE_LAYOUT_QUERY = "(max-width: 767px)"
export const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)"
export const STANDALONE_QUERY = "(display-mode: standalone)"

export function isStandaloneNow() {
  if (typeof window === "undefined") return false
  return (navigator as { standalone?: boolean }).standalone === true || matchesMedia(STANDALONE_QUERY)
}

export function init(storage?: Storage): Model {
  return {
    // React read these synchronously on the first render (useState's
    // initializer, useSyncExternalStore); the fine pointer waits for its
    // effect, so it starts false as useHasFinePointer's did.
    nowMs: Date.now(),
    projectFolds: {},
    expandedGroups: [],
    showNumberJumpHints: false,
    // React read this in useState's initializer, before the first paint.
    sidebarWidth: readStoredSidebarWidth(storage),
    resizeStart: null,
    peeking: false,
    hasFinePointer: false,
    isPhoneLayout: matchesMedia(PHONE_LAYOUT_QUERY),
    isStandalone: isStandaloneNow(),
    archivedProjectId: null,
    archivedDialog: Dialog.init({ id: "sidebar-archived-chats" }),
    rowMenu: ContextMenu.init({ id: ROW_MENU_ID }),
    menuTarget: null,
    viewSwitcher: Popover.init({ id: "sidebar-view-switcher" }),
    machineSwitcher: Popover.init({ id: "sidebar-machine-switcher" }),
    pairDialog: Dialog.init({ id: "sidebar-cloud-pair" }),
    switchingTo: null,
    switchVersion: 0,
    pairSession: { status: "idle" },
    pairStarting: false,
    pairBegun: false,
    pairPollVersion: 0,
    pairCopied: false,
    pairCopyVersion: 0,
    tooltips: {},
    hovered: { chats: null, channels: null, peek: null },
    pinnedChannelId: null,
    card: ChatCard.initCardData(),
    backgroundClickChatId: null,
    projectDrag: null,
    dndAnnouncement: "",
  }
}
