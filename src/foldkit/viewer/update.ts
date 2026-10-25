import { Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { hasOpenLayer, resolveEscapePress } from "../../client/lib/escape-key"
import { shouldOpenLocalFileLinkInEditor } from "../../client/lib/pathUtils"
import { resolveDiffFilePath } from "../../client/app/ChatPage/utils"
import { AppAction, batch } from "../app/action"
import { SliceOutMessage, type AppModel, type SliceReturn } from "../app/slice"
import * as Stores from "../app/stores"
import { openChatActions } from "../chat/chatReference"
import { openAppValueRequest, type OpenAppValue } from "../chat/openExternal"
import * as ChatSession from "../core/chatSession"
import type { KannaSocketService } from "../core/socket"
import * as DiffCommit from "../core/stores/diffCommit"
import * as OpenDestination from "../core/stores/openDestination"
import * as ViewerStore from "../core/stores/viewer"
import * as Messages from "../transcript/messages"
import * as Dialog from "../ui/dialog"
import * as Select from "../ui/select"
import * as Tooltip from "../ui/tooltip"
import { cycleSort, FIRST_ROW_CHUNK, tableStateOf } from "./attachment"
import { dropCapture, startCapture } from "./capture"
import {
  ClearReviewState,
  DIFF_CARD_KEY,
  DIFF_VIEWER_PAGE_SIZE,
  initialDiffState,
  pageLimit,
  patchKey,
  ReadPatch,
  reviewFiles,
  reviewSnapshot,
  SaveReviewState,
} from "./diff"
import { sortByPath, type DiffFile } from "./git"
import { initialSaveDialog, SaveImage } from "./fullViews"
import { AttachMarkup, commitText, initialMarkup, LoadMarkupSource, markupUpdate, releaseMarkupSource } from "./markup"
import { Message } from "./message"
import { init, type DiffState, type Model } from "./model"
import { selectOf, selectTarget } from "./openFileSelect"
import { closePreview, composerStep, openPreview, PREVIEW_CARD_KEY, sessionStep, transcriptStep, type PreviewStep } from "./preview"
import { tooltipOf } from "./surface"

// What the viewer's Messages do. What is open is the stores': a change to
// it goes to the root (`AppAction.Store` with a viewer Message), as React's
// views called the viewer store. What the views kept in state is this
// Model's, under the card it belongs to.

type AnyCommand = Command.Command<Message, never, KannaSocketService>
type Return = SliceReturn<Model, Message>

interface Step {
  model: Model
  commands: AnyCommand[]
  actions: AppAction[]
}

const done = (model: Model, commands: AnyCommand[] = [], actions: AppAction[] = []): Step => ({ model, commands, actions })

function toReturn(step: Step): Return {
  const [first, ...rest] = step.actions
  const base = { model: step.model, ...(step.commands.length > 0 ? { commands: step.commands as Return["commands"] } : {}) }
  if (!first) return base
  return { ...base, outMessage: SliceOutMessage.RequestedAppAction({ action: rest.length === 0 ? first : batch(first, ...rest) }) }
}

const store = (message: Stores.Message) => AppAction.Store({ message })
const viewerStore = (message: ViewerStore.Message) => store(Stores.Message.GotViewerMessage({ message }))

// COMMANDS

export const CopyLink = Command.define("ViewerCopyLink", {
  args: { url: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ url }) => Effect.promise(async () => {
    await navigator.clipboard?.writeText(new URL(url, document.baseURI || window.location.href).toString()).catch(() => {})
    return Message.CompletedSideEffect()
  }),
})

export const OpenInNewTab = Command.define("ViewerOpenInNewTab", {
  args: { url: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ url }) => Effect.sync(() => {
    window.open(new URL(url, document.baseURI || window.location.href).toString(), "_blank", "noopener,noreferrer")
    return Message.CompletedSideEffect()
  }),
})

/** Drawing starts on the click, while the name is being typed, so the file is ready when it is confirmed. */
export const StartCapture = Command.define("ViewerStartCapture", {
  args: { kind: Schema.Literals(["save", "markup"]) },
  messages: [Message.StartedCapture],
  execute: ({ kind }) => Effect.sync(() => Message.StartedCapture({ kind, captureId: startCapture() })),
})

