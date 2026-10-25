import { Option } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { paneDurationMs } from "../../client/app/paneAnimation"
import { cn } from "../../client/lib/utils"
import {
  DEFAULT_RIGHT_SIDEBAR_SIZE,
  RIGHT_SIDEBAR_MAX_WIDTH_PX,
  RIGHT_SIDEBAR_MIN_WIDTH_PX,
} from "../core/stores/rightSidebar"
import { domStream } from "../ui/overlay/stream"
import { watchEdgePeek } from "./edgePeek"
import { Message } from "./message"
import type { Model } from "./model"

// WidgetsColumn (src/client/app/ChatPage/WidgetsColumn.tsx): the widget
// column beside the chat on desktop, the column only (the widgets inside are
// widgets/'s). Its width is a style worked out from state on every render:
// nothing when closed, the stored width when open.

/** The chat's narrowest, as a share of the page: beside the widget column, and beside the viewer's pane. */
export const CHAT_MIN_WORKSPACE_SIZE_PERCENT = 20

const KEYBOARD_STEP_PX = 16

/**
 * The widget column's width: the width it was given, inside its pixel
 * bounds, and never so wide that the chat drops under its least share.
 */
export function getWidgetsColumnWidthPx(storedPx: number, layoutWidth: number) {
  const requested = Number.isFinite(storedPx) ? storedPx : DEFAULT_RIGHT_SIDEBAR_SIZE
  const clamped = Math.min(RIGHT_SIDEBAR_MAX_WIDTH_PX, Math.max(RIGHT_SIDEBAR_MIN_WIDTH_PX, requested))
  if (!Number.isFinite(layoutWidth) || layoutWidth <= 0) return clamped
  return Math.min(clamped, layoutWidth * ((100 - CHAT_MIN_WORKSPACE_SIZE_PERCENT) / 100))
}

/** The width a key on the handle asks for, or none for a key it ignores. */
export function widthForHandleKey(key: string, widthPx: number): Option.Option<number> {
  if (key === "ArrowLeft") return Option.some(widthPx + KEYBOARD_STEP_PX)
  if (key === "ArrowRight") return Option.some(widthPx - KEYBOARD_STEP_PX)
  if (key === "Home") return Option.some(RIGHT_SIDEBAR_MIN_WIDTH_PX)
  if (key === "End") return Option.some(RIGHT_SIDEBAR_MAX_WIDTH_PX)
  if (key === "Enter") return Option.some(DEFAULT_RIGHT_SIDEBAR_SIZE)
  return Option.none()
}

/**
 * The handle's drag, on the element: the pointer is captured on the press so
 * the drag follows it anywhere, as the React handlers did. A press on the
 * closed column's handle (aria-hidden) is not a drag.
 */
const ColumnHandle = Mount.defineStream("WidgetsColumnHandle", {
  messages: [Message.PressedColumnHandle, Message.MovedColumnHandle, Message.ReleasedColumnHandle],
  execute: ({ element }) => domStream<typeof Message.PressedColumnHandle.Type | typeof Message.MovedColumnHandle.Type | typeof Message.ReleasedColumnHandle.Type>((emit) => {
    const handle = element as HTMLElement
    let dragging = false
    const down = (event: PointerEvent) => {
      if (handle.getAttribute("aria-hidden") === "true" || event.button !== 0) return
      event.preventDefault()
      handle.setPointerCapture(event.pointerId)
      dragging = true
      emit(Message.PressedColumnHandle({ x: event.clientX }))
    }
    const move = (event: PointerEvent) => {
      if (dragging) emit(Message.MovedColumnHandle({ x: event.clientX }))
    }
    const end = () => {
      if (!dragging) return
      dragging = false
      emit(Message.ReleasedColumnHandle())
    }
    handle.addEventListener("pointerdown", down)
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", end)
    handle.addEventListener("pointercancel", end)
    handle.addEventListener("lostpointercapture", end)
    return () => {
      handle.removeEventListener("pointerdown", down)
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", end)
      handle.removeEventListener("pointercancel", end)
      handle.removeEventListener("lostpointercapture", end)
    }
  }),
})

/** Whether the closed column is being shown over the chat (`enabled && requested`). */
export function widgetsPeeking(model: Model, options: { open: boolean; peekEnabled: boolean }) {
  return options.peekEnabled && !options.open && model.widgetsColumn.peekRequested
}

