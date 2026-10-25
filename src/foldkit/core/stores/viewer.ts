import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import type { ChatJumpTarget } from "../../../client/lib/chat-navigation"
import { generateUUID } from "../../../client/lib/utils"
import { viewerLevelBelow } from "../../../client/lib/viewer-levels"
import type { ChartToolPayload, DisplayAttachment } from "../../../shared/display-tools"
import type { ChatAttachment } from "../../../shared/types"
import type { VisualizationArtifact } from "../../../shared/visualization"
import { opaque } from "../schema"
import * as RightSidebar from "./rightSidebar"
import type { ChatViewerState } from "./rightSidebar"

// Port of src/client/stores/viewerStore.ts.

/**
 * The one viewer: what the elevated card beside (or over) the chat is
 * showing, if anything. A changed file's diff, an attachment, a chart at
 * full size or a sub-chat all open here, so they share one surface, one
 * chrome and one set of keys, and nothing else in the app keeps a modal of
 * its own for them.
 *
 * Each chat has its own, kept with the rest of the page's pane layout in the
 * right sidebar model (`chatViewers`), which is what survives a chat switch
 * and a reload. This model only knows which chat the page is showing, so
 * the ones who open a file from deep in the transcript needn't.
 *
 * The store wrote into the right sidebar store as it went. Here `update`
 * takes both (`State`) and hands both back; the right sidebar's saves come
 * back as `GotRightSidebarMessage`. The root keeps the two Models side by
 * side and routes viewer Messages through this update with both.
 *
 * Three things the store read off the world now arrive as data:
 * - whether the action came from the keyboard (it read `window.event`) is
 *   `byKey` on the Message; `isKeyboardInitiated(event)` is the same test for
 *   the view's handler to make;
 * - the jump's request id is on `ChangedChatJump` (`JumpInPreviewedChat`
 *   makes one, as `setChatJump` did);
 * - the callbacks `registerChatPreviewHost` and `holdLiveChat` returned are
 *   their own Messages (`UnmountedChatPreviewHost`, `ReleasedLiveChat`), sent
 *   from the Mount that registered.
 */

/** An attachment from anywhere (the composer, a prompt, an agent's send), in one shape. */
export interface ViewerAttachment {
  url: string
  name: string
  mimeType: string
  size: number | null
}

export type ViewerItem =
  | { kind: "diff"; projectId: string; path: string }
  /** A file in the project, as it is on disk: `path` relative to the project, `line` to jump to. */
  | { kind: "file"; projectId: string; path: string; line?: number }
  | { kind: "attachment"; attachment: ViewerAttachment }
  | { kind: "chart"; payload: ChartToolPayload }
  /** An inline visualization at full size. A second copy of the saved document, not the one in the transcript. */
  | { kind: "visualization"; artifact: VisualizationArtifact }
  /**
   * Another chat, live, with a composer of its own: any chat the one the
   * page is on refers to (see `lib/chat-open`). `back` is the chats that lead back from
   * it, oldest first, when it was reached by a click inside the previewer.
   *
   * `delegated` is set on a chat picked from a delegator's pane: the
   * delegator. It is the start of that chat's trail, so Back from it, or
   * from the first chat on `back`, returns to the pane.
   */
  | { kind: "chat"; chatId: string; back?: string[]; delegated?: string }
  /**
   * The chats under the delegator `chatId`, as a list to pick from. On a
   * delegator's page this is the pane's floor (see `lib/viewer-levels`):
   * under whatever else is opened there, and the last thing in the pane
   * before it is shut. The navbar's button opens it, in the pane or, on a
   * phone, over the transcript.
   */
  | { kind: "delegated"; chatId: string }

/**
 * What decides the width a pane opens at: a review, a preview and a chat
 * each open at a width of their own. Only that. Once open, the pane keeps
 * the width it has, whatever is shown in it next (`lib/viewer-split`).
 */
