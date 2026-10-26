import { Duration, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { CHAT_INPUT_ATTRIBUTE } from "../../client/app/chatFocusPolicy"
import {
  getSidebarJumpTargetIndex,
  isSidebarModifierShortcut,
  shouldShowSidebarNumberJumpHints,
} from "../../client/app/sidebarNumberJump"
import type { KeybindingsSnapshot } from "../../shared/types"
import type { KannaSocketService } from "../core/socket"
import { domStream } from "../ui/overlay/stream"
import { Message } from "./message"
import { FINE_POINTER_QUERY, isStandaloneNow, PHONE_LAYOUT_QUERY, STANDALONE_QUERY, type Model } from "./model"
import { projectDragging } from "./hoverCard"
import { OPEN_LAYER_SELECTOR } from "./mounts"
import { getProjectGroupReorderPreviewTargetId } from "./projects"

// KannaSidebar's window listeners and timers. A subscription sees only the
// sidebar's own Model, so what a key handler needs from the rest of the app
// (the keybindings, the chats the number jump counts, the current project)
// is read off the card's `data-sidebar-*` attributes when the key comes,
// which the view keeps current.

const CARD_ID = "kanna-sidebar"

function card(): HTMLElement | null {
  return document.getElementById(CARD_ID)
}

function cardKeybindings(): KeybindingsSnapshot | null {
  const raw = card()?.dataset.sidebarKeybindings
  if (!raw) return null
  try {
    return { bindings: JSON.parse(raw) } as KeybindingsSnapshot
  } catch {
    return null
  }
}

function mediaStream(query: string, toMessage: (matches: boolean) => Message, read: (list: MediaQueryList) => boolean = (list) => list.matches) {
  return domStream<Message>((emit) => {
    if (typeof window.matchMedia !== "function") return () => {}
    const list = window.matchMedia(query)
    const onChange = () => emit(toMessage(read(list)))
    onChange()
    list.addEventListener("change", onChange)
    return () => list.removeEventListener("change", onChange)
  })
}

const keyboardStream = domStream<Message>((emit) => {
  function handleKeyDown(event: KeyboardEvent) {
    const keybindings = cardKeybindings()
    const element = card()
    if (!element) return
    emit(Message.ChangedNumberJumpHints({ show: shouldShowSidebarNumberJumpHints(keybindings, event) }))

    if (isSidebarModifierShortcut(keybindings, "createChatInCurrentProject", event)) {
      if (!element.dataset.sidebarCurrentProject) return
      event.preventDefault()
      emit(Message.PressedCreateChatShortcut())
      return
    }
    if (isSidebarModifierShortcut(keybindings, "openAddProject", event)) {
      event.preventDefault()
      emit(Message.PressedAddProjectShortcut())
      return
    }
    if (isSidebarModifierShortcut(keybindings, "toggleFocusMode", event)) {
      // Turning focus on with no current project would hide every chat, so
      // the shortcut only turns it off in that state.
      if (!element.dataset.sidebarCurrentProject && element.dataset.sidebarFocusEnabled !== "true") return
      event.preventDefault()
      emit(Message.PressedToggleFocusShortcut())
      return
    }
    const targetIndex = getSidebarJumpTargetIndex(keybindings, event)
    if (targetIndex === null) return
    const chatId = (element.dataset.sidebarJumpChats ?? "").split(" ").filter(Boolean)[targetIndex - 1]
    if (!chatId) return
    event.preventDefault()
    emit(Message.PressedJumpShortcut({ chatId }))
  }

  function handleKeyUp(event: KeyboardEvent) {
    emit(Message.ChangedNumberJumpHints({ show: shouldShowSidebarNumberJumpHints(cardKeybindings(), event) }))
  }

  function clearHints() {
    emit(Message.ChangedNumberJumpHints({ show: false }))
  }

  // Escape leaves focus mode, but only when nothing nearer has a use for it:
  // last in line (added after the rest), and not when something already
  // answered it, a menu, select or dialog is up, or a text field other than
  // the composer has it.
  function handleEscape(event: KeyboardEvent) {
    if (card()?.dataset.sidebarFocused !== "true") return
    if (event.key !== "Escape" || event.defaultPrevented) return
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    if (document.querySelector(OPEN_LAYER_SELECTOR)) return
    const target = event.target
    if (target instanceof HTMLElement && !target.hasAttribute(CHAT_INPUT_ATTRIBUTE)
      && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return
    event.preventDefault()
    emit(Message.PressedEscapeToLeaveFocus())
  }

  window.addEventListener("keydown", handleKeyDown)
  window.addEventListener("keyup", handleKeyUp)
  window.addEventListener("blur", clearHints)
  window.addEventListener("keydown", handleEscape)
  return () => {
    window.removeEventListener("keydown", handleKeyDown)
    window.removeEventListener("keyup", handleKeyUp)
    window.removeEventListener("blur", clearHints)
    window.removeEventListener("keydown", handleEscape)
  }
})

/**
 * A Cmd-click (Ctrl elsewhere) on a chat, heard before the row's own click:
 * `isBackgroundOpenClick` read the event in flight, which a Foldkit click
 * Message doesn't carry.
 */
const backgroundClickStream = domStream<Message>((emit) => {
  const handleClick = (event: MouseEvent) => {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
    if (!(isMac ? event.metaKey : event.ctrlKey)) return
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-chat-id]") : null
    if (!row) return
    const inSidebar = row.closest(`#${CARD_ID}`) || row.closest("[data-list-hover]")
    if (!inSidebar) return
    const chatId = row.getAttribute("data-sidebar-chat") ?? row.getAttribute("data-chat-id")
    if (chatId) emit(Message.PressedChatInBackground({ chatId }))
  }
  document.addEventListener("click", handleClick, true)
  return () => document.removeEventListener("click", handleClick, true)
})

const ACTIVATION_DISTANCE_PX = 2

/**
 * A project header pressed for a drag: dnd-kit's PointerSensor with its 2px
 * activation distance, by hand. Rects are measured when the drag starts, as
 * dnd-kit measures its droppables, and the collision is the Projects view's
 * own (`getProjectGroupReorderPreviewTargetId`). Escape cancels. Once active,
 * the click that ends the drag goes nowhere (dnd-kit stops it in capture,
 * until 50ms after the drop).
 */
function projectDragStream(projectId: string, startY: number) {
  return domStream<Message>((emit) => {
    let active = false
    let rects = new Map<string, { top: number; height: number }>()
    let groupIds: string[] = []
    const stopClick = (event: MouseEvent) => event.stopPropagation()
    const preventDefault = (event: Event) => event.preventDefault()

    const measure = () => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-project-group]"))
      groupIds = nodes.map((node) => node.getAttribute("data-project-group") ?? "")
      rects = new Map(nodes.map((node) => {
        const rect = node.getBoundingClientRect()
        return [node.getAttribute("data-project-group") ?? "", { top: rect.top, height: rect.height }] as const
      }))
    }
    const handleMove = (event: PointerEvent) => {
      const deltaY = event.clientY - startY
      if (!active) {
        if (Math.abs(deltaY) < ACTIVATION_DISTANCE_PX && Math.abs(event.movementX) < ACTIVATION_DISTANCE_PX) return
        active = true
        projectDragging.active = true
        measure()
        document.addEventListener("click", stopClick, true)
        emit(Message.ActivatedProjectDrag({ activeHeight: rects.get(projectId)?.height ?? 0 }))
      }
      if (event.cancelable) event.preventDefault()
      const activeRect = rects.get(projectId)
      const overId = activeRect
        ? getProjectGroupReorderPreviewTargetId({
          activeId: projectId,
          groupIds,
          collisionRect: { top: activeRect.top + deltaY },
          droppableRects: rects,
        })
        : null
      emit(Message.MovedProjectDrag({ deltaY, overId }))
    }
    const handleUp = () => {
      projectDragging.active = false
      emit(Message.ReleasedProjectDrag())
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") emit(Message.CancelledProjectDrag())
    }
    document.addEventListener("pointermove", handleMove, { passive: false })
    document.addEventListener("pointerup", handleUp)
    document.addEventListener("pointercancel", handleUp)
    document.addEventListener("keydown", handleKeyDown)
    window.addEventListener("contextmenu", preventDefault)
    window.addEventListener("dragstart", preventDefault)
    return () => {
      projectDragging.active = false
      document.removeEventListener("pointermove", handleMove)
      document.removeEventListener("pointerup", handleUp)
      document.removeEventListener("pointercancel", handleUp)
      document.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("contextmenu", preventDefault)
      window.removeEventListener("dragstart", preventDefault)
      if (active) window.setTimeout(() => document.removeEventListener("click", stopClick, true), 50)
    }
  })
}

