import { Option } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
  getMagnifyFalloff,
  getMinimapCapacity,
  getTranscriptGutterWidth,
  isTurnInView,
  selectVisibleTurns,
  type TranscriptTurn,
} from "../../client/app/ChatPage/transcriptTurns"
import { toMessagePreview } from "../../shared/message-preview"
import { turnCardMessage, turnCardTimingRow } from "../ui/turn-card"
import { domStream } from "../ui/overlay/stream"
import { formatDuration, formatPromptTimestamp } from "./messages"
import { Message } from "./message"

// TranscriptMinimap (src/client/app/ChatPage/TranscriptMinimap.tsx): a
// vertical strip of ticks, one per turn, in the gutter left of the
// transcript column. Ticks for turns on screen read bright, the rest faint;
// hovering magnifies neighbours dock-style and surfaces the question with
// the answer it landed on. The geometry is React's, constant for constant.

/** Transcript column geometry the strip lives beside. */
const TRANSCRIPT_COLUMN_MAX_WIDTH_PX = 800
const TRANSCRIPT_COLUMN_PADDING_PX = 24

/** Narrowest pane, padding included, the strip earns its place beside. */
const MIN_TRANSCRIPT_WIDTH_PX = 855
const MIN_GUTTER_PX = (MIN_TRANSCRIPT_WIDTH_PX - TRANSCRIPT_COLUMN_MAX_WIDTH_PX) / 2

/** Inset from the left edge of the chat pane. */
const STRIP_INSET_PX = 15

const GOLDEN_MINOR = 0.618
const MAGNIFY_SCALE = 2
const TICK_SCALE_BASIS_PX = 13
/** Width of every tick outside the swell, hovered or not. */
const TICK_RESTING_WIDTH_PX = 10
/** The basis's golden minor, tightened a pixel by eye. */
const TICK_PITCH_PX = TICK_SCALE_BASIS_PX * GOLDEN_MINOR - 1
const TICK_MAX_WIDTH_PX = TICK_SCALE_BASIS_PX * MAGNIFY_SCALE

/** Quick while the cursor is on the strip, slower settling back once it leaves. */
const SIZE_ENTER_DURATION_MS = 100
const SIZE_EXIT_DURATION_MS = 200
const OPACITY_DURATION_MS = 150
const TICK_BASE_HEIGHT_PX = 2
const TICK_MAX_HEIGHT_PX = 3

/** At rest near-invisible, brighter for the turns on screen; the picked-out tick fully opaque. */
const TICK_OPACITY_OFF_SCREEN = 0.15
const TICK_OPACITY_ON_SCREEN = 0.8
const TICK_OPACITY_FOCUSED = 1
const MAGNIFY_NEIGHBOURS = 4
/** Upper bound on ticks regardless of window height. */
const MAX_TICKS = 40

/** Pointer target width, generous so the hairline ticks are easy to hit. */
const HIT_WIDTH_PX = 72
/** Vertical slop so hovering just past the end tick still magnifies it. */
const HIT_PADDING_Y_PX = 20

const CARD_WIDTH_PX = 320
const CARD_GAP_PX = 16
/** Roughly how tall the card gets, used only to keep it inside the pane. */
const CARD_ESTIMATED_HEIGHT_PX = 252

const CARD_ATTRIBUTE = "data-transcript-minimap-card"
const FOCUSED_ATTRIBUTE = "data-focused-turn"

type H = HtmlBuilder<Message>

export interface MinimapState {
  height: number
  pointerY: number | null
  heldTurnId: string | null
  finePointer: boolean
}

export interface MinimapInputs {
  turns: ReadonlyArray<TranscriptTurn>
  visibleStart: number
  visibleEnd: number
  transcriptOverflows: boolean
  topPx: number
  bottomPx: number
  containerWidthPx: number
}

