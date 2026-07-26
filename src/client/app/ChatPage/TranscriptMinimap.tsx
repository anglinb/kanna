import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { formatDuration, formatPromptTimestamp } from "../../components/messages/ResultMessage"
import { cn } from "../../lib/utils"
import {
  getMagnifyFalloff,
  getMinimapCapacity,
  getTranscriptGutterWidth,
  isTurnInView,
  selectVisibleTurns,
  type TranscriptTurn,
} from "./transcriptTurns"

/** Transcript column geometry the strip has to stay clear of. */
const TRANSCRIPT_COLUMN_MAX_WIDTH_PX = 800
const TRANSCRIPT_COLUMN_PADDING_PX = 24

/** Narrowest gutter that still fits a fully magnified tick without crowding the column. */
const MIN_GUTTER_PX = 88

/** Inset from the left edge of the chat pane. */
const STRIP_LEFT_PX = 15

/**
 * Tick geometry is proportioned off the resting width by the golden ratio:
 * spacing is the minor part, the magnified width the major. Keeping both
 * derived means retuning the strip is a single number.
 */
const GOLDEN_MAJOR = 1.618
const GOLDEN_MINOR = 0.618
const TICK_BASE_WIDTH_PX = 13
const TICK_PITCH_PX = TICK_BASE_WIDTH_PX * GOLDEN_MINOR
const TICK_MAX_WIDTH_PX = TICK_BASE_WIDTH_PX * GOLDEN_MAJOR
const TICK_BASE_HEIGHT_PX = 2
const TICK_MAX_HEIGHT_PX = 3

/**
 * Tick opacity is a resting value plus one exception.
 *
 * At rest the strip is near-invisible, brighter for the turns on screen. Once
 * the cursor picks out a tick, that one goes fully opaque — the same one the
 * hover card describes — and every other tick drops to the floor, including
 * the ones on screen: while you are pointing at something, where you are
 * reading is no longer the question being asked.
 *
 * Opacity is deliberately a step rather than a gradient like size is. Two
 * competing highlights would make it ambiguous which tick the card belongs to.
 */
const TICK_OPACITY_OFF_SCREEN = 0.15
/** On-screen ticks read this many times brighter than off-screen ones. */
const TICK_ON_SCREEN_CONTRAST = 5
const TICK_OPACITY_ON_SCREEN = TICK_OPACITY_OFF_SCREEN * TICK_ON_SCREEN_CONTRAST
const TICK_OPACITY_FOCUSED = 1
/**
 * How many neighbours either side of the cursor swell. The radius is derived
 * from the pitch so the effect keeps its shape whatever the spacing, and capped
 * by the tick count so a short strip does not get a radius reaching past both
 * of its ends — which would magnify every tick at once and read as a wobble
 * rather than a dock.
 */
const MAGNIFY_NEIGHBOURS = 4
/** Upper bound on ticks regardless of window height — beyond this it reads as noise. */
const MAX_TICKS = 40

/** Pointer target width, generous so the hairline ticks are easy to hit. */
const HIT_WIDTH_PX = 72
/** Vertical slop so hovering just past the end tick still magnifies it. */
const HIT_PADDING_Y_PX = 20

const CARD_WIDTH_PX = 320
const CARD_GAP_PX = 16
/**
 * Roughly how tall the card gets, used only to keep it inside the pane.
 *
 * Not a cap on the card itself: its height is already bounded by the line
 * clamps (2 lines of prompt, 3 of body, one meta row), and capping it as well
 * only risks shearing off the bottom padding when the content runs long.
 */
const CARD_ESTIMATED_HEIGHT_PX = 152

interface TranscriptMinimapProps {
  turns: TranscriptTurn[]
  /** LegendList's rendered row range, used to decide which ticks read as "here". */
  visibleStart: number
  visibleEnd: number
  /** Whether the transcript can scroll at all — a map of one screen is noise. */
  transcriptOverflows: boolean
  /** Top of the transcript area (below the floating navbar). */
  topPx: number
  /** Bottom of the transcript area (above the floating input dock). */
  bottomPx: number
  /** Width of the scroll pane, used to decide whether there is room at all. */
  containerWidthPx: number
  onSelectTurn: (turn: TranscriptTurn) => void
}

/**
 * A vertical strip of ticks — one per turn — sitting in the dead gutter left of
 * the transcript column. Ticks for turns currently on screen read bright, the
 * rest stay faint; hovering magnifies neighbours dock-style and surfaces the
 * question with the answer it landed on.
 *
 * Hidden whenever the gutter is too narrow to hold it, and on coarse pointers,
 * where a hover-driven affordance has nothing to offer.
 */
