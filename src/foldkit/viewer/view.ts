import { Effect, Schema } from "effect"
import { Mount, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { PANE_CLOSE_MS } from "../../client/app/paneAnimation"
import { cn } from "../../client/lib/utils"
import { viewerLevelBelow } from "../../client/lib/viewer-levels"
import { viewerCardEnters, viewerPaneState } from "../../client/lib/viewer-split"
import { getEditorPresetLabel } from "../../shared/editor-presets"
import type { SliceViewInputs } from "../app/slice"
import type { AppModel } from "../app/slice"
import { resolveTheme, themePreference } from "../app/theme"
import { effectiveEditorPreset } from "../chat/openExternal"
import type { ChatPageContext, ChatPageRequests } from "../chat/pageInputs"
import * as DiffCommit from "../core/stores/diffCommit"
import type { ChatViewerState } from "../core/stores/rightSidebar"
import * as ViewerStore from "../core/stores/viewer"
import { attachmentViewer } from "./attachment"
import { delegatedList } from "./delegated"
import { diffViewer, type DiffContext } from "./diff"
import { fileViewer } from "./file"
import { chartFullView, visualizationFullView } from "./fullViews"
import { Message } from "./message"
import type { Model } from "./model"
import { openFileContext } from "./openFileSelect"
import { chatPreview } from "./preview"
import type { LayerContext } from "./surface"

// ViewerLayer (components/viewer/ViewerLayer.tsx): where the viewer shows,
// and the one place it's mounted per page. The chat page puts it in a pane
// beside the chat, or over the chat when expanded or on a phone; the export
// viewer over the whole page. It covers what it's placed in with the page
// background, and sets the card 8px in, the widget column's gutter. Not at
// the bottom where the page has a pane for it: there the card runs off the
// bottom edge (surface.ts).

type H = HtmlBuilder<Message>

/**
 * The chat page's view inputs (`{ app, page, requests }`), or the root's
 * alone. `page` is what the chat page knows (its project, its diffs, a chat
 * to preview); without it the layer shows no diff, no project file and no
 * chat, as the export viewer's did. `className` is the export viewer's
 * ("fixed"); the chat page's comes in `page.viewer.className`.
 */
export interface ViewInputs extends SliceViewInputs {
  page?: ChatPageContext
  requests?: ChatPageRequests
  className?: string
}

export const VIEWER_OVERLAY_EXIT_MS = 150

/**
 * Whether the viewer has something to show on a page that knows this project
 * (null: no project, so no diffs or project files).
 */
export function showsOn(item: ViewerStore.ViewerItem | null, projectId: string | null | undefined) {
  if (!item) return false
  if (item.kind === "diff" || item.kind === "file") return Boolean(projectId) && item.projectId === projectId
  return true
}

/** What the page's chat has open in the viewer, and how (`useChatViewer`). */
export function liveViewer(app: AppModel): ChatViewerState | null {
  return ViewerStore.chatViewer({ viewer: app.stores.viewer, rightSidebar: app.stores.rightSidebar })
}

/** What the viewer needs to show diffs: this project's changed files, and how to read, render and open them. */
export function diffContextOf(model: Model, app: AppModel, projectId: string | null): DiffContext | null {
  if (!projectId) return null
  const snapshot = app.projectDiffs[projectId] ?? null
  const preferences = app.stores.terminalPreferences
  const installedEditors = app.stores.appSettings.settings?.installedEditors ?? null
  const isMac = app.localProjects?.machine.platform === "darwin"
  return {
    projectId,
    files: snapshot?.files ?? [],
    filesReady: snapshot?.status === "ready",
    editorLabel: getEditorPresetLabel(effectiveEditorPreset(preferences.editorPreset, app.stores.openDestination.value, installedEditors)),
    diffRenderMode: model.diffRenderMode,
    wrapLines: model.wrapLines,
    theme: resolveTheme(themePreference(app.stores.appSettings.settings), app.systemTheme),
    selection: DiffCommit.projectSelection(app.stores.diffCommit, projectId),
    open: openFileContext(app, isMac),
  }
}

// MOUNTS: what each render reports, for update to keep

/** The pane as this render left it (ViewerLayer's `was`, usePresentedViewer's last shown). */
export const ReportPane = Mount.define("ViewerReportPane", {
  args: {
    state: Schema.Literals(["closed", "docked", "expanded"]),
    shownKey: Schema.NullOr(Schema.String),
    chatKey: Schema.String,
    viewer: Schema.Unknown,
  },
  messages: [Message.RenderedPane],
  execute: ({ state, shownKey, chatKey, viewer }) => Effect.succeed(Message.RenderedPane({ state, shownKey, chatKey, viewer: viewer as ChatViewerState | null })),
})

/** A closed card leaves the way it came, then goes. */
export const ExitTimer = Mount.define("ViewerExitTimer", {
  args: { key: Schema.String, ms: Schema.Number },
  messages: [Message.FinishedExit],
  execute: ({ key, ms }) => Effect.sleep(ms).pipe(Effect.as(Message.FinishedExit({ key }))),
})

/** Counted while mounted, shown or not: it tells a chat clicked on this page that it has a previewer to open in. */
export const RegisterPreviewHost = Mount.define("ViewerRegisterPreviewHost", {
  messages: [Message.MountedPreviewHost],
  execute: () => Effect.succeed(Message.MountedPreviewHost()),
})

// THE LAYER

function hidden(key: string, mount: ReturnType<typeof ReportPane> | ReturnType<typeof ExitTimer> | ReturnType<typeof RegisterPreviewHost>, h: H): Html {
  return h.keyed("span")(key, [h.Hidden(true), h.OnMount(mount)], [])
}

export function layerView(model: Model, inputs: ViewInputs, h: H): Html {
  const { app, page } = inputs
  const projectId = page ? page.projectId : null
  // A page without a chat context never previews one.
  const canShowChat = Boolean(page)
  const chatKey = app.stores.viewer.chatKey
  const live = liveViewer(app)
  const liveShown = live && showsOn(live.item, projectId) && !(ViewerStore.isChatTrailItem(live.item) && !canShowChat) ? live : null

  // usePresentedViewer, on the chat page: what it had open stays for a
  // moment after it closes, so it can leave rather than vanish. Another
  // chat, or reduced motion, drops it at once.
  const last = page ? model.lastShown : null
  const leaving = !liveShown && last && last.chatKey === chatKey && last.key !== model.finishedExit && !model.reducedMotion
    ? last
    : null
  const viewer = liveShown ?? leaving?.viewer ?? null
  const exiting = leaving !== null
  const item = viewer?.item ?? null

  // What a card mounting now animates (`ViewerMotion`).
  const paneState = viewerPaneState(item !== null, viewer?.expanded ?? false)
  const cardEnters = viewerCardEnters(model.was, paneState)
  const floor = app.stores.viewer.floor
  // In a pane with a floor, what the views are handed as Close is Escape's
  // step back a level, and their card draws a Back arrow beside an X that
  // shuts the pane.
  const below = floor && viewer ? viewerLevelBelow(viewer, floor) : null
  const hasBack = below !== null && below !== "closed"
  const backKind = hasBack ? below.item.kind : null
  const placement = page?.viewer.paneAvailable ? { expanded: viewer?.expanded ?? false } : null
  const context: LayerContext = {
    placement,
    floor: floor ? { hasBack, backLabel: backKind === "chat" ? "Back to chat" : "Back to delegated chats" } : null,
    motion: { cardEnters, bodyEnters: !cardEnters && !app.stores.viewer.changedByKey },
  }

  const shownKey = liveShown ? JSON.stringify(liveShown) : null
  const exitMs = leaving ? (page?.viewer.paneAvailable && !leaving.viewer.expanded ? PANE_CLOSE_MS : VIEWER_OVERLAY_EXIT_MS) : 0
  const reports = [
    hidden(`viewer-pane:${paneState}:${chatKey}:${shownKey ?? ""}`, ReportPane({ state: paneState, shownKey, chatKey, viewer: liveShown }), h),
    canShowChat && !model.hostRegistered && app.stores.viewer.chatPreviewHosts === 0
      ? hidden("viewer-preview-host", RegisterPreviewHost(), h)
      : null,
    leaving ? hidden(`viewer-exit:${leaving.key}`, ExitTimer({ key: leaving.key, ms: exitMs }), h) : null,
  ]
  if (!item) return h.div([h.Hidden(true)], reports)

  // In a pane, the pane closes around it. Over the chat it leaves the way it
  // came, faded and a touch small, quicker than it came.
  const overlayExit = exiting && !(placement && !placement.expanded)
  const className = page ? page.viewer.className : inputs.className
  return h.div([
    ...(exiting ? [h.Inert(true)] : []),
    h.Class(cn(
      "absolute inset-0 z-30 bg-background p-2",
      placement && "pb-0",
      overlayExit && "opacity-0 transition-opacity duration-150 ease-snappy motion-safe:[&_[data-viewer-surface]]:scale-[0.98]",
      className,
    )),
  ], [cardView(model, context, inputs, item, h), ...reports])
}

function cardView(model: Model, context: LayerContext, inputs: ViewInputs, item: ViewerStore.ViewerItem, h: H): Html | null {
  const { app, page } = inputs
  const diff = diffContextOf(model, app, page?.projectId ?? null)
  switch (item.kind) {
    case "diff":
      return diff ? diffViewer(model, context, diff, item, app.stores.viewer.openCount, h) : null
    case "attachment":
      return attachmentViewer(model, context, item.attachment, h)
    case "file":
      return diff ? fileViewer(model, context, diff, item, h) : null
    case "chart":
      return chartFullView(model, context, item.payload, h)
    case "visualization":
      return visualizationFullView(model, context, item.artifact, Boolean(page), h)
    case "chat":
      return page ? chatPreview(model, context, app, inputs.requests, item, h) : null
    case "delegated":
      return delegatedList(model, context, app, item, h)
  }
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => layerView(model, inputs, h))