/** The frame handed Escape back: the pane closes on it unless something nearer is open. */
export const CheckFrameEscape = Command.define("ViewerCheckFrameEscape", {
  args: { repeat: Schema.Boolean },
  messages: [Message.CheckedFrameEscape],
  execute: ({ repeat }) => Effect.sync(() => Message.CheckedFrameEscape({
    close: resolveEscapePress({ repeat, claimed: hasOpenLayer(), paneOpen: true, canInterrupt: false }) === "close-pane",
  })),
})

// THE CARD

/** The diff list leaving: done with this review, unless a chat is still reviewing this project. */
function leaveReview(step: Step, app: AppModel): Step {
  const state = step.model.diff
  if (!state) return step
  const stillReviewing = Object.values(app.stores.rightSidebar.chatViewers)
    .some((viewer) => viewer.item.kind === "diff" && viewer.item.projectId === state.projectId)
  return {
    model: modifyFields(step.model, { diff: () => null }),
    commands: stillReviewing ? step.commands : [...step.commands, ClearReviewState({ projectId: state.projectId })],
    actions: step.actions,
  }
}

function leavePreview(step: Step): Step {
  const preview = step.model.preview
  if (!preview) return step
  const closed = closePreview(preview)
  return {
    model: modifyFields(step.model, { preview: () => null }),
    commands: [...step.commands, ...closed.commands],
    actions: [...step.actions, ...closed.actions],
  }
}

/** A card went (another took its place, or the pane closed): what it held goes with it. */
function leaveCard(step: Step, app: AppModel, nextKey: string | null): Step {
  let next = step
  if (nextKey !== DIFF_CARD_KEY) next = leaveReview(next, app)
  if (nextKey !== PREVIEW_CARD_KEY) next = leavePreview(next)
  return next
}

/** A new card: the state of the last one is gone, as a React component's went with it. */
function mountedCard(model: Model, app: AppModel, key: string, cardEnters: boolean, bodyEnters: boolean): Step {
  const fresh = init()
  const reset = modifyFields(model, {
    card: () => ({ key, cardEnters, bodyEnters }),
    toggles: () => ({}),
    panes: () => ({}),
    texts: () => ({}),
    tables: () => ({}),
    rows: () => fresh.rows,
    visualizationDialog: () => null,
    markup: () => null,
    dialog: () => fresh.dialog,
  })
  return leaveCard(done(reset), app, key)
}

// DIFFS

function reviewItem(app: AppModel) {
  const item = ViewerStore.chatViewer({ viewer: app.stores.viewer, rightSidebar: app.stores.rightSidebar })?.item
  return item?.kind === "diff" ? item : null
}

/** The files the review lists, as the view lists them. */
function reviewFilesOf(app: AppModel, state: DiffState): DiffFile[] {
  const files = app.projectDiffs[state.projectId]?.files ?? []
  const selection = DiffCommit.projectSelection(app.stores.diffCommit, state.projectId)
  return reviewFiles(sortByPath(files), (path) => DiffCommit.isDiffPathChecked(selection, path), reviewItem(app)?.path ?? state.path)
}

function shownCountOf(app: AppModel, state: DiffState) {
  const files = reviewFilesOf(app, state)
  return Math.min(files.length, pageLimit(state.limit, files.findIndex((file) => file.path === state.path)))
}

/** Saving where the list is, for a reload to come back to. */
function saveReview(step: Step, app: AppModel): Step {
  const state = step.model.diff
  if (!state) return step
  const snapshot = reviewSnapshot(state, reviewFilesOf(app, state))
  return snapshot ? { ...step, commands: [...step.commands, SaveReviewState({ projectId: state.projectId, state: snapshot })] } : step
}

function withDiff(model: Model, app: AppModel, change: (state: DiffState) => DiffState, save = true): Step {
  const state = model.diff
  if (!state) return done(model)
  const next = done(modifyFields(model, { diff: () => change(state) }))
  return save ? saveReview(next, app) : next
}

function toggled(list: ReadonlyArray<string>, value: string) {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]
}

/** The file you're in, for the Changes card to light. */
function scrolledPath(step: Step, previous: string | null, next: string | null): Step {
  return previous === next ? step : { ...step, actions: [...step.actions, viewerStore(ViewerStore.Message.ScrolledDiffPath({ path: next }))] }
}

function activePath(app: AppModel, state: DiffState): string | null {
  const files = reviewFilesOf(app, state)
  const shown = files.slice(0, shownCountOf(app, state))
  return shown[Math.min(state.activeIndex, shown.length - 1)]?.path ?? null
}

