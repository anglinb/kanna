import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { SIDEBAR_MAX_WIDTH_PX } from "../../../client/lib/sidebarWidth"
import type { AgentProvider } from "../../../shared/types"
import { opaque } from "../schema"
import { readPersistedStore, writePersistedStore } from "../storage"
import type { ViewerItem } from "./viewer"

// Port of src/client/stores/rightSidebarStore.ts.

/**
 * The chat page's panes beside the chat, and the one record of how they're
 * laid out. The widget column (agents, git, attachments, ports, quick
 * actions, usage) is open or closed per chat or per project, as the
 * `paneVisibility.widgets` setting says; there are no panels to pick
 * between. The viewer's pane holds what's open per chat, so going to another
 * chat and back finds it as you left it, and so does a reload.
 */
export interface ProjectRightSidebarVisibilityState {
  /** The project's own state, which every chat follows when the setting is per project. */
  widgetsOpen: boolean
  /**
   * Each chat's state when the setting is per chat, by chat id. Kept under
   * the chat's project so removing the project clears them. A chat with no
   * entry starts closed.
   */
  chats?: Record<string, boolean>
}

/** The widget disclosures whose open state is remembered per project. */
// Usage is one card per harness, so one disclosure each. The bare "usage" is
// the single card from before that, left in the type so persisted state reads.
export type WidgetDisclosureId = "changes" | "history" | "ports" | "quickActions" | "usage" | `usage:${AgentProvider}`

export interface ProjectRightSidebarUiState {
  /**
   * Disclosures the user has opened or closed. Unset means never touched, and
   * the widget falls back to its default (open when it holds only a few rows).
   */
  expanded: Partial<Record<WidgetDisclosureId, boolean>>
  summary: string
  description: string
}

/** What one chat has open in the viewer, and how. */
export interface ChatViewerState {
  item: ViewerItem
  /** Widened over the chat, rather than in its pane beside it. */
  expanded: boolean
  /**
   * False while an item that opens expanded (a visualization) holds a pane
   * that was not: what `expanded` goes back to when it closes onto `returnTo`
   * or something else opens, so one look at a chart doesn't leave the pane
   * over the chat. Gone once you expand or collapse it yourself.
   */
  expandedBefore?: boolean
  /**
   * The file the diff list is scrolled to, which the Changes card lights.
   * Apart from `item`, the file that was opened, which decides where the
   * list jumps: scrolling mustn't move that. Coming back to the chat, it's
   * the file the list reopens on.
   */
  reviewPath?: string
  /**
   * The chat preview this replaced. A file or an image opened while a chat
   * is in the previewer is a look at something, and closing it goes back to
   * the chat instead of shutting the pane on it.
   */
  returnTo?: { item: Extract<ViewerItem, { kind: "chat" | "delegated" }> }
}

const ChatViewerStateSchema = opaque<ChatViewerState>("ChatViewerState")

export const Model = Schema.Struct({
  size: Schema.Number,
  projects: Schema.Record(Schema.String, opaque<ProjectRightSidebarVisibilityState>("ProjectRightSidebarVisibilityState")),
  projectUi: Schema.Record(Schema.String, opaque<ProjectRightSidebarUiState>("ProjectRightSidebarUiState")),
  /** By chat id; see the viewer module for who reads and writes it. */
  chatViewers: Schema.Record(Schema.String, ChatViewerStateSchema),
  /**
   * The viewer's docked width once you've dragged it, in every chat: set in
   * one, it is the width in all of them. Until then, the default for what's
   * open. Kept as dragged; a window too narrow for it narrows the pane where
   * it is laid out (`ChatPage`), not here, so a wider window gets it back.
   */
  viewerWidthPx: Schema.NullOr(Schema.Number),
})
export type Model = typeof Model.Type

export const STORAGE_NAME = "right-sidebar-layouts"
export const STORAGE_VERSION = 11

export const DEFAULT_RIGHT_SIDEBAR_SIZE = 420
export const RIGHT_SIDEBAR_MIN_WIDTH_PX = 370
/** The same ceiling as the left sidebar's. */
export const RIGHT_SIDEBAR_MAX_WIDTH_PX = SIDEBAR_MAX_WIDTH_PX