export type ViewerWidthClass = "review" | "chat" | "preview"

export function viewerWidthClass(item: ViewerItem): ViewerWidthClass {
  if (item.kind === "diff") return "review"
  return isChatTrailItem(item) ? "chat" : "preview"
}

/**
 * A chat, or what chats are picked from (a delegator's pane): the
 * previewer's own subject, as against a file or image opened over it. They
 * share a width, so the pane holds still while the delegator's pane turns
 * into the chat picked from it.
 */
export function isChatTrailItem(item: ViewerItem): item is Extract<ViewerItem, { kind: "chat" | "delegated" }> {
  return item.kind === "chat" || item.kind === "delegated"
}

/** The pane's floor on a delegator's page: that delegator's list. */
export type ViewerFloor = Extract<ViewerItem, { kind: "delegated" }>

/** A message to land on in the previewed chat: the transcript's one-shot jump, kept here until it is spent. */
export interface ViewerChatJump {
  chatId: string
  target: ChatJumpTarget
  requestId: string
}

/** The page with no chat yet has a viewer too, just not one worth keeping. */
function chatKeyOf(chatId: string | null) {
  return chatId ?? ""
}

const ViewerItemSchema = opaque<ViewerItem>("ViewerItem")
const ViewerFloorSchema = opaque<ViewerFloor>("ViewerFloor")
const ChatJumpTargetSchema = opaque<ChatJumpTarget>("ChatJumpTarget")

export const Model = Schema.Struct({
  /** Whose viewer is showing: the chat the page is on. */
  chatKey: Schema.String,
  /**
   * Counts opens, so opening the same file again (a click on the Changes row
   * you already opened, after scrolling away from it) still jumps back to it.
   */
  openCount: Schema.Number,
  /**
   * How many previewers on the page can show a chat. Zero on a page that
   * mounts none, where opening a sub-chat has to navigate instead.
   */
  chatPreviewHosts: Schema.Number,
  /** Pending for the previewed chat; not kept across a reload, like any jump. */
  chatJump: Schema.NullOr(opaque<ViewerChatJump>("ViewerChatJump")),
  /** The chat a mounted previewer holds a subscription on; see `previewedChatId`. */
  liveChatId: Schema.NullOr(Schema.String),
  /**
   * Whether what the pane shows was last changed from the keyboard (Escape,
   * Enter on Back, the command palette). What arrives then arrives at once:
   * the fade a pointer's change gets would only be a delay on a key.
   */
  changedByKey: Schema.Boolean,
  /**
   * What is under everything else in the page's pane (`lib/viewer-levels`),
   * or null on a page with nothing there: every page but a delegator's on a
   * desktop, where it is the list of the delegator's chats.
   */
  floor: Schema.NullOr(ViewerFloorSchema),
})
export type Model = typeof Model.Type

export const initialModel: Model = {
  chatKey: "",
  openCount: 0,
  chatPreviewHosts: 0,
  chatJump: null,
  liveChatId: null,
  changedByKey: false,
  floor: null,
}

/** What update works on: this Model and the right sidebar's, where each chat's viewer is kept. */
export const State = Schema.Struct({ viewer: Model, rightSidebar: RightSidebar.Model })
export type State = typeof State.Type