function jumpTo(model: Model, app: AppModel, index: number): Step {
  const state = model.diff
  if (!state) return done(model)
  const files = reviewFilesOf(app, state)
  const clamped = Math.min(files.length - 1, Math.max(0, index))
  const target = files[clamped]
  if (!target) return done(model)
  const seq = state.jumpSeq + 1
  return withDiff(model, app, (current) => ({
    ...current,
    jump: { path: target.path, seq },
    jumpSeq: seq,
    restore: null,
    limit: pageLimit(current.limit, clamped),
  }), false)
}

function loadPatch(model: Model, path: string, full: boolean, digest: string): Step {
  const state = model.diff
  if (!state) return done(model)
  const key = patchKey(path, full)
  return done(
    modifyFields(model, { diff: () => ({ ...state, patches: { ...state.patches, [key]: { digest, loading: true } } }) }),
    [ReadPatch({ projectId: state.projectId, path, full, key, digest }) as AnyCommand],
  )
}

// OPENING FILES

function projectPathOf(app: AppModel, projectId: string | null): string | null {
  const snapshot = app.chat ? ChatSession.snapshotOf(app.chat) : null
  if (snapshot && snapshot.runtime.projectId === projectId) return snapshot.runtime.localPath
  return app.stores.sidebar.data.projectGroups.find((group) => group.groupKey === projectId)?.localPath ?? null
}

/**
 * `onOpenFile`: a project file opened outside Kanna. Batched, so the page's
 * rule that sends a file link to the viewer (chat/update's routeLocalLink)
 * leaves it alone: this is the file the viewer already shows.
 */
function openFile(app: AppModel, projectId: string | null, path: string, line: number | null, action: AppAction | null): AppAction[] {
  if (!action || action._tag !== "OpenExternal") return action ? [action] : []
  const target = { path: resolveDiffFilePath(projectPathOf(app, projectId), path), ...(line !== null ? { line } : {}) }
  return [batch(AppAction.OpenLocalLink({ target, action: action.action, editor: action.editor }))]
}

function viewerProjectId(app: AppModel): string | null {
  const item = ViewerStore.chatViewer({ viewer: app.stores.viewer, rightSidebar: app.stores.rightSidebar })?.item
  return item && (item.kind === "diff" || item.kind === "file") ? item.projectId : null
}

function choseDestination(model: Model, app: AppModel, path: string, line: number | null, value: string): Step {
  const request = openAppValueRequest({ value: value as OpenAppValue, editorCommandTemplate: app.stores.terminalPreferences.editorCommandTemplate })
  return done(model, [], [
    store(Stores.Message.GotOpenDestinationMessage({ message: OpenDestination.Message.ChoseFileDestination({ value }) })),
    ...openFile(app, viewerProjectId(app), path, line, request._tag === "Action" ? request.action : null),
  ])
}

// THE ROWS (chart, visualization, markdown and text bodies)

function rowsStep(model: Model, app: AppModel, message: Messages.Message): Step {
  const result = Messages.update(model.rows, message)
  let rows = result.model
  const commands = Command.mapMessages(result.commands ?? [], (inner: Messages.Message) => Message.GotRowsMessage({ message: inner })) as unknown as AnyCommand[]
  const out = result.outMessage
  const next = (actions: AppAction[] = [], extra: AnyCommand[] = []) => done(modifyFields(model, { rows: () => rows }), [...commands, ...extra], actions)
  if (!out) return next()
  switch (out._tag) {
    case "RequestedAppAction":
      return next([out.action])
    case "EscapedVisualization":
      return next([], [CheckFrameEscape({ repeat: out.repeat }) as AnyCommand])
    case "OpenedLocalLink": {
      // A file link inside what's shown (a markdown preview's) follows the same rule as one in the transcript.
      const target = out.target
      if (target.trigger === "contextmenu") return next()
      return next([AppAction.OpenLocalLink({ target, action: shouldOpenLocalFileLinkInEditor(target.path) ? "open_editor" : "open_default", editor: null })])
    }
    case "OpenedChat":
      return next(openChatActions(app, out.chatId))
    case "RequestedToolEntries":
      rows = Messages.failedToolEntries(rows, out.entryIds)
      return next()
    case "RequestedDebugRaw":
      rows = Messages.receivedDebugRaw(rows, out.entryId, Option.some(null))
      return next()
    default:
      return next()
  }
}

// THE PREVIEWER