export const initialModel: Model = {
  size: DEFAULT_RIGHT_SIDEBAR_SIZE,
  projects: {},
  projectUi: {},
  chatViewers: {},
  viewerWidthPx: null,
}

function clampSize(size: number) {
  if (!Number.isFinite(size)) return DEFAULT_RIGHT_SIDEBAR_SIZE
  return Math.min(RIGHT_SIDEBAR_MAX_WIDTH_PX, Math.max(RIGHT_SIDEBAR_MIN_WIDTH_PX, size))
}

function createDefaultProjectUiState(): ProjectRightSidebarUiState {
  return {
    expanded: {},
    summary: "",
    description: "",
  }
}

function isWidgetsOpen(
  projects: Model["projects"],
  projectId: string,
  chatKey?: string | null,
) {
  const layout = projects[projectId]
  if (chatKey) return layout?.chats?.[chatKey] ?? false
  return layout?.widgetsOpen ?? false
}

function withWidgetsOpen(
  projects: Model["projects"],
  projectId: string,
  chatKey: string | null | undefined,
  open: boolean,
) {
  const layout = projects[projectId] ?? { widgetsOpen: false }
  const next = chatKey
    ? { ...layout, chats: { ...layout.chats, [chatKey]: open } }
    : { ...layout, widgetsOpen: open }
  return { ...projects, [projectId]: next }
}

/**
 * v8 folded the git / browser panels into one widget column: any panel that
 * was open (or the pre-panel `isVisible` flag) now means the widgets are open.
 * The embedded browser's state, the Changes/History picker and the per-file
 * diff collapse state (diffs open in the viewer now) are dropped.
 */
export function migrateRightSidebarStore(persistedState: unknown, version = 0) {
  if (!persistedState || typeof persistedState !== "object") {
    return { size: DEFAULT_RIGHT_SIDEBAR_SIZE, projects: {}, projectUi: {}, chatViewers: {}, viewerWidthPx: null }
  }

  const state = persistedState as {
    size?: number
    projects?: Record<string, Partial<{ isVisible: boolean; rightPanel: string; widgetsOpen: boolean; chats: Record<string, boolean> }>>
    projectUi?: Record<string, Partial<ProjectRightSidebarUiState> & { viewMode?: unknown }>
    chatViewers?: Record<string, ChatViewerState & { widthPx?: number }>
    viewerWidthPx?: number | null
  }
  const projects = Object.fromEntries(
    Object.entries(state.projects ?? {}).map(([projectId, layout]) => [
      projectId,
      {
        widgetsOpen: layout.widgetsOpen
          ?? (layout.rightPanel !== undefined ? layout.rightPanel !== "hidden" : Boolean(layout.isVisible)),
        ...(layout.chats ? { chats: layout.chats } : {}),
      },
    ])
  )
  const projectUi = Object.fromEntries(
    Object.entries(state.projectUi ?? {}).map(([projectId, ui]) => [
      projectId,
      {
        expanded: ui.expanded ?? {},
        summary: ui.summary ?? "",
        description: ui.description ?? "",
      },
    ])
  )

  // Sizes before v7 were percentages of the window, not pixels.
  const size = version >= 7 && state.size !== undefined ? clampSize(state.size) : DEFAULT_RIGHT_SIDEBAR_SIZE
  // Before v10 each chat's viewer kept its own width. There is one now, and
  // which chat's to take is anyone's guess: the pane starts from its defaults.
  const chatViewers = Object.fromEntries(Object.entries(state.chatViewers ?? {}).map(([chatKey, { widthPx: _width, returnTo, item, ...viewer }]) => [
    chatKey,
    {
      ...viewer,
      item: withoutTicket(item),
      ...(returnTo ? { returnTo: { item: withoutTicket(returnTo.item) as NonNullable<ChatViewerState["returnTo"]>["item"] } } : {}),
    },
  ]))
  const viewerWidthPx = typeof state.viewerWidthPx === "number" && Number.isFinite(state.viewerWidthPx) ? state.viewerWidthPx : null
  return { size, projects, projectUi, chatViewers, viewerWidthPx }
}

