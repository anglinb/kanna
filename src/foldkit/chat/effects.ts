import { Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import { domStream } from "../ui/overlay/stream"
import { interpolateLayout, prefersReducedMotion } from "../../client/app/paneAnimation"
import {
  attachFilesToComposer,
  CHAT_INPUT_ATTRIBUTE,
  hasActiveFocusOverlay,
  hasActiveTextSelection,
  resolveChatFocusAction,
  RESTORE_CHAT_INPUT_FOCUS_EVENT,
  shouldComposerClaimFocus,
} from "../../client/app/chatFocusPolicy"
import { hasFileDragTypes } from "../../client/app/ChatPage/utils"
import { snapshotDroppedFiles } from "../../client/lib/snapshotDroppedFiles"
import { separatorDrag } from "./resizable"
import { DIFF_REFRESH_INTERVAL_MS, EMPTY_STATE_TEXT, EMPTY_STATE_TYPING_INTERVAL_MS } from "../../client/app/ChatPage/utils"
import { Message, ShortcutAction, TerminalPurpose, Watch, WashId, type MenuId } from "./message"
import { actionMatchesEvent } from "../../client/lib/keybindings"
import type { ProjectQuickAction } from "../../shared/protocol"
import type { KeybindingsSnapshot, UsageLimitsSnapshot } from "../../shared/types"
import { errorMessage, sendCommand } from "../core/socket"
import { newTerminalId } from "../core/stores/terminalLayout"

/** CommandPalette.tsx's OPEN_COMMAND_PALETTE_EVENT (a React file: restated). */
export const OPEN_COMMAND_PALETTE_EVENT = "kanna:open-command-palette"

// The page's Mounts and Commands: the work ChatPage's refs, layout effects
// and observers did against the live DOM.

const PAGE_ROOT_ATTRIBUTE = "data-chat-page-root"

/** Page roots already seen: a new one is a page mounted afresh (ChatPage's refs reset). */
const seenPageRoots = new WeakSet<Element>()

/**
 * Keyed on the page facts it carries, so it mounts again whenever one of them
 * changes, and reports them: the page's useEffects, run on their deps. `fresh`
 * says the page itself is new (left and come back to), so what ChatPage held
 * in refs starts over.
 */
export const ObservePage = Mount.define("ObserveChatPage", {
  args: { watch: Watch },
  messages: [Message.ObservedPage],
  execute: ({ element, watch }) => Effect.sync(() => {
    const root = element.closest(`[${PAGE_ROOT_ATTRIBUTE}]`)
    const fresh = root !== null && !seenPageRoots.has(root)
    if (root) seenPageRoots.add(root)
    return Message.ObservedPage({ watch, fresh })
  }),
})

export const pageRootAttribute = PAGE_ROOT_ATTRIBUTE

/** Dispatched on window as the page's view goes, with the showing's token. */
export const PAGE_LEFT_EVENT = "kanna:chat-page-left"

let presenceTokens = 0

/**
 * The page's view, mounted: reported as it mounts, and announced on window
 * as it goes (a Mount can't report after its element is gone; the page's
 * subscription hears the event). What ChatPage held while mounted (its
 * subscriptions) follows this.
 */
export const HoldPagePresence = Mount.defineStream("ChatPagePresence", {
  messages: [Message.EnteredPage],
  execute: () => domStream<typeof Message.EnteredPage.Type>((emit) => {
    presenceTokens += 1
    const token = presenceTokens
    emit(Message.EnteredPage({ token }))
    return () => window.dispatchEvent(new CustomEvent(PAGE_LEFT_EVENT, { detail: { token } }))
  }),
})

/** The page's box (useLayoutWidth and useFixedTerminalHeight's observer). */
export const ObserveLayout = Mount.defineStream("ObserveChatLayout", {
  messages: [Message.MeasuredLayout],
  execute: ({ element }) => domStream<typeof Message.MeasuredLayout.Type>((emit) => {
    const read = () => {
      const rect = element.getBoundingClientRect()
      emit(Message.MeasuredLayout({ width: (element as HTMLElement).clientWidth, height: rect.height }))
    }
    const observer = new ResizeObserver(read)
    observer.observe(element)
    read()
    return () => observer.disconnect()
  }),
})

/** The navbar's height, for `--chat-navbar-h` on its parent. */
export const ObserveNavbar = Mount.defineStream("ObserveChatNavbar", {
  messages: [Message.MeasuredNavbar],
  execute: ({ element }) => domStream<typeof Message.MeasuredNavbar.Type>((emit) => {
    const read = () => emit(Message.MeasuredNavbar({ height: (element as HTMLElement).offsetHeight }))
    const observer = new ResizeObserver(read)
    observer.observe(element)
    read()
    return () => observer.disconnect()
  }),
})

/** The composer dock's height (useTranscriptPaddingBottom). */
export const ObserveDock = Mount.defineStream("ObserveChatDock", {
  messages: [Message.MeasuredDock],
  execute: ({ element }) => domStream<typeof Message.MeasuredDock.Type>((emit) => {
    const read = () => emit(Message.MeasuredDock({ height: element.getBoundingClientRect().height }))
    const observer = new ResizeObserver(read)
    observer.observe(element)
    read()
    return () => observer.disconnect()
  }),
})

/** How long after a chat opens its scroll position is still being put back. */
const WASH_SETTLE_MS = 400

/**
 * ChatNavbarWash's effects: whether its scroller (the `data-navbar-scroller`
 * beside it) has anything under the bar, and the settle after a chat opens.
 * Scroll events don't bubble, so it listens on its parent in the capture
 * phase, which also covers a scroller that remounts. Keyed on the chat, as
 * the React effects ran on `resetKey`.
 */
export const WatchWash = Mount.defineStream("WatchNavbarWash", {
  args: { wash: WashId, token: Schema.Number },
  messages: [Message.ChangedWashScroll, Message.StartedWash, Message.SettledWash],
  execute: ({ element, wash, token }) => domStream<typeof Message.ChangedWashScroll.Type | typeof Message.StartedWash.Type | typeof Message.SettledWash.Type>((emit) => {
    const host = element.parentElement
    emit(Message.StartedWash({ wash, token }))
    const settled = window.setTimeout(() => emit(Message.SettledWash({ wash, token })), WASH_SETTLE_MS)
    if (!host) return () => window.clearTimeout(settled)
    const read = () => {
      const scroller = host.querySelector<HTMLElement>("[data-navbar-scroller]")
      emit(Message.ChangedWashScroll({ wash, scrolled: (scroller?.scrollTop ?? 0) > 0 }))
    }
    const handleScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.matches("[data-navbar-scroller]")) read()
    }
    read()
    // A scroller that just mounted may take its position a frame later.
    const frame = window.requestAnimationFrame(read)
    host.addEventListener("scroll", handleScroll, { capture: true, passive: true })
    return () => {
      window.clearTimeout(settled)
      window.cancelAnimationFrame(frame)
      host.removeEventListener("scroll", handleScroll, { capture: true })
    }
  }),
})