function previewStep(model: Model, step: PreviewStep): Step {
  return done(modifyFields(model, { preview: () => step.preview }), step.commands, step.actions)
}

// UPDATE

export function update(model: Model, message: Message, app: AppModel): Return {
  return toReturn(step(model, message, app))
}

function step(model: Model, message: Message, app: AppModel): Step {
  switch (message._tag) {
    case "MountedCard":
      return mountedCard(model, app, message.key, message.cardEnters, message.bodyEnters)
    case "RenderedPane": {
      const leaving = !message.shownKey && model.lastShown !== null && model.lastShown.chatKey === message.chatKey
        && model.lastShown.key !== model.finishedExit && !model.reducedMotion
      const next = modifyFields(model, {
        was: () => message.state,
        lastShown: (last) => (message.shownKey && message.viewer
          ? { key: message.shownKey, chatKey: message.chatKey, viewer: message.viewer }
          : leaving ? last : null),
      })
      // Shut, with nothing leaving: no card.
      return message.state === "closed" && !leaving ? leaveCard(done(modifyFields(next, { card: () => null })), app, null) : done(next)
    }
    case "FinishedExit":
      return model.lastShown?.key === message.key
        ? leaveCard(done(modifyFields(model, { finishedExit: () => message.key, card: () => null })), app, null)
        : done(model)
    case "ChangedReducedMotion":
      return done(modifyFields(model, { reducedMotion: () => message.reduced }))
    case "MountedPreviewHost":
      return done(modifyFields(model, { hostRegistered: () => true }), [], [viewerStore(ViewerStore.Message.MountedChatPreviewHost())])

    case "PressedEscape":
      return done(model, [], [viewerStore(ViewerStore.Message.ClosedViewer({ byKey: true }))])
    case "ClickedClose":
      return done(model, [], [viewerStore(ViewerStore.Message.ClosedViewer({ byKey: false }))])
    case "ClickedShut":
      return done(model, [], [viewerStore(ViewerStore.Message.ShutViewer({ byKey: false }))])
    case "ClickedBack":
      return done(model, [], [viewerStore(ViewerStore.Message.SteppedBack({ byKey: false }))])
    case "ClickedToggleExpanded":
      return done(model, [], [viewerStore(ViewerStore.Message.ToggledExpanded())])
    case "PressedNavigationKey":
    case "ClickedNavigation": {
      // Only the review steps between items.
      const state = model.card?.key === DIFF_CARD_KEY ? model.diff : null
      if (!state) return done(model)
      const files = reviewFilesOf(app, state)
      const index = Math.min(state.activeIndex, files.length - 1)
      return jumpTo(model, app, message.direction === "next" ? index + 1 : index - 1)
    }

    case "GotTooltipMessage": {
      const result = Tooltip.update(tooltipOf(model, message.id), message.message)
      return done(
        modifyFields(model, { tooltips: (tooltips) => ({ ...tooltips, [message.id]: result.model }) }),
        Command.mapMessages(result.commands ?? [], (inner: Tooltip.Message) => Message.GotTooltipMessage({ id: message.id, message: inner })) as unknown as AnyCommand[],
      )
    }
    case "GotSelectMessage": {
      const result = Select.update(selectOf(model, message.id), message.message)
      const next = done(
        modifyFields(model, { selects: (selects) => ({ ...selects, [message.id]: result.model }) }),
        Command.mapMessages(result.commands ?? [], (inner: Select.Message) => Message.GotSelectMessage({ id: message.id, message: inner })) as unknown as AnyCommand[],
      )
      const out = result.outMessage
      const target = selectTarget(message.id)
      if (!out || out._tag !== "Selected" || !target) return next
      const chosen = choseDestination(next.model, app, target.path, target.line, out.value)
      return { model: chosen.model, commands: [...next.commands, ...chosen.commands], actions: chosen.actions }
    }

    case "ChoseView":
      return done(modifyFields(model, {
        toggles: (toggles) => ({ ...toggles, [message.cardKey]: message.value }),
        panes: (panes) => {
          const shown = new Set(panes[message.cardKey] ?? [])
          shown.add(message.previous)
          shown.add(message.value)
          return { ...panes, [message.cardKey]: [...shown] }
        },
      }))
    case "LoadedText":
      return done(modifyFields(model, { texts: (texts) => ({ ...texts, [message.slot]: message.state }) }))

    case "ClickedCopyLink":
      return done(model, [CopyLink({ url: message.url }) as AnyCommand])
    case "ClickedOpenInNewTab":
      return done(model, [OpenInNewTab({ url: message.url }) as AnyCommand])
    case "ClickedSortColumn":
      return done(modifyFields(model, {
        tables: (tables) => {
          const table = tableStateOf(model, message.slot)
          return { ...tables, [message.slot]: { ...table, sort: cycleSort(table.sort, message.column) } }
        },
      }))
    case "DrewRowChunk":
      return done(modifyFields(model, {
        tables: (tables) => ({ ...tables, [message.slot]: { ...tableStateOf(model, message.slot), count: Math.max(FIRST_ROW_CHUNK, message.count) } }),
      }))
    case "MeasuredTableFill":
      return done(modifyFields(model, {
        tables: (tables) => ({ ...tables, [message.slot]: { ...tableStateOf(model, message.slot), fill: message.fill } }),
      }))

    case "ClickedShowChanges":
      return done(model, [], [viewerStore(ViewerStore.Message.OpenedItem({ item: { kind: "diff", projectId: message.projectId, path: message.path }, expanded: false, byKey: false }))])
    case "ClickedWrapLines":
      return done(modifyFields(model, { wrapLines: (wrap) => !wrap }))
    case "ChoseOpenDestination":
      return choseDestination(model, app, message.path, message.line, message.value)
    case "ClickedOpenInEditor":
      return done(model, [], openFile(app, viewerProjectId(app), message.path, message.line, AppAction.OpenExternal({ action: "open_editor", editor: null, terminal: null })))
    case "ClickedLocalLink":
      return done(model, [], [AppAction.OpenLocalLink({ target: message.target, action: shouldOpenLocalFileLinkInEditor(message.target.path) ? "open_editor" : "open_default", editor: null })])

    // DIFFS

    case "MountedReview": {
      const state = initialDiffState(message.projectId, message.path, message.openCount, message.restore)
      const files = reviewFilesOf(app, state)
      const opened = Math.max(0, files.findIndex((file) => file.path === message.path))
      return done(modifyFields(model, { diff: () => ({ ...state, activeIndex: opened }) }))
    }
    case "SawFiles":
      return withDiff(model, app, (state) => {
        const seen = new Set(state.seen)
        if (message.paths.every((path) => seen.has(path))) return state
        for (const path of message.paths) seen.add(path)
        return { ...state, seen: [...seen] }
      }, false)
    case "NeededPatches": {
      let next = done(model)
      for (const load of message.loads) {
        const state = next.model.diff
        const entry = state?.patches[patchKey(load.path, load.full)]
        if (!state || entry?.digest === load.digest) continue
        const loaded = loadPatch(next.model, load.path, load.full, load.digest)
        next = { model: loaded.model, commands: [...next.commands, ...loaded.commands], actions: next.actions }
      }
      return next
    }
    case "ReceivedPatch":
    case "FailedPatch":
      return withDiff(model, app, (state) => {
        const entry = state.patches[message.key]
        if (entry?.digest !== message.digest) return state
        const settled = message._tag === "ReceivedPatch"
          ? { digest: message.digest, patch: message.patch, loading: false }
          : { digest: message.digest, error: message.error, loading: false }
        return { ...state, patches: { ...state.patches, [message.key]: settled } }
      }, false)
    case "ScrolledReview": {
      const state = model.diff
      if (!state) return done(model)
      const before = activePath(app, state)
      const next = withDiff(model, app, (current) => ({
        ...current,
        activeIndex: message.index,
        offset: message.offset >= 0 ? message.offset : current.offset,
      }))
      return scrolledPath(next, before, next.model.diff ? activePath(app, next.model.diff) : null)
    }
    case "LandedJump": {
      const state = model.diff
      if (!state || state.jump?.seq !== message.seq) return done(model)
      const next = withDiff(model, app, (current) => ({ ...current, jump: null, activeIndex: message.index, offset: message.offset }))
      // Now, not a render later: the card's highlight lands with the jump.
      return { ...next, actions: [...next.actions, viewerStore(ViewerStore.Message.ScrolledDiffPath({ path: message.path }))] }
    }
    case "ReleasedRestore":
      return withDiff(model, app, (state) => ({ ...state, restore: null }), false)
    case "ReopenedReview":
      // Opening a file (here, or another row in the Changes card) scrolls to
      // it; opening one (not the reload that restored this) goes to its top.
      return withDiff(model, app, (state) => ({
        ...state,
        path: message.path,
        openCount: message.openCount,
        restore: message.openCount !== state.openCount ? null : state.restore,
        jump: { path: message.path, seq: state.jumpSeq + 1 },
        jumpSeq: state.jumpSeq + 1,
      }), false)
    case "EmptiedReview":
      return done(model, [], [viewerStore(ViewerStore.Message.ClosedViewer({ byKey: false }))])
    case "ChoseDiffMode":
      return done(modifyFields(model, { diffRenderMode: () => message.mode }))
    case "ToggledCollapsed":
      return withDiff(model, app, (state) => ({ ...state, collapsed: toggled(state.collapsed, message.path) }))
    case "ToggledPreview":
      return withDiff(model, app, (state) => (
        (message.value === "preview") === state.previewing.includes(message.path)
          ? state
          : { ...state, previewing: toggled(state.previewing, message.path) }
      ))
    case "ClickedLoadHeld":
      return withDiff(model, app, (state) => ({ ...state, loaded: toggled(state.loaded, message.path) }))
    case "ToggledFullFile":
      return withDiff(model, app, (state) => ({ ...state, full: toggled(state.full, message.path) }))
    case "ClickedRetryPatch": {
      const state = model.diff
      const file = state ? reviewFilesOf(app, state).find((candidate) => candidate.path === message.path) : undefined
      return file ? loadPatch(model, message.path, message.full, file.patchDigest) : done(model)
    }
    case "ClickedLoadMore": {
      const state = model.diff
      if (!state) return done(model)
      const shownCount = shownCountOf(app, state)
      return withDiff(model, app, (current) => ({ ...current, limit: shownCount + DIFF_VIEWER_PAGE_SIZE }), false)
    }

    // CHART AND VISUALIZATION

    case "GotRowsMessage":
      return rowsStep(model, app, message.message)
    case "CheckedFrameEscape":
      return message.close ? done(model, [], [viewerStore(ViewerStore.Message.ClosedViewer({ byKey: true }))]) : done(model)
    case "ClickedDownloadImage":
    case "ClickedMarkup":
      if (model.visualizationDialog) return done(model)
      return done(model, [StartCapture({ kind: message._tag === "ClickedMarkup" ? "markup" : "save" }) as AnyCommand])
    case "StartedCapture": {
      const item = ViewerStore.chatViewer({ viewer: app.stores.viewer, rightSidebar: app.stores.rightSidebar })?.item
      const title = item?.kind === "visualization" ? item.artifact.title : ""
      const opened = Dialog.open(model.dialog)
      const dialog = message.kind === "save" ? initialSaveDialog(title, message.captureId) : { ...initialSaveDialog(title, message.captureId), kind: "markup" as const }
      const next = modifyFields(model, {
        visualizationDialog: () => dialog,
        dialog: () => opened.model,
        markup: () => (message.kind === "markup" ? initialMarkup(message.captureId) : null),
      })
      return done(next, message.kind === "markup" ? [LoadMarkupSource({ captureId: message.captureId }) as AnyCommand] : [])
    }
    case "LoadedMarkupSource":
    case "FailedMarkupSource":
    case "MeasuredMarkupStage":
    case "ChoseMarkupTool":
    case "ChoseMarkupColor":
    case "AddedMark":
    case "PlacedTextDraft":
    case "ChangedTextDraft":
    case "CommittedTextDraft":
    case "CancelledTextDraft":
    case "ClickedUndoMarkup":
    case "ClickedClearMarkup":
      return done(modifyFields(model, { markup: (markup) => (markup ? markupUpdate(markup, message) : markup) }))
    case "ClickedAttachMarkup": {
      const markup = model.markup
      if (!markup?.source || markup.attaching) return done(model)
      const committed = commitText(markup)
      const item = ViewerStore.chatViewer({ viewer: app.stores.viewer, rightSidebar: app.stores.rightSidebar })?.item
      const title = item?.kind === "visualization" ? item.artifact.title : ""
      return done(
        modifyFields(model, { markup: () => ({ ...committed, attaching: true, attachError: null }) }),
        [AttachMarkup({ captureId: markup.captureId, title, marks: committed.markup.marks }) as AnyCommand],
      )
    }
    case "SucceededAttachMarkup": {
      // Back to the chat, where the image now waits in the composer for the words to go with it.
      const closed = closeDialog(model)
      return { ...closed, actions: [...closed.actions, viewerStore(ViewerStore.Message.ClosedViewer({ byKey: false }))] }
    }
    case "FailedAttachMarkup":
      return done(modifyFields(model, { markup: (markup) => (markup ? { ...markup, attaching: false, attachError: message.error } : markup) }))
    case "ChangedImageName":
      return done(modifyFields(model, { visualizationDialog: (dialog) => (dialog ? { ...dialog, name: message.value } : dialog) }))
    case "ChoseImageType":
      return done(modifyFields(model, { visualizationDialog: (dialog) => (dialog ? { ...dialog, type: message.value } : dialog) }))
    case "SubmittedSaveImage": {
      const dialog = model.visualizationDialog
      if (!dialog || dialog.saving) return done(model)
      const item = ViewerStore.chatViewer({ viewer: app.stores.viewer, rightSidebar: app.stores.rightSidebar })?.item
      const title = item?.kind === "visualization" ? item.artifact.title : ""
      return done(
        modifyFields(model, { visualizationDialog: () => ({ ...dialog, saving: true, error: null }) }),
        [SaveImage({ captureId: dialog.captureId, name: dialog.name, title, type: dialog.type }) as AnyCommand],
      )
    }
    case "SucceededSaveImage":
    case "ClickedCancelSave":
    case "ClosedMarkup":
      return closeDialog(model)
    case "FailedSaveImage":
      return done(modifyFields(model, { visualizationDialog: (dialog) => (dialog ? { ...dialog, saving: false, error: message.error } : dialog) }))
    case "GotDialogMessage": {
      const result = Dialog.update(model.dialog, message.message)
      const next = modifyFields(model, { dialog: () => result.model })
      const commands = Command.mapMessages(result.commands ?? [], (inner: Dialog.Message) => Message.GotDialogMessage({ message: inner })) as unknown as AnyCommand[]
      if (result.outMessage?._tag === "Closed") {
        const closed = closeDialog(next)
        return { ...closed, commands: [...commands, ...closed.commands] }
      }
      return done(next, commands)
    }

    // THE PREVIEWER

    case "MountedPreviewSession": {
      if (model.preview?.chatId === message.chatId) return done(model)
      const left = leavePreview(done(model))
      const opened = openPreview(app, message.chatId, message.fadesIn)
      return { model: modifyFields(left.model, { preview: () => opened.preview }), commands: [...left.commands, ...opened.commands], actions: [...left.actions, ...opened.actions] }
    }
    case "GotPreviewSessionMessage": {
      const preview = model.preview
      if (!preview || (message.chatId !== null && message.chatId !== preview.chatId)) return done(model)
      return previewStep(model, sessionStep(app, preview, message.message))
    }
    case "GotPreviewTranscriptMessage": {
      const preview = model.preview
      if (!preview || (message.chatId !== null && message.chatId !== preview.chatId)) return done(model)
      return previewStep(model, transcriptStep(app, preview, message.message))
    }
    case "GotPreviewComposerMessage": {
      const preview = model.preview
      if (!preview || (message.chatId !== null && message.chatId !== preview.chatId)) return done(model)
      return previewStep(model, composerStep(app, preview, message.message))
    }
    case "LostPreviewedChat":
      return done(model, [], [viewerStore(ViewerStore.Message.ClosedAllViewer())])
    case "ClickedOpenPreviewInTab":
      return done(model, [], openChatActions(app, message.chatId, { target: "tab" }))
    case "ResizedPreviewDock": {
      const preview = model.preview
      if (!preview || preview.chatId !== message.chatId || preview.dockHeight === message.height) return done(model)
      return done(modifyFields(model, { preview: () => ({ ...preview, dockHeight: message.height }) }))
    }
    case "DroppedPreviewFiles":
    case "CompletedSideEffect":
      return done(model)
  }
}

function closeDialog(model: Model): Step {
  const dialog = model.visualizationDialog
  if (dialog) {
    dropCapture(dialog.captureId)
    releaseMarkupSource(dialog.captureId)
  }
  const closed = Dialog.close(model.dialog)
  return done(
    modifyFields(model, { visualizationDialog: () => null, markup: () => null, dialog: () => closed.model }),
    Command.mapMessages(closed.commands ?? [], (inner: Dialog.Message) => Message.GotDialogMessage({ message: inner })) as unknown as AnyCommand[],
  )
}