export const Message = defineMessageUnion({
  /** The page is on another chat (`setChat`); null for the page with no chat yet. */
  ChangedChat: { chatId: Schema.NullOr(Schema.String) },
  /**
   * Sent by the page, after `ChangedChat`. `openByDefault` puts the floor in
   * an empty pane: a delegator's list is there the first time its page is
   * opened. After that the pane is as it was left, open or shut, like any
   * chat's (the page remembers which, and passes false).
   */
  ChangedFloor: { floor: Schema.NullOr(ViewerFloorSchema), openByDefault: Schema.Boolean },
  /** `expanded` opens it over the chat whatever the pane was, and only for as long as it is open. */
  OpenedItem: { item: ViewerItemSchema, expanded: Schema.Boolean, byKey: Schema.Boolean },
  /**
   * The Close button and Escape. Shuts the pane, or goes back to the chat
   * that what is open was opened over. On a page with a floor it is Escape
   * only, and one level down: to the floor from what is over it, then shut.
   * The Close button there is `ShutViewer`.
   */
  ClosedViewer: { byKey: Schema.Boolean },
  /**
   * For content that is gone (the chat it previewed was deleted): as far
   * down as that leaves something to show. Shut, or on a page with a floor,
   * to the floor.
   */
  ClosedAllViewer: {},
  /** Shuts the pane, whatever is in it or under it: dragged shut, the Close button on a page with a floor, the navbar's toggle. */
  ShutViewer: { byKey: Schema.Boolean },
  /** The Back arrow: one level down (`viewerLevelBelow`), shutting the pane if that is what is under it. */
  SteppedBack: { byKey: Schema.Boolean },
  ScrolledDiffPath: { path: Schema.NullOr(Schema.String) },
  ToggledExpanded: {},
  /** The width you dragged the pane to: kept for every chat (`viewerWidthPx`). */
  ChangedWidth: { widthPx: Schema.Number },
  /** A previewer that can show a chat mounted; `UnmountedChatPreviewHost` when it goes. */
  MountedChatPreviewHost: {},
  UnmountedChatPreviewHost: {},
  /** The previewer's chat subscribed; `ReleasedLiveChat` when it stops. */
  HeldLiveChat: { chatId: Schema.String },
  ReleasedLiveChat: { chatId: Schema.String },
  ChangedChatJump: { chatId: Schema.String, target: ChatJumpTargetSchema, requestId: Schema.String },
  /** The previewed chat landed on the jump (`clearChatJump`). */
  SpentChatJump: { requestId: Schema.String },
  GotRightSidebarMessage: { message: RightSidebar.Message },
})
export type Message = typeof Message.Type

/** `setChatJump`: the jump with a fresh request id. generateUUID, not crypto.randomUUID: see `buildChatJumpLocationState`. */
export const JumpInPreviewedChat = Command.define("JumpInPreviewedChat", {
  args: { chatId: Schema.String, target: ChatJumpTargetSchema },
  messages: [Message.ChangedChatJump],
  execute: ({ chatId, target }) => Effect.sync(() => Message.ChangedChatJump({ chatId, target, requestId: generateUUID() })),
})

/**
 * Whether an event is the keyboard's: a key, or the click a key makes on a
 * focused button (`detail` 0). The store read this off `window.event`; the
 * view's handler asks it of its own event and sends the answer as `byKey`.
 */
export function isKeyboardInitiated(event: Event | undefined): boolean {
  if (typeof KeyboardEvent !== "undefined" && event instanceof KeyboardEvent) return true
  return typeof MouseEvent !== "undefined" && event instanceof MouseEvent && event.type === "click" && event.detail === 0
}

type Return = Update.Return<State, Message>

const toGotRightSidebarMessage = (message: RightSidebar.Message) => Message.GotRightSidebarMessage({ message })

function currentViewer(state: State, chatKey = state.viewer.chatKey): ChatViewerState | null {
  return state.rightSidebar.chatViewers[chatKey] ?? null
}

/** `useRightSidebarStore.getState().setChatViewer(...)`, with the viewer Model as it ends up. */
function setChatViewer(state: State, viewer: Model, chatKey: string, chatViewer: ChatViewerState | null): Return {
  const result = RightSidebar.update(state.rightSidebar, RightSidebar.Message.ChangedChatViewer({ chatKey, viewer: chatViewer }))
  return {
    model: { viewer, rightSidebar: result.model },
    commands: Command.mapMessages(result.commands, toGotRightSidebarMessage),
  }
}