/** What the reset effect watched: a change in any of them drops the cursor and the hold. */
export function minimapResetKey(height: number, containerWidthPx: number, overflows: boolean) {
  const capacity = getMinimapCapacity(height - HIT_PADDING_Y_PX * 2, TICK_PITCH_PX, MAX_TICKS)
  const hasRoom = getTranscriptGutterWidth(containerWidthPx, TRANSCRIPT_COLUMN_MAX_WIDTH_PX, TRANSCRIPT_COLUMN_PADDING_PX) >= MIN_GUTTER_PX
  return `${capacity}:${hasRoom}:${overflows}`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/** "1 message" / "12 messages": the agent's own text and tool calls. */
function formatAgentMessageCount(count: number) {
  return `${count} message${count === 1 ? "" : "s"}`
}

const tickCenterY = (index: number) => HIT_PADDING_Y_PX + index * TICK_PITCH_PX + TICK_PITCH_PX / 2

const px = (value: number) => `${value}px`

/**
 * The wrapper: always drawn, because it is what is measured, and remounting
 * it as the strip comes and goes would cost a frame of stale height.
 */
export function minimapView(state: MinimapState, inputs: MinimapInputs, h: H): Html {
  const gutterWidth = getTranscriptGutterWidth(inputs.containerWidthPx, TRANSCRIPT_COLUMN_MAX_WIDTH_PX, TRANSCRIPT_COLUMN_PADDING_PX)
  const hasRoom = gutterWidth >= MIN_GUTTER_PX
  const capacity = getMinimapCapacity(state.height - HIT_PADDING_Y_PX * 2, TICK_PITCH_PX, MAX_TICKS)
  const ticks = selectVisibleTurns([...inputs.turns], capacity)
  const magnifyRadiusPx = TICK_PITCH_PX * Math.min(MAGNIFY_NEIGHBOURS, ticks.length)
  // Whether the strip earns its place: scrollable content, room, a fine pointer.
  const isVisible = state.finePointer && hasRoom && inputs.transcriptOverflows && ticks.length > 0

  const stripHeight = ticks.length * TICK_PITCH_PX
  const stripTop = Math.max(0, (state.height - stripHeight) / 2)
  const hitTop = stripTop - HIT_PADDING_Y_PX

  let focusedIndex = -1
  let focusedDistance = Number.POSITIVE_INFINITY
  if (isVisible && state.pointerY !== null) {
    ticks.forEach((_, index) => {
      const distance = Math.abs(state.pointerY! - tickCenterY(index))
      if (distance < focusedDistance) {
        focusedDistance = distance
        focusedIndex = index
      }
    })
    if (focusedDistance > magnifyRadiusPx) focusedIndex = -1
  }
  const sizeDurationMs = focusedIndex >= 0 ? SIZE_ENTER_DURATION_MS : SIZE_EXIT_DURATION_MS
  const focusedTurn = focusedIndex >= 0 ? ticks[focusedIndex] ?? null : null

  // The tick the card belongs to: chosen by the cursor on the strip, then held while it is on the card.
  const heldIndex = isVisible && state.heldTurnId ? ticks.findIndex((tick) => tick.id === state.heldTurnId) : -1
  const activeIndex = focusedIndex >= 0 ? focusedIndex : heldIndex
  const activeTurn = activeIndex >= 0 ? ticks[activeIndex] ?? null : null

  const cardDuration = activeTurn && activeTurn.durationMs !== null ? formatDuration(activeTurn.durationMs) : null
  const cardTimestamp = activeTurn?.timestamp ? formatPromptTimestamp(activeTurn.timestamp) : null
  const cardCenterY = activeIndex >= 0
    ? clamp(hitTop + tickCenterY(activeIndex), CARD_ESTIMATED_HEIGHT_PX / 2, Math.max(CARD_ESTIMATED_HEIGHT_PX / 2, state.height - CARD_ESTIMATED_HEIGHT_PX / 2))
    : 0

  const select = (turn: TranscriptTurn, role: "prompt" | "reply") => Message.SelectedTurn({
    turnId: turn.id,
    rowId: turn.loaded === false ? null : (role === "reply" ? turn.replyRowId : null) ?? turn.id,
    loaded: turn.loaded !== false,
  })

  const strip = !isVisible ? null : h.div([
    h.Class("pointer-events-auto absolute left-0"),
    h.Style({ top: px(hitTop), height: px(stripHeight + HIT_PADDING_Y_PX * 2), width: px(HIT_WIDTH_PX) }),
    h.Attribute(FOCUSED_ATTRIBUTE, focusedTurn?.id ?? ""),
    h.OnMount(TrackMinimapPointer()),
  ], ticks.map((turn, index) => {
    const centerY = tickCenterY(index)
    const falloff = state.pointerY === null ? 0 : getMagnifyFalloff(state.pointerY - centerY, magnifyRadiusPx)
    const isGrowing = falloff > 0
    // The in-view highlight only applies while nothing is focused.
    const inView = activeIndex < 0 && isTurnInView(turn, inputs.visibleStart, inputs.visibleEnd)
    const opacity = index === activeIndex ? TICK_OPACITY_FOCUSED : inView ? TICK_OPACITY_ON_SCREEN : TICK_OPACITY_OFF_SCREEN
    // The bar is a hairline, so the button is a full-pitch invisible row.
    return h.keyed("button")(turn.id, [
      h.Type("button"),
      h.OnClick(select(turn, "prompt")),
      h.AriaLabel(`Jump to: ${toMessagePreview(turn.prompt).slice(0, 80)}`),
      h.Class("absolute left-0 flex cursor-pointer items-center bg-transparent p-0"),
      h.Style({ top: px(centerY), transform: "translateY(-50%)", width: px(HIT_WIDTH_PX), height: px(TICK_PITCH_PX) }),
    ], [
      h.span([
        h.Class("absolute rounded-full bg-foreground"),
        h.Style({
          left: px(STRIP_INSET_PX),
          width: px(TICK_RESTING_WIDTH_PX + (TICK_MAX_WIDTH_PX - TICK_RESTING_WIDTH_PX) * falloff),
          height: px(TICK_BASE_HEIGHT_PX + (TICK_MAX_HEIGHT_PX - TICK_BASE_HEIGHT_PX) * falloff),
          opacity: String(opacity),
          // A tick inside the swell tracks the cursor, so its size must not tween.
          transition: isGrowing
            ? `opacity ${OPACITY_DURATION_MS}ms ease-out`
            : `width ${sizeDurationMs}ms ease-out, height ${sizeDurationMs}ms ease-out, opacity ${OPACITY_DURATION_MS}ms ease-out`,
        }),
      ], []),
    ])
  }))

  const card = !activeTurn ? null : h.div([
    h.Attribute(CARD_ATTRIBUTE, ""),
    h.OnPointerLeave(() => Option.some(Message.LeftMinimapCard())),
    h.Class("pointer-events-auto absolute animate-fade-in rounded-lg border border-border bg-popover/95 px-1.5 py-2 shadow-xl backdrop-blur-sm transition-[top] duration-150 ease-out"),
    h.Style({ left: px(STRIP_INSET_PX + TICK_MAX_WIDTH_PX + CARD_GAP_PX), top: px(cardCenterY), width: px(CARD_WIDTH_PX), transform: "translateY(-50%)" }),
  ], [
    h.div([h.Class("space-y-1")], [
      turnCardMessage({ class: "line-clamp-5 text-sm font-medium text-popover-foreground", label: "Jump to this prompt", onSelect: select(activeTurn, "prompt") }, [toMessagePreview(activeTurn.prompt) || "Empty message"], h),
      activeTurn.error
        ? turnCardMessage({ class: "line-clamp-5 text-sm text-destructive", label: "Jump to this failure", onSelect: select(activeTurn, "reply") }, [activeTurn.error], h)
        : activeTurn.response
          ? turnCardMessage({ class: "line-clamp-5 text-sm text-muted-foreground", label: "Jump to this reply", onSelect: select(activeTurn, "reply") }, [toMessagePreview(activeTurn.response)], h)
          : null,
    ]),
    turnCardTimingRow({
      detail: cardDuration,
      timestamp: cardTimestamp,
      leading: activeTurn.agentMessageCount > 0 ? [formatAgentMessageCount(activeTurn.agentMessageCount)] : null,
    }, h),
  ])

  return h.div([
    h.Class("pointer-events-none absolute left-0 z-10"),
    h.Style({ top: px(inputs.topPx), bottom: px(inputs.bottomPx), width: px(HIT_WIDTH_PX + CARD_GAP_PX + CARD_WIDTH_PX) }),
    h.OnMount(MeasureMinimap()),
  ], [strip, card])
}

/** The wrapper's height, and whether the device has a hover-capable, precise pointer. */
const MeasureMinimap = Mount.defineStream("MeasureTranscriptMinimap", {
  messages: [Message.MeasuredMinimap, Message.ChangedFinePointer],
  execute: ({ element }) => domStream<Extract<Message, { _tag: "MeasuredMinimap" | "ChangedFinePointer" }>>((emit) => {
    let height = -1
    const updateHeight = () => {
      const next = element.clientHeight
      if (Math.abs(height - next) < 1) return
      height = next
      emit(Message.MeasuredMinimap({ height: next }))
    }
    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    updateHeight()
    const query = window.matchMedia ? window.matchMedia("(hover: hover) and (pointer: fine)") : null
    const updatePointer = () => emit(Message.ChangedFinePointer({ fine: query?.matches ?? false }))
    updatePointer()
    query?.addEventListener("change", updatePointer)
    return () => {
      observer.disconnect()
      query?.removeEventListener("change", updatePointer)
    }
  }),
})

/**
 * The strip's pointer: one sample per frame, and on the way out whether the
 * cursor walked onto the card (the turn it describes is then held). A click
 * drops a sample still waiting, as handleSelect cancelled the frame.
 */
const TrackMinimapPointer = Mount.defineStream("TrackTranscriptMinimapPointer", {
  messages: [Message.MovedOverMinimap, Message.LeftMinimap],
  execute: ({ element: target }) => domStream<Extract<Message, { _tag: "MovedOverMinimap" | "LeftMinimap" }>>((emit) => {
    const element = target as HTMLElement
    let frame: number | null = null
    const cancel = () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = null
    }
    const onMove = (event: PointerEvent) => {
      const offsetY = event.clientY - element.getBoundingClientRect().top
      cancel()
      frame = window.requestAnimationFrame(() => {
        frame = null
        emit(Message.MovedOverMinimap({ y: offsetY }))
      })
    }
    const onLeave = (event: PointerEvent) => {
      cancel()
      const entered = event.relatedTarget
      const card = element.parentElement?.querySelector(`[${CARD_ATTRIBUTE}]`)
      const enteredCard = entered instanceof Node && (card?.contains(entered) ?? false)
      emit(Message.LeftMinimap({ heldTurnId: enteredCard ? element.getAttribute(FOCUSED_ATTRIBUTE) || null : null }))
    }
    element.addEventListener("pointermove", onMove)
    element.addEventListener("pointerleave", onLeave)
    element.addEventListener("click", cancel, { capture: true })
    return () => {
      cancel()
      element.removeEventListener("pointermove", onMove)
      element.removeEventListener("pointerleave", onLeave)
      element.removeEventListener("click", cancel, { capture: true })
    }
  }),
})