/**
 * Types the empty-state line once each time the empty state appears. Not per
 * chat: going from one new chat to another (switching project from the path
 * button) keeps the empty state up, and retyping it read as the page reloading.
 */
export const TypeEmptyState = Mount.defineStream("TypeEmptyState", {
  messages: [Message.TypedEmptyStateCharacter],
  execute: () => domStream<typeof Message.TypedEmptyStateCharacter.Type>((emit) => {
    let characterIndex = 0
    const interval = window.setInterval(() => {
      characterIndex += 1
      emit(Message.TypedEmptyStateCharacter({ count: characterIndex }))
      if (characterIndex >= EMPTY_STATE_TEXT.length) window.clearInterval(interval)
    }, EMPTY_STATE_TYPING_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }),
})

const SHORTCUT_ACTIONS: ReadonlyArray<ShortcutAction> = ["toggleEmbeddedTerminal", "toggleRightSidebar", "openInFinder", "openInEditor", "addSplitTerminal"]

/**
 * The page's shortcuts, on window: the first binding that matches is
 * prevented at once (it must be, in the listener) and reported.
 */
export function shortcutListener(bindings: KeybindingsSnapshot, emit: (message: typeof Message.PressedShortcut.Type) => void) {
  return (event: KeyboardEvent) => {
    for (const action of SHORTCUT_ACTIONS) {
      if (actionMatchesEvent(bindings, action, event)) {
        event.preventDefault()
        emit(Message.PressedShortcut({ action }))
        return
      }
    }
  }
}

/** The page's shortcuts, on window, while there is a project (ChatPage's keydown effect). */
export const ListenForShortcuts = Mount.defineStream("ChatPageShortcuts", {
  args: { bindings: Schema.String },
  messages: [Message.PressedShortcut],
  execute: ({ bindings }) => domStream<typeof Message.PressedShortcut.Type>((emit) => {
    const listener = shortcutListener({ bindings: JSON.parse(bindings), warning: null, filePathDisplay: "" } as KeybindingsSnapshot, emit)
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }),
})

/** The widget sheet on a phone: Escape closes it, and the page under it doesn't scroll. */
export const HoldMobileSheet = Mount.defineStream("ChatMobileWidgetSheet", {
  messages: [Message.PressedEscapeOnSheet],
  execute: () => domStream<typeof Message.PressedEscapeOnSheet.Type>((emit) => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      emit(Message.PressedEscapeOnSheet())
    }
    window.addEventListener("keydown", handleEscape)
    return () => {
      window.removeEventListener("keydown", handleEscape)
      document.body.style.overflow = previousOverflow
    }
  }),
})