/** Changes the chat's viewer, if it has one, and stores it only when the change makes a new one. */
function updateViewer(state: State, viewer: Model, chatKey: string, change: (chatViewer: ChatViewerState) => ChatViewerState): Return {
  const current = currentViewer(state, chatKey)
  if (!current) return { model: { ...state, viewer } }
  const next = change(current)
  return next === current ? { model: { ...state, viewer } } : setChatViewer(state, viewer, chatKey, next)
}

function stepBack(state: State, byKey: boolean): Return {
  const { viewer } = state
  const current = currentViewer(state)
  if (!current) return { model: state }
  const below = viewerLevelBelow(current, viewer.floor)
  if (below === "closed") return setChatViewer(state, { ...viewer, changedByKey: byKey }, viewer.chatKey, null)
  // A chat gone back to is opened again, as far as anything keyed on opens can tell.
  return setChatViewer(state, { ...viewer, openCount: viewer.openCount + 1, changedByKey: byKey }, viewer.chatKey, {
    item: below.item,
    expanded: current.expandedBefore ?? current.expanded,
  })
}

export const update = (state: State, message: Message): Return =>
  Message.match<Return>(message, {
    ChangedChat: ({ chatId }) => {
      const chatKey = chatKeyOf(chatId)
      const leaving = state.viewer.chatKey
      if (chatKey === leaving) return { model: state }
      // The chat you're leaving reopens where its review had got to.
      return updateViewer(state, { ...state.viewer, chatKey, chatJump: null }, leaving, RightSidebar.settledChatViewer)
    },
    ChangedFloor: ({ floor, openByDefault }) => {
      const viewer = state.viewer.floor?.chatId !== floor?.chatId ? { ...state.viewer, floor } : state.viewer
      const { chatKey } = viewer
      const current = currentViewer(state, chatKey)
      if (floor) {
        if (!current && openByDefault) return setChatViewer(state, viewer, chatKey, { item: floor, expanded: false })
        return { model: { ...state, viewer } }
      }
      // A list left in the pane with no floor under it: the window went to a
      // phone's width, where the list is opened on request, or the page loaded
      // there. It was only ever there as the floor.
      if (current?.item.kind === "delegated" && !current.returnTo) return setChatViewer(state, viewer, chatKey, null)
      return { model: { ...state, viewer } }
    },
    OpenedItem: ({ item, expanded: openExpanded, byKey }) => {
      const { chatKey } = state.viewer
      const current = currentViewer(state)
      // The pane's own setting, under an item that opened expanded.
      const expanded = current ? current.expandedBefore ?? current.expanded : false
      // Something else opened over a chat preview keeps the way back to it,
      // through any number of files and images after it. Another chat doesn't:
      // that is the previewer moving on.
      const returnTo = isChatTrailItem(item) || !current
        ? undefined
        : isChatTrailItem(current.item)
          ? { item: current.item }
          : current.returnTo
      return setChatViewer(state, { ...state.viewer, openCount: state.viewer.openCount + 1, changedByKey: byKey }, chatKey, {
        item,
        expanded: openExpanded || expanded,
        ...(openExpanded && !expanded ? { expandedBefore: false } : {}),
        ...(returnTo ? { returnTo } : {}),
      })
    },
    ClosedViewer: ({ byKey }) => {
      const { chatKey, floor } = state.viewer
      if (floor) return stepBack(state, byKey)
      const viewer = { ...state.viewer, changedByKey: byKey }
      const current = currentViewer(state)
      if (!current?.returnTo) return setChatViewer(state, viewer, chatKey, null)
      return setChatViewer(state, viewer, chatKey, {
        item: current.returnTo.item,
        expanded: current.expandedBefore ?? current.expanded,
      })
    },
    ClosedAllViewer: () => {
      const { chatKey, floor } = state.viewer
      const current = currentViewer(state)
      return setChatViewer(state, state.viewer, chatKey, floor
        ? { item: floor, expanded: current ? current.expandedBefore ?? current.expanded : false }
        : null)
    },
    ShutViewer: ({ byKey }) => setChatViewer(state, { ...state.viewer, changedByKey: byKey }, state.viewer.chatKey, null),
    SteppedBack: ({ byKey }) => stepBack(state, byKey),
    ScrolledDiffPath: ({ path }) => updateViewer(state, state.viewer, state.viewer.chatKey, (viewer) => (
      viewer.item.kind !== "diff" || (viewer.reviewPath ?? null) === path
        ? viewer
        : { ...viewer, reviewPath: path ?? undefined }
    )),
    ToggledExpanded: () => updateViewer(state, state.viewer, state.viewer.chatKey, ({ expandedBefore: _, ...viewer }) => ({
      ...viewer,
      expanded: !viewer.expanded,
    })),
    ChangedWidth: ({ widthPx }) => {
      const result = RightSidebar.update(state.rightSidebar, RightSidebar.Message.ChangedViewerWidth({ widthPx }))
      return {
        model: { ...state, rightSidebar: result.model },
        commands: Command.mapMessages(result.commands, toGotRightSidebarMessage),
      }
    },
    MountedChatPreviewHost: () => ({
      model: { ...state, viewer: { ...state.viewer, chatPreviewHosts: state.viewer.chatPreviewHosts + 1 } },
    }),
    UnmountedChatPreviewHost: () => ({
      model: { ...state, viewer: { ...state.viewer, chatPreviewHosts: Math.max(0, state.viewer.chatPreviewHosts - 1) } },
    }),
    HeldLiveChat: ({ chatId }) => ({ model: { ...state, viewer: { ...state.viewer, liveChatId: chatId } } }),
    ReleasedLiveChat: ({ chatId }) => ({
      model: state.viewer.liveChatId === chatId ? { ...state, viewer: { ...state.viewer, liveChatId: null } } : state,
    }),
    ChangedChatJump: ({ chatId, target, requestId }) => ({
      model: { ...state, viewer: { ...state.viewer, chatJump: { chatId, target, requestId } } },
    }),
    SpentChatJump: ({ requestId }) => ({
      model: state.viewer.chatJump?.requestId === requestId ? { ...state, viewer: { ...state.viewer, chatJump: null } } : state,
    }),
    GotRightSidebarMessage: ({ message: rightSidebarMessage }) => {
      const result = RightSidebar.update(state.rightSidebar, rightSidebarMessage)
      return {
        model: { ...state, rightSidebar: result.model },
        commands: Command.mapMessages(result.commands, toGotRightSidebarMessage),
      }
    },
  })

/** What the page's chat has open in the viewer, and how, or null (`useChatViewer`, `getChatViewer`). */
export function chatViewer(state: State): ChatViewerState | null {
  return currentViewer(state)
}

/**
 * The chat the previewer is subscribed to right now, or null. Not what the
 * chat's viewer has stored: on a page that mounts no previewer nothing is
 * subscribed, whatever was left open.
 */
export function previewedChatId(model: Model): string | null {
  return model.liveChatId
}

/**
 * The file the viewer's diff list is on, in this project, or null: the one
 * scrolled to, else the one opened. The Changes card lights it, so the two
 * move together.
 */
export function reviewedPath(state: State, projectId: string | null): string | null {
  const viewer = chatViewer(state)
  return projectId && viewer?.item.kind === "diff" && viewer.item.projectId === projectId
    ? viewer.reviewPath ?? viewer.item.path
    : null
}

export function viewerAttachmentFromChat(attachment: ChatAttachment): ViewerAttachment {
  return { url: attachment.contentUrl, name: attachment.displayName, mimeType: attachment.mimeType, size: attachment.size }
}

export function viewerAttachmentFromDisplay(attachment: DisplayAttachment): ViewerAttachment {
  return { url: attachment.url, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size }
}