/** The peek's listeners, on the column's content (the panel as it is laid out). */
const WatchWidgetsPeek = Mount.defineStream("WatchWidgetsPeek", {
  messages: [Message.ChangedWidgetsPeek],
  execute: ({ element }) => domStream<typeof Message.ChangedWidgetsPeek.Type>((emit) => {
    const panel = element.parentElement
    if (!panel) return () => {}
    return watchEdgePeek({ side: "right", panel, edgePx: 2, report: (peeking) => emit(Message.ChangedWidgetsPeek({ peeking })) })
  }),
})

export function widgetsColumnView(
  model: Model,
  options: { open: boolean; widthPx: number; content: Html | null; wash: Html; peekEnabled: boolean },
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> {
  const { open, widthPx } = options
  const sliding = model.widgetsColumn.sliding
  // The peek (useEdgePeek): the closed column shown over the chat while the
  // mouse is at the window's right edge. Only the last 2px open it, where the
  // left sidebar takes 8: the transcript's scrollbar lives along this edge.
  // A setting, and off unless turned on (General).
  const peekWatched = options.peekEnabled && !open
  const peeking = widgetsPeeking(model, options)
  // Over the chat rather than beside it: in a peek, and while a column kept
  // from a peek is still making its room.
  const floating = !open || sliding
  const durationMs = paneDurationMs(open || peeking)
  return [
    // No width of its own (w-2 less -mx-1 each side), as the old panel
    // separator had: it straddles the seam without moving either side.
    h.div([
      h.Role("separator"),
      h.AriaOrientation("vertical"),
      h.AriaLabel("Resize widgets"),
      h.Attribute("aria-valuenow", String(Math.round(widthPx))),
      h.Attribute("aria-valuemin", String(RIGHT_SIDEBAR_MIN_WIDTH_PX)),
      h.Attribute("aria-valuemax", String(RIGHT_SIDEBAR_MAX_WIDTH_PX)),
      ...(open ? [] : [h.AriaHidden(true)]),
      h.Tabindex(open ? 0 : -1),
      h.Class(cn(
        "relative z-10 -mx-1 h-full w-2 shrink-0 cursor-col-resize touch-none focus-visible:outline-none",
        !open && "pointer-events-none",
      )),
      h.OnDoubleClick(Message.DoubleClickedColumnHandle()),
      h.OnKeyDownPreventDefault((key) => Option.map(widthForHandleKey(key, widthPx), () => Message.PressedColumnHandleKey({ key }))),
      h.OnMount(ColumnHandle()),
    ], []),
    h.div([
      // The pane clock and curve (paneAnimation.ts), on the width. Nothing
      // is clipped here: the row this sits at the end of does the clipping.
      // Floating, it is raised over the viewer (z-30), under the navbar.
      h.Class(cn("relative h-full min-h-0 shrink-0", sliding && "transition-[width] ease-glide", floating && "z-30")),
      h.Style({ width: `${open ? widthPx : 0}px`, ...(sliding ? { "transition-duration": `${durationMs}ms` } : {}) }),
      ...(!(open || peeking) ? [h.Inert(true)] : []),
      h.DataAttribute("widgets-column", "true"),
    ], [
      // At its full width whatever the column's, pinned to the column's left
      // edge: opening slides it in from the right rather than reflowing
      // every card at each frame.
      h.div([
        h.Class(cn("group/widgets absolute inset-y-0 left-0 min-h-0 overflow-hidden", peeking && "-translate-x-full")),
        ...(floating ? [h.DataAttribute("slideover", "true")] : []),
        h.Style({ width: `${widthPx}px`, "--pane-duration": `${durationMs}ms` }),
        h.DataAttribute("right-sidebar-open", open || peeking ? "true" : "false"),
        // Closed counts as animated: the peek comes and goes from there.
        h.DataAttribute("right-sidebar-animated", sliding || !open ? "true" : "false"),
        h.DataAttribute("right-sidebar-visual", "true"),
      ], [
        options.content,
        options.wash,
        peekWatched ? h.keyed("span")("widgets-peek", [h.Hidden(true), h.OnMount(WatchWidgetsPeek())], []) : null,
      ]),
    ]),
  ]
}