/**
 * The open column's diffs, kept fresh: every few seconds while the tab is
 * visible (a hidden tab has nobody looking), and once the moment it is
 * visible or focused again.
 */
export const KeepDiffsFresh = Mount.defineStream("ChatDiffRefresh", {
  messages: [Message.TickedDiffRefresh],
  execute: () => domStream<typeof Message.TickedDiffRefresh.Type>((emit) => {
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return
      emit(Message.TickedDiffRefresh())
    }, DIFF_REFRESH_INTERVAL_MS)
    const handle = () => {
      if (document.visibilityState !== "visible") return
      emit(Message.TickedDiffRefresh())
    }
    window.addEventListener("focus", handle)
    document.addEventListener("visibilitychange", handle)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener("focus", handle)
      document.removeEventListener("visibilitychange", handle)
    }
  }),
})

/** The resize cursor, and no text selected, wherever the pointer strays mid-drag. */
export const HoldColumnDragCursor = Mount.defineStream("WidgetsColumnDragCursor", {
  messages: [Message.CompletedSideEffect],
  execute: () => domStream<typeof Message.CompletedSideEffect.Type>(() => {
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }),
})

/**
 * The terminal's split sliding from one layout to another on the pane clock
 * (useTerminalToggleAnimation's rAF loop), one Message a frame. Under
 * reduced motion it lands at once.
 */
export const AnimateTerminalSplit = Mount.defineStream("AnimateTerminalSplit", {
  args: { token: Schema.Number, fromChat: Schema.Number, fromTerminal: Schema.Number, toChat: Schema.Number, toTerminal: Schema.Number, durationMs: Schema.Number },
  messages: [Message.SteppedTerminalSplit],
  execute: ({ token, fromChat, fromTerminal, toChat, toTerminal, durationMs }) => domStream<typeof Message.SteppedTerminalSplit.Type>((emit) => {
    if (prefersReducedMotion()) {
      emit(Message.SteppedTerminalSplit({ token, chat: toChat, terminal: toTerminal, done: true }))
      return () => {}
    }
    const startTime = performance.now()
    let frame = 0
    const step = (now: number) => {
      const progress = Math.min(1, (now - startTime) / durationMs)
      const next = interpolateLayout([fromChat, fromTerminal], [toChat, toTerminal], progress)
      if (progress < 1) {
        emit(Message.SteppedTerminalSplit({ token, chat: next[0], terminal: next[1], done: false }))
        frame = window.requestAnimationFrame(step)
        return
      }
      emit(Message.SteppedTerminalSplit({ token, chat: toChat, terminal: toTerminal, done: true }))
    }
    frame = window.requestAnimationFrame(step)
    return () => window.cancelAnimationFrame(frame)
  }),
})

/**
 * Dragging the terminal's or the viewer's split. The chat keeps its least
 * share (`minFirstPx`, else `minFirst` percent); the second panel can be
 * dragged to nothing, which closes it.
 */
export const DragSeparator = Mount.defineStream("DragChatSeparator", {
  args: { split: Schema.Literals(["terminal", "viewer"]), minFirst: Schema.Number, minFirstPx: Schema.Number },
  messages: [Message.DraggedSeparator],
  execute: ({ element, split, minFirst, minFirstPx }) => domStream<typeof Message.DraggedSeparator.Type>((emit) =>
    separatorDrag({
      element: element as HTMLElement,
      orientation: split === "terminal" ? "vertical" : "horizontal",
      min: () => {
        if (minFirstPx <= 0) return minFirst
        const group = element.parentElement?.getBoundingClientRect()
        const size = split === "terminal" ? group?.height ?? 0 : group?.width ?? 0
        return size > 0 ? Math.min(100, (minFirstPx / size) * 100) : minFirst
      },
      max: () => 100,
      report: (first, groupSizePx, done) => emit(Message.DraggedSeparator({ split, first, groupSizePx, done })),
    })),
})