/**
 * Before v11 a delegator's pane held tickets: one open (`ticket`), or a chat
 * opened from one (`chat` with `ticket`). Tickets are gone, so a ticket left
 * open comes back as its delegator's pane, where it was, and a chat forgets
 * the ticket it came from.
 */
function withoutTicket(item: ViewerItem): ViewerItem {
  if (!item) return item
  const stored = item as ViewerItem | { kind: "ticket"; chatId: string } | (Extract<ViewerItem, { kind: "chat" }> & { ticket?: string })
  if (stored.kind === "ticket") return { kind: "delegated", chatId: stored.chatId }
  if (stored.kind === "chat" && "ticket" in stored) {
    const { ticket: _ticket, ...chat } = stored
    return chat
  }
  return item
}

/**
 * What of the chats' viewers outlives the page. A chart is data from the
 * transcript and a `blob:` attachment lives only in this page, so neither
 * would come back; nor does the viewer of a page with no chat. A review
 * is kept at the file it was scrolled to, which is where it reopens. A chat
 * preview is kept as the chat's id, and subscribes again when it reopens.
 */
export function persistedChatViewers(chatViewers: Readonly<Record<string, ChatViewerState>>) {
  const kept: Record<string, ChatViewerState> = {}
  for (const [chatKey, viewer] of Object.entries(chatViewers)) {
    const { item } = viewer
    if (!chatKey) continue
    if (item.kind === "chart" || (item.kind === "attachment" && item.attachment.url.startsWith("blob:"))) {
      // What it was opened over does come back: the chat preview under it.
      if (viewer.returnTo) kept[chatKey] = { ...viewer.returnTo, expanded: viewer.expandedBefore ?? viewer.expanded }
      continue
    }
    kept[chatKey] = settledChatViewer(viewer)
  }
  return kept
}

/** A viewer as it reopens: a review opened at the file it was scrolled to. */
export function settledChatViewer(viewer: ChatViewerState): ChatViewerState {
  const { reviewPath, ...rest } = viewer
  return rest.item.kind === "diff" && reviewPath ? { ...rest, item: { ...rest.item, path: reviewPath } } : rest
}

/** What of the layout outlives the page: everything but what can't come back (`persistedChatViewers`). */
export function persistedRightSidebarState(state: Model) {
  return {
    size: state.size,
    projects: state.projects,
    projectUi: state.projectUi,
    chatViewers: persistedChatViewers(state.chatViewers),
    viewerWidthPx: state.viewerWidthPx,
  }
}

/** The persisted state over the defaults, migrated from older versions, as zustand's persist hydrates. */
export function load(storage?: Storage): Model {
  return { ...initialModel, ...readPersistedStore<Model>(STORAGE_NAME, STORAGE_VERSION, migrateRightSidebarStore, storage) }
}

/** `chatKey` is the chat whose own state to change (see lib/paneVisibility); null changes the project's. */
const ChatKey = Schema.NullOr(Schema.String)

export const Message = defineMessageUnion({
  ToggledWidgets: { projectId: Schema.String, chatKey: ChatKey },
  OpenedWidgets: { projectId: Schema.String, chatKey: ChatKey },
  HidWidgets: { projectId: Schema.String, chatKey: ChatKey },
  ChangedSize: { size: Schema.Number },
  ChangedWidgetExpanded: { projectId: Schema.String, id: opaque<WidgetDisclosureId>("WidgetDisclosureId"), expanded: Schema.Boolean },
  ChangedCommitDraft: { projectId: Schema.String, summary: Schema.String, description: Schema.String },
  ClearedCommitDraft: { projectId: Schema.String },
  ClearedProject: { projectId: Schema.String },
  /** Sets (or, with null, clears) what a chat has open in the viewer. */
  ChangedChatViewer: { chatKey: Schema.String, viewer: Schema.NullOr(ChatViewerStateSchema) },
  ChangedViewerWidth: { widthPx: Schema.Number },
  CompletedSave: {},
})
export type Message = typeof Message.Type

