import { Schema } from "effect"
import { Mount } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../../client/lib/utils"
import { domStream } from "../../ui/overlay/stream"
import { ChevronDown } from "../../ui/icons"
import { transcriptMarkdownChildren, type RowContext } from "./context"
import { ClampScope, Message } from "./model"

/**
 * The text of a message sent to the agent, held to a number of lines until
 * asked for (ClampedMessageText.tsx; see there for the why of every choice).
 * What the user typed, what another agent, a sub-chat or a schedule sent,
 * and each of those while it waits in the queue.
 *
 * The limit is a height in lines of the text's own type, with the last line
 * faded by a mask. Whether the text runs past it is measured on the element
 * (`ClampMeasure`, a Mount) and kept in the Model; so is whether it is open.
 * While folded, a click anywhere on the bubble (the element marked
 * `data-fold-surface`) opens it, as a press on Show more does.
 */

/** How many lines of a message show before Show more, by who sent it. */
export const CLAMP_LINES = { typed: 25, sent: 5 } as const

/** A prompt keeps the line breaks it was typed with. */
const TEXT_CLASS = "[&_p]:whitespace-pre-line"

/**
 * Marks the element a folded message can be opened by clicking: its bubble,
 * padding included. Without one, the text itself is the surface.
 */
export const FOLD_SURFACE_ATTRIBUTE = "data-fold-surface"

/** Things inside a message that have a click of their own. */
const OWN_CLICK_SELECTOR = "a, button, input, textarea, select, summary, label, img, video, audio, [role='button'], [role='link'], [contenteditable='true']"
/** A press that travels further than this before it lifts is a drag. */
const CLICK_SLOP_PX = 4

/**
 * Whether a click on a folded message's bubble is the reader asking to open
 * it, as a press on Show more is. Copied from ClampedMessageText.tsx.
 */
export function isFoldClick({ button, clicks, modified, movedPx, selecting, onOwnClick, handled }: {
  button: number
  clicks: number
  modified: boolean
  movedPx: number
  selecting: boolean
  onOwnClick: boolean
  handled: boolean
}): boolean {
  if (button !== 0 || modified || handled || onOwnClick) return false
  if (clicks > 1) return false
  if (movedPx > CLICK_SLOP_PX) return false
  return !selecting
}

function hasSelectedText(): boolean {
  const selection = typeof window !== "undefined" ? window.getSelection() : null
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim())
}

/**
 * Stop the transcript following its end, as a turn of the wheel does: text
 * the reader just asked to see should not grow upward out of view.
 */
function releaseFollow(from: HTMLElement) {
  if (typeof WheelEvent === "undefined") return
  from.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 0 }))
}

/** The id of a clamp's text box, which its Show more names in `aria-controls`. */
export function clampTextId(key: string) {
  return `clamp-${key.replace(/[^\w-]/g, "_")}`
}

/**
 * On the text box: measures it against its limit as it resizes, and turns
 * presses (on Show more, and on the bubble while folded) into Messages that
 * know the height the move starts from.
 */