// FOCUS (useStickyChatFocus)

/** The page's own composer: the chat card's, not a previewed chat's in the viewer. */
function chatInput(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>(`[data-chat-card] [${CHAT_INPUT_ATTRIBUTE}]`)
    ?? document.querySelector<HTMLTextAreaElement>(`[${CHAT_INPUT_ATTRIBUTE}]`)
}

/** How long an arrival holds focus in the composer: past a menu's close animation. */
const ARRIVAL_CLAIM_MS = 1000
/** How many times one arrival takes focus back, before something that insists wins. */
const ARRIVAL_CLAIM_LIMIT = 4

/**
 * Arriving at a chat puts focus in its composer and holds it there until you
 * do something or a second has passed: a right-click menu gives focus back
 * to the row it opened on once its close animation ends, by which time the
 * chat made from it is up. Only with a real keyboard: on a phone this would
 * raise the on-screen keyboard over the chat you came to read. Keyed on the
 * arrival.
 */
export const HoldArrivalFocus = Mount.defineStream("ChatArrivalFocus", {
  messages: [Message.CompletedSideEffect],
  execute: () => domStream<typeof Message.CompletedSideEffect.Type>(() => {
    if (!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) return () => {}
    let claimsLeft = ARRIVAL_CLAIM_LIMIT
    const claim = (target: Element | null) => {
      const fallback = chatInput()
      if (claimsLeft === 0) return
      if (!shouldComposerClaimFocus({ target, fallback, hasActiveOverlay: hasActiveFocusOverlay(document) })) return
      claimsLeft -= 1
      fallback?.focus({ preventScroll: true })
    }
    const handleFocusIn = (event: FocusEvent) => claim(event.target instanceof Element ? event.target : null)
    // A press or a key is you deciding where focus goes next.
    const release = () => {
      window.clearTimeout(timeoutId)
      document.removeEventListener("focusin", handleFocusIn)
      window.removeEventListener("pointerdown", release, true)
      window.removeEventListener("keydown", release, true)
    }
    const timeoutId = window.setTimeout(release, ARRIVAL_CLAIM_MS)
    document.addEventListener("focusin", handleFocusIn)
    window.addEventListener("pointerdown", release, true)
    window.addEventListener("keydown", release, true)
    // The composer may mount a frame after the page: claim once it's there.
    const frame = window.requestAnimationFrame(() => claim(document.activeElement))
    claim(document.activeElement)
    return () => {
      window.cancelAnimationFrame(frame)
      release()
    }
  }),
})

/**
 * Focus goes back to the composer after a click on nothing focusable in the
 * chat, on Escape from nowhere in particular (unless a turn can be
 * cancelled), and when something asks for it (`RESTORE_CHAT_INPUT_FOCUS_EVENT`).
 */