/** Writes what `persistedRightSidebarState` keeps, as zustand's `partialize` did. */
export const Save = Command.define("SaveRightSidebarLayouts", {
  args: { state: Model },
  messages: [Message.CompletedSave],
  execute: ({ state }) => writePersistedStore(STORAGE_NAME, STORAGE_VERSION, persistedRightSidebarState(state)).pipe(
    Effect.as(Message.CompletedSave()),
  ),
})

// zustand's persist writes after every `set`, changed or not; so does this.
function saved(model: Model): Update.Return<Model, Message> {
  return { model, commands: [Save({ state: model })] }
}

function withProjectUi(model: Model, projectId: string, ui: ProjectRightSidebarUiState): Model {
  return { ...model, projectUi: { ...model.projectUi, [projectId]: ui } }
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    ToggledWidgets: ({ projectId, chatKey }) => saved({
      ...model,
      projects: withWidgetsOpen(model.projects, projectId, chatKey, !isWidgetsOpen(model.projects, projectId, chatKey)),
    }),
    OpenedWidgets: ({ projectId, chatKey }) => saved(isWidgetsOpen(model.projects, projectId, chatKey)
      ? model
      : { ...model, projects: withWidgetsOpen(model.projects, projectId, chatKey, true) }),
    HidWidgets: ({ projectId, chatKey }) => saved(isWidgetsOpen(model.projects, projectId, chatKey)
      ? { ...model, projects: withWidgetsOpen(model.projects, projectId, chatKey, false) }
      : model),
    ChangedSize: ({ size }) => saved({ ...model, size: clampSize(size) }),
    ChangedWidgetExpanded: ({ projectId, id, expanded }) => {
      const current = model.projectUi[projectId] ?? createDefaultProjectUiState()
      // `?? {}`: a state persisted before this map existed has no `expanded`.
      if (current.expanded?.[id] === expanded) return saved(model)
      return saved(withProjectUi(model, projectId, { ...current, expanded: { ...current.expanded, [id]: expanded } }))
    },
    ChangedCommitDraft: ({ projectId, summary, description }) => {
      const current = model.projectUi[projectId] ?? createDefaultProjectUiState()
      if (current.summary === summary && current.description === description) return saved(model)
      return saved(withProjectUi(model, projectId, { ...current, summary, description }))
    },
    ClearedCommitDraft: ({ projectId }) => {
      const current = model.projectUi[projectId] ?? createDefaultProjectUiState()
      if (!current.summary && !current.description) return saved(model)
      return saved(withProjectUi(model, projectId, { ...current, summary: "", description: "" }))
    },
    ClearedProject: ({ projectId }) => {
      const { [projectId]: _removedLayout, ...restProjects } = model.projects
      const { [projectId]: _removedUi, ...restProjectUi } = model.projectUi
      const chatViewers = Object.fromEntries(Object.entries(model.chatViewers).filter(([, viewer]) => (
        !("projectId" in viewer.item) || viewer.item.projectId !== projectId
      )))
      return saved({ ...model, projects: restProjects, projectUi: restProjectUi, chatViewers })
    },
    ChangedChatViewer: ({ chatKey, viewer }) => {
      if (viewer) return saved({ ...model, chatViewers: { ...model.chatViewers, [chatKey]: viewer } })
      if (!(chatKey in model.chatViewers)) return saved(model)
      const { [chatKey]: _removed, ...rest } = model.chatViewers
      return saved({ ...model, chatViewers: rest })
    },
    ChangedViewerWidth: ({ widthPx }) => saved(model.viewerWidthPx === widthPx ? model : { ...model, viewerWidthPx: widthPx }),
    CompletedSave: () => ({ model }),
  })

/** `useWidgetsOpen`: whether the widget column is open, for this chat (`chatKey`) or else the project. */
export function widgetsOpen(model: Model, projectId: string | null | undefined, chatKey?: string | null): boolean {
  return projectId ? isWidgetsOpen(model.projects, projectId, chatKey) : false
}