export const TranscriptMinimap = memo(function TranscriptMinimap({
  turns,
  visibleStart,
  visibleEnd,
  transcriptOverflows,
  topPx,
  bottomPx,
  containerWidthPx,
  onSelectTurn,
}: TranscriptMinimapProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const [wrapperHeight, setWrapperHeight] = useState(0)
  const [pointerY, setPointerY] = useState<number | null>(null)
  const hasFinePointer = useHasFinePointer()

  useLayoutEffect(() => {
    const element = wrapperRef.current
    if (!element) return

    const updateHeight = () => {
      const next = element.clientHeight
      setWrapperHeight((current) => (Math.abs(current - next) < 1 ? current : next))
    }

    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    updateHeight()
    return () => observer.disconnect()
  }, [])

  const gutterWidth = getTranscriptGutterWidth(
    containerWidthPx,
    TRANSCRIPT_COLUMN_MAX_WIDTH_PX,
    TRANSCRIPT_COLUMN_PADDING_PX,
  )
  const hasRoom = gutterWidth >= MIN_GUTTER_PX

  const capacity = getMinimapCapacity(
    wrapperHeight - HIT_PADDING_Y_PX * 2,
    TICK_PITCH_PX,
    MAX_TICKS,
  )
  const ticks = useMemo(() => selectVisibleTurns(turns, capacity), [capacity, turns])
  const magnifyRadiusPx = TICK_PITCH_PX * Math.min(MAGNIFY_NEIGHBOURS, ticks.length)

  // Pointer samples land far faster than paint; coalesce to one per frame.
  const pointerFrameRef = useRef<number | null>(null)
  const cancelPointerFrame = useCallback(() => {
    if (pointerFrameRef.current !== null) {
      window.cancelAnimationFrame(pointerFrameRef.current)
      pointerFrameRef.current = null
    }
  }, [])
  useEffect(() => cancelPointerFrame, [cancelPointerFrame])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const offsetY = event.clientY - bounds.top
    cancelPointerFrame()
    pointerFrameRef.current = window.requestAnimationFrame(() => {
      pointerFrameRef.current = null
      setPointerY(offsetY)
    })
  }, [cancelPointerFrame])

  const handlePointerLeave = useCallback(() => {
    cancelPointerFrame()
    setPointerY(null)
  }, [cancelPointerFrame])

  // Reset on anything that can move ticks out from under a resting cursor.
  useEffect(() => {
    setPointerY(null)
  }, [capacity, hasRoom, transcriptOverflows])

  /**
   * Whether the strip earns its place. A single tick maps nothing — there is
   * nowhere else to jump to — so it would be pure decoration.
   *
   * Note this only gates the strip's *contents*: the wrapper below always
   * renders, because it is what the ResizeObserver measures, and remounting it
   * whenever a resize crosses the threshold would cost a frame of stale height
   * every time the strip reappears.
   */
  const isVisible = hasFinePointer && hasRoom && transcriptOverflows && ticks.length > 1

  const stripHeight = ticks.length * TICK_PITCH_PX
  const stripTop = Math.max(0, (wrapperHeight - stripHeight) / 2)
  const hitTop = stripTop - HIT_PADDING_Y_PX

  const tickCenterY = (index: number) => HIT_PADDING_Y_PX + index * TICK_PITCH_PX + TICK_PITCH_PX / 2

  let focusedIndex = -1
  let focusedDistance = Number.POSITIVE_INFINITY
  if (isVisible && pointerY !== null) {
    ticks.forEach((_, index) => {
      const distance = Math.abs(pointerY - tickCenterY(index))
      if (distance < focusedDistance) {
        focusedDistance = distance
        focusedIndex = index
      }
    })
    if (focusedDistance > magnifyRadiusPx) focusedIndex = -1
  }

  const focusedTurn = focusedIndex >= 0 ? ticks[focusedIndex] : null
  const focusedMeta = focusedTurn
    ? [
        focusedTurn.timestamp ? formatPromptTimestamp(focusedTurn.timestamp) : null,
        focusedTurn.durationMs === null ? null : formatDuration(focusedTurn.durationMs),
      ].filter(Boolean).join(" · ")
    : ""
  const cardCenterY = focusedIndex >= 0
    ? clamp(
        hitTop + tickCenterY(focusedIndex),
        CARD_ESTIMATED_HEIGHT_PX / 2,
        Math.max(CARD_ESTIMATED_HEIGHT_PX / 2, wrapperHeight - CARD_ESTIMATED_HEIGHT_PX / 2),
      )
    : 0

  return (
    <div
      ref={wrapperRef}
      className="pointer-events-none absolute left-0 z-10"
      style={{ top: topPx, bottom: bottomPx, width: HIT_WIDTH_PX + CARD_GAP_PX + CARD_WIDTH_PX }}
    >
      {!isVisible ? null : (
      <div
        className="pointer-events-auto absolute left-0"
        style={{ top: hitTop, height: stripHeight + HIT_PADDING_Y_PX * 2, width: HIT_WIDTH_PX }}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      >
        {ticks.map((turn, index) => {
          const centerY = tickCenterY(index)
          const falloff = pointerY === null ? 0 : getMagnifyFalloff(pointerY - centerY, magnifyRadiusPx)
          // The in-view highlight only applies while nothing is focused: once
          // a tick is picked out, every other tick sits at the floor.
          const inView = focusedIndex < 0 && isTurnInView(turn, visibleStart, visibleEnd)
          const opacity = index === focusedIndex
            ? TICK_OPACITY_FOCUSED
            : inView ? TICK_OPACITY_ON_SCREEN : TICK_OPACITY_OFF_SCREEN

          return (
            // The bar is a hairline, so the button is a full-pitch invisible
            // row and the bar is painted inside it — otherwise the target
            // would be 2px tall and effectively unclickable.
            <button
              key={turn.id}
              type="button"
              onClick={() => onSelectTurn(turn)}
              aria-label={`Jump to: ${turn.prompt.slice(0, 80)}`}
              className="absolute left-0 flex cursor-pointer items-center bg-transparent p-0"
              style={{
                top: centerY,
                transform: "translateY(-50%)",
                width: HIT_WIDTH_PX,
                height: TICK_PITCH_PX,
              }}
            >
              <span
                className={cn(
                  // Deliberately uniform: a tick's only job is to show where a
                  // turn sits and whether it is on screen. Tinting failures
                  // would make the strip a status display and compete with the
                  // in-view contrast that carries the actual meaning.
                  "absolute rounded-full bg-foreground",
                  // Opacity always eases, including mid-hover: it now steps
                  // between two fixed values rather than following a gradient,
                  // and an untweened step reads as a flicker as the focus
                  // moves. Size still snaps — tweening it lags the pointer and
                  // the dock feels rubbery.
                  "transition-opacity duration-150 ease-out",
                  pointerY === null && "transition-[width,height,opacity] duration-200 ease-out",
                )}
                style={{
                  left: STRIP_LEFT_PX,
                  width: TICK_BASE_WIDTH_PX + (TICK_MAX_WIDTH_PX - TICK_BASE_WIDTH_PX) * falloff,
                  height: TICK_BASE_HEIGHT_PX + (TICK_MAX_HEIGHT_PX - TICK_BASE_HEIGHT_PX) * falloff,
                  opacity,
                }}
              />
            </button>
          )
        })}
      </div>
      )}

      {focusedTurn ? (
        <div
          aria-hidden
          className="pointer-events-none absolute animate-fade-in rounded-lg border border-border bg-popover/95 px-3 py-2 shadow-xl backdrop-blur-sm transition-[top] duration-150 ease-out"
          style={{
            left: STRIP_LEFT_PX + TICK_MAX_WIDTH_PX + CARD_GAP_PX,
            top: cardCenterY,
            width: CARD_WIDTH_PX,
            transform: "translateY(-50%)",
          }}
        >
          <div className="line-clamp-2 text-sm font-medium text-popover-foreground">
            {focusedTurn.prompt || "Empty message"}
          </div>
          {focusedTurn.error ? (
            <div className="mt-1 line-clamp-3 text-sm text-destructive">
              {focusedTurn.error}
            </div>
          ) : focusedTurn.response ? (
            <div className="mt-1 line-clamp-3 text-sm text-muted-foreground">
              {focusedTurn.response}
            </div>
          ) : null}
          {/* Same treatment as the turn-boundary dividers in the transcript,
              so the two readings of the same facts look like one thing. */}
          {focusedMeta ? (
            <div className="mt-1.5 text-[12px] tracking-wide text-muted-foreground/60">
              {focusedMeta}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Whether the device has a hover-capable, precise pointer. The strip is driven
 * entirely by hover, so on touch it is dead weight over the transcript.
 */
function useHasFinePointer() {
  const [hasFinePointer, setHasFinePointer] = useState(false)

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return
    const query = window.matchMedia("(hover: hover) and (pointer: fine)")
    const update = () => setHasFinePointer(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  return hasFinePointer
}