export const KeepChatFocus = Mount.defineStream("ChatStickyFocus", {
  args: { canCancel: Schema.Boolean },
  messages: [Message.CompletedSideEffect],
  execute: ({ canCancel }) => domStream<typeof Message.CompletedSideEffect.Type>(() => {
    let rafId = 0
    let pointerStartTarget: Element | null = null
    const restoreFocusIfNeeded = (pointerEndTarget: EventTarget | null) => {
      const target = pointerEndTarget instanceof Element ? pointerEndTarget : null
      const root = document.querySelector("[data-chat-card]")
      const fallback = chatInput()
      if (resolveChatFocusAction({
        trigger: "pointer",
        activeElement: document.activeElement,
        pointerStartTarget,
        pointerEndTarget: target,
        root,
        fallback,
        hasActiveOverlay: hasActiveFocusOverlay(document),
        hasActiveSelection: hasActiveTextSelection(window.getSelection()),
      }) === "restore") fallback?.focus({ preventScroll: true })
      pointerStartTarget = null
    }
    const handlePointerDown = (event: PointerEvent) => {
      cancelAnimationFrame(rafId)
      pointerStartTarget = event.target instanceof Element ? event.target : null
    }
    const handlePointerUp = (event: PointerEvent) => {
      cancelAnimationFrame(rafId)
      rafId = window.requestAnimationFrame(() => restoreFocusIfNeeded(event.target))
    }
    const handleRestoreFocus = () => {
      pointerStartTarget = null
      const fallback = chatInput()
      if (!fallback || fallback.disabled) return
      fallback.focus({ preventScroll: true })
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      const fallback = chatInput()
      if (resolveChatFocusAction({
        trigger: "escape",
        activeElement: document.activeElement,
        fallback,
        hasActiveOverlay: hasActiveFocusOverlay(document),
        canCancel,
        defaultPrevented: event.defaultPrevented,
      }) !== "escape-focus") return
      event.preventDefault()
      fallback?.focus({ preventScroll: true })
    }
    window.addEventListener("pointerdown", handlePointerDown, true)
    window.addEventListener("pointerup", handlePointerUp, true)
    window.addEventListener("keydown", handleKeyDown, true)
    window.addEventListener(RESTORE_CHAT_INPUT_FOCUS_EVENT, handleRestoreFocus)
    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener("pointerdown", handlePointerDown, true)
      window.removeEventListener("pointerup", handlePointerUp, true)
      window.removeEventListener("keydown", handleKeyDown, true)
      window.removeEventListener(RESTORE_CHAT_INPUT_FOCUS_EVENT, handleRestoreFocus)
    }
  }),
})

// FILES DROPPED ON THE PAGE (usePageFileDrop)

/**
 * Files dragged over the chat card: the transcript shows its drop overlay
 * while they're over it, and a drop hands them to the composer. The bytes
 * are read in the drop handler, while the drop is live (see
 * snapshotDroppedFiles for why a later read can come back empty on iOS).
 */
export const PageFileDrop = Mount.defineStream("ChatPageFileDrop", {
  args: { enabled: Schema.Boolean },
  messages: [Message.ChangedPageFileDrag],
  execute: ({ element, enabled }) => domStream<typeof Message.ChangedPageFileDrag.Type>((emit) => {
    if (!enabled) return () => {}
    let depth = 0
    let active = false
    const set = (next: boolean) => {
      if (active === next) return
      active = next
      emit(Message.ChangedPageFileDrag({ active: next }))
    }
    const hasFiles = (event: DragEvent) => hasFileDragTypes(event.dataTransfer?.types ?? [])
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth += 1
      set(true)
    }
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
      set(true)
    }
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = Math.max(0, depth - 1)
      if (depth === 0) set(false)
    }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      set(false)
      const files = [...(event.dataTransfer?.files ?? [])]
      if (files.length === 0) return
      void snapshotDroppedFiles(files).then((copies) => {
        if (copies.length > 0) attachFilesToComposer(copies)
      })
    }
    element.addEventListener("dragenter", enter as EventListener)
    element.addEventListener("dragover", over as EventListener)
    element.addEventListener("dragleave", leave as EventListener)
    element.addEventListener("drop", drop as EventListener)
    return () => {
      element.removeEventListener("dragenter", enter as EventListener)
      element.removeEventListener("dragover", over as EventListener)
      element.removeEventListener("dragleave", leave as EventListener)
      element.removeEventListener("drop", drop as EventListener)
    }
  }),
})

// COMMANDS

/**
 * `openContextMenuFromButton`: where the menu a button opens goes, under the
 * middle of the button.
 */
export const MeasureMenuButton = Command.define("MeasureMenuButton", {
  args: { id: Schema.Literals(["overflow", "title"]), selector: Schema.String },
  messages: [Message.MeasuredMenuButton, Message.CompletedSideEffect],
  execute: ({ id, selector }) => Effect.sync(() => {
    const button = document.querySelector(selector)
    if (!button) return Message.CompletedSideEffect()
    const rect = button.getBoundingClientRect()
    return Message.MeasuredMenuButton({ id: id as MenuId, x: rect.left + rect.width / 2, y: rect.bottom })
  }),
})