export const subscriptions = Subscription.make<Model, Message, KannaSocketService>()((entry) => ({
  // Ages and date buckets move on a slow clock (KannaSidebar's 30s interval).
  clock: Subscription.persistentEntry(
    Stream.tick(Duration.seconds(30)).pipe(Stream.drop(1), Stream.map(() => Message.TickedClock({ nowMs: Date.now() }))),
  ),
  finePointer: Subscription.persistentEntry(mediaStream(FINE_POINTER_QUERY, (matches) => Message.ChangedFinePointer({ matches }))),
  phoneLayout: Subscription.persistentEntry(mediaStream(PHONE_LAYOUT_QUERY, (matches) => Message.ChangedPhoneLayout({ matches }))),
  standalone: Subscription.persistentEntry(mediaStream(STANDALONE_QUERY, () => Message.ChangedStandalone({ matches: isStandaloneNow() }))),
  keyboard: Subscription.persistentEntry(keyboardStream),
  backgroundClick: Subscription.persistentEntry(backgroundClickStream),
  projectDrag: entry({ projectId: Schema.NullOr(Schema.String), pointerId: Schema.Number, startY: Schema.Number }, {
    modelToDependencies: (model) => ({
      projectId: model.projectDrag?.projectId ?? null,
      pointerId: model.projectDrag?.pointerId ?? -1,
      startY: model.projectDrag?.startY ?? 0,
    }),
    dependenciesToStream: ({ projectId, startY }) => (projectId ? projectDragStream(projectId, startY) : Stream.empty),
  }),
}))