const ClampMeasure = Mount.defineStream("ClampMeasure", {
  args: { key: Schema.String, lines: Schema.Number, scope: ClampScope },
  messages: [Message.MeasuredClamp, Message.PressedClampControl, Message.PressedFoldSurface],
  execute: ({ element, key, lines, scope }) =>
    domStream<Message>((emit) => {
      const clip = element as HTMLElement
      const content = clip.firstElementChild as HTMLElement | null
      const cleanups: Array<() => void> = []
      if (content && typeof ResizeObserver !== "undefined") {
        const measure = () => {
          // The text's own height against the limit in lines of its own type.
          const lineHeight = Number.parseFloat(getComputedStyle(clip).lineHeight)
          const limit = Number.isFinite(lineHeight) ? lineHeight * lines : clip.clientHeight
          emit(Message.MeasuredClamp({ key, overflows: content.offsetHeight > limit + 1 }))
        }
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(content)
        cleanups.push(() => observer.disconnect())
      }

      // Show more sits beside the text, in the same parent.
      const parent = clip.parentElement
      if (parent) {
        const onControlClick = (event: MouseEvent) => {
          const control = event.target instanceof Element ? event.target.closest<HTMLElement>(`button[aria-controls="${CSS.escape(clip.id)}"]`) : null
          if (!control) return
          const expanding = control.getAttribute("aria-expanded") !== "true"
          if (expanding) releaseFollow(control)
          // `detail` counts clicks, and a click made by Enter or Space has none.
          emit(Message.PressedClampControl({ key, id: clip.id, from: clip.getBoundingClientRect().height, byKeyboard: event.detail === 0, lines, scope }))
        }
        parent.addEventListener("click", onControlClick)
        cleanups.push(() => parent.removeEventListener("click", onControlClick))
      }

      // While folded, a click anywhere on the bubble opens it. The update
      // ignores the press when the text is open or fits.
      const surface = clip.closest<HTMLElement>(`[${FOLD_SURFACE_ATTRIBUTE}]`) ?? clip
      let press: { x: number; y: number; selecting: boolean } | null = null
      // Before the browser's own mousedown, which is what clears a selection.
      const onPointerDown = (event: PointerEvent) => {
        press = { x: event.clientX, y: event.clientY, selecting: hasSelectedText() }
      }
      const onClick = (event: MouseEvent) => {
        const began = press
        press = null
        if (surface.style.cursor !== "pointer") return
        const own = event.target instanceof Element ? event.target.closest(OWN_CLICK_SELECTOR) : null
        const open = isFoldClick({
          button: event.button,
          clicks: event.detail,
          modified: event.ctrlKey || event.metaKey || event.shiftKey || event.altKey,
          movedPx: began ? Math.hypot(event.clientX - began.x, event.clientY - began.y) : 0,
          selecting: Boolean(began?.selecting) || hasSelectedText(),
          onOwnClick: own !== null && surface.contains(own),
          handled: event.defaultPrevented,
        })
        if (!open) return
        releaseFollow(surface)
        emit(Message.PressedFoldSurface({ key, id: clip.id, from: clip.getBoundingClientRect().height, lines, scope }))
      }
      surface.addEventListener("pointerdown", onPointerDown)
      surface.addEventListener("click", onClick)
      cleanups.push(() => {
        surface.removeEventListener("pointerdown", onPointerDown)
        surface.removeEventListener("click", onClick)
      })
      return () => cleanups.forEach((cleanup) => cleanup())
    }),
})

/** Whether the text at `key` is folded with more to show: its surface takes a click and shows a pointer. */
export function isFoldedOpen(key: string, context: RowContext) {
  return Boolean(context.model.overflows[key]) && !context.model.open[key]
}

/**
 * The attributes of the element a folded message opens from (its bubble):
 * the marker, and the pointer's cursor while folded (React set
 * `surface.style.cursor`).
 */
export function foldSurfaceAttributes(key: string, context: RowContext, h: HtmlBuilder<Message>): ReadonlyArray<Attribute<Message>> {
  return [
    h.Attribute(FOLD_SURFACE_ATTRIBUTE, ""),
    ...(isFoldedOpen(key, context) ? [h.Style({ cursor: "pointer" })] : []),
  ]
}

/**
 * The text and, when it runs past `lines`, its Show more / Show less. A
 * fragment: put the children in the bubble.
 */
export function clampedMessageText(text: string, key: string, lines: number, scope: ClampScope, context: RowContext, h: HtmlBuilder<Message>): ReadonlyArray<Html> {
  const expanded = Boolean(context.model.open[key])
  const overflows = Boolean(context.model.overflows[key])
  const clamped = !expanded
  const textId = clampTextId(key)
  return [
    h.div([
      h.Id(textId),
      h.Class(cn(
        clamped && "overflow-hidden",
        clamped && overflows && "[mask-image:linear-gradient(to_bottom,black_calc(100%_-_1lh),transparent)]",
      )),
      // In lines of the text's own type. A style, not a class: the number
      // is the caller's, and a class has to be spelled out to exist.
      ...(clamped ? [h.Style({ "max-height": `${lines}lh` })] : []),
      h.OnMount(ClampMeasure({ key, lines, scope })),
    ], [
      h.div([h.Class(TEXT_CLASS)], transcriptMarkdownChildren(text, key, context, h)),
    ]),
    overflows
      ? h.button([
        h.Type("button"),
        h.AriaExpanded(expanded),
        h.AriaControls(textId),
        // 28px tall and flush under the text: the room is inside the button.
        h.Class(cn(
          "not-prose relative -ml-1.5 flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none select-none",
          "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          "pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-2 pointer-coarse:before:content-['']",
          "transition-[color,scale] duration-150 ease-snappy active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100",
        )),
      ], [
        expanded ? "Show less" : "Show more",
        ChevronDown({ class: cn("size-3.5 transition-transform duration-200 ease-snappy motion-reduce:transition-none", expanded && "rotate-180") }, h),
      ])
      : null,
  ]
}