/** The open tab's menu button, measured the same way (`openContextMenuFromButton`). */
export const MeasureTabMenuButton = Command.define("MeasureTabMenuButton", {
  args: { chatId: Schema.String },
  messages: [Message.MeasuredTabMenuButton, Message.CompletedSideEffect],
  execute: ({ chatId }) => Effect.sync(() => {
    const button = document.querySelector(`[data-chat-tab="${CSS.escape(chatId)}"] [aria-label="Chat actions"]`)
    if (!button) return Message.CompletedSideEffect()
    const rect = button.getBoundingClientRect()
    return Message.MeasuredTabMenuButton({ chatId, x: rect.left + rect.width / 2, y: rect.bottom })
  }),
})

export const RefreshDiffs = Command.define("RefreshChatDiffs", {
  args: { chatId: Schema.String },
  messages: [Message.CompletedSideEffect],
  // `.catch(() => {})`: a refresh that fails changes nothing on screen.
  execute: ({ chatId }) => sendCommand({ type: "chat.refreshDiffs", chatId }).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedSideEffect()),
  ),
})

/** QuickActionsWidget's read, once per project the page opens on (`refreshCachedProjectQuickActions`). */
export const ReadQuickActions = Command.define("ReadProjectQuickActions", {
  args: { projectId: Schema.String },
  messages: [Message.SucceededReadQuickActions, Message.FailedReadQuickActions],
  execute: ({ projectId }) => sendCommand<ReadonlyArray<ProjectQuickAction>>({ type: "project.readQuickActions", projectId }).pipe(
    Effect.map((actions) => Message.SucceededReadQuickActions({ projectId, actions: actions ?? [] })),
    Effect.catch((error) => Effect.succeed(Message.FailedReadQuickActions({ projectId, error: errorMessage(error) }))),
  ),
})

/** useUsageLimits' refresh: the server's TTL coalesces however many ask. */
export const RefreshUsage = Command.define("RefreshUsageLimits", {
  args: { force: Schema.Boolean },
  messages: [Message.CompletedRefreshUsage],
  execute: ({ force }) => sendCommand<UsageLimitsSnapshot>({ type: "usage.refresh", force }).pipe(
    Effect.map((result) => Message.CompletedRefreshUsage({ snapshot: result && Array.isArray(result.providers) ? result : null })),
    // Errors surface as "unavailable" provider states in the snapshot.
    Effect.catch(() => Effect.succeed(Message.CompletedRefreshUsage({ snapshot: null }))),
  ),
})

/** Renames from the title typed in place: straight to the socket, as the React page did. */
export const RenameChat = Command.define("RenameChatInPlace", {
  args: { chatId: Schema.String, title: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ chatId, title }) => sendCommand({ type: "chat.rename", chatId, title }).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedSideEffect()),
  ),
})

/** In this browser, not through the machine the project lives on. */
export const OpenWindow = Command.define("OpenChatPageWindow", {
  args: { url: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ url }) => Effect.sync(() => {
    window.open(url, "_blank", "noopener,noreferrer")
    return Message.CompletedSideEffect()
  }),
})

/** The command palette listens for this (`openCommandPalette`). */
export const OpenCommandPalette = Command.define("OpenCommandPalette", {
  args: { page: Schema.NullOr(Schema.String) },
  messages: [Message.CompletedSideEffect],
  execute: ({ page }) => Effect.sync(() => {
    window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT, { detail: page ? { page } : undefined }))
    return Message.CompletedSideEffect()
  }),
})

/** The composer's textarea, which takes focus back when the viewer closes or the terminal hides. */
export const FocusChatInput = Command.define("FocusChatInput", {
  messages: [Message.CompletedSideEffect],
  execute: Effect.sync(() => {
    chatInput()?.focus({ preventScroll: true })
    return Message.CompletedSideEffect()
  }),
})

export const MakeTerminalId = Command.define("MakeChatTerminalId", {
  args: { purpose: TerminalPurpose, projectId: Schema.String, chatKey: Schema.NullOr(Schema.String), nextTerminalIndex: Schema.Number },
  messages: [Message.MadeTerminalId],
  execute: ({ purpose, projectId, chatKey, nextTerminalIndex }) => Effect.sync(() =>
    Message.MadeTerminalId({ purpose, projectId, chatKey, terminalId: newTerminalId(nextTerminalIndex) })),
})

export const ElapseColumnSlide = Command.define("ElapseWidgetsColumnSlide", {
  args: { token: Schema.Number, ms: Schema.Number },
  messages: [Message.ElapsedColumnSlide],
  execute: ({ token, ms }) => Effect.sleep(ms).pipe(Effect.as(Message.ElapsedColumnSlide({ token }))),
})
