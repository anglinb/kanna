/**
 * Marking up a visualization's capture before it goes into a prompt. Marks
 * are kept in the image's own pixels, so one drawn on a capture shown at a
 * third of its size lands in the same place when it is flattened at full size.
 */

export interface MarkupPoint { x: number; y: number }

export type MarkupTool = "pen" | "arrow" | "box" | "text"

export type Mark =
  | { kind: "pen"; color: string; width: number; points: MarkupPoint[] }
  | { kind: "arrow"; color: string; width: number; from: MarkupPoint; to: MarkupPoint }
  | { kind: "box"; color: string; width: number; from: MarkupPoint; to: MarkupPoint }
  | { kind: "text"; color: string; size: number; at: MarkupPoint; text: string }

/** Read on any chart, in either theme. */
export const MARKUP_COLORS = [
  { name: "Red", value: "#ef4444" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Green", value: "#22c55e" },
] as const

/** On screen, in CSS pixels, whatever the capture is scaled to. */
export const MARKUP_STROKE = 3
export const MARKUP_TEXT_SIZE = 18

/** A point on the shown image, in the image's pixels, held to its edges. */
export function imagePoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number,
): MarkupPoint {
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value))
  return {
    x: clamp(((clientX - rect.left) / (rect.width || 1)) * imageWidth, imageWidth),
    y: clamp(((clientY - rect.top) / (rect.height || 1)) * imageHeight, imageHeight),
  }
}

/** The two back corners of an arrow's head, or null for an arrow with no length. */
export function arrowHead(from: MarkupPoint, to: MarkupPoint, size: number): [MarkupPoint, MarkupPoint] | null {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (length === 0) return null
  // Never longer than the arrow, so a short one is still an arrow.
  const head = Math.min(size, length)
  const angle = Math.atan2(dy, dx)
  const spread = Math.PI / 7
  return [
    { x: to.x - head * Math.cos(angle - spread), y: to.y - head * Math.sin(angle - spread) },
    { x: to.x - head * Math.cos(angle + spread), y: to.y - head * Math.sin(angle + spread) },
  ]
}

/**
 * Whether a finished mark is worth keeping. A click with the arrow or box
 * tool, or a stray tap, draws nothing; a pen tap is a dot, and is kept.
 */
export function isMeaningfulMark(mark: Mark): boolean {
  if (mark.kind === "pen") return mark.points.length > 0
  if (mark.kind === "text") return mark.text.trim().length > 0
  const span = Math.hypot(mark.to.x - mark.from.x, mark.to.y - mark.from.y)
  return span >= mark.width * 2
}

export interface MarkupState {
  marks: Mark[]
  /** What `marks` was before each change, for undo. Clear is a change too. */
  past: Mark[][]
}

export const EMPTY_MARKUP: MarkupState = { marks: [], past: [] }

export type MarkupAction = { type: "add"; mark: Mark } | { type: "undo" } | { type: "clear" }

export function markupReducer(state: MarkupState, action: MarkupAction): MarkupState {
  switch (action.type) {
    case "add":
      return isMeaningfulMark(action.mark) ? { marks: [...state.marks, action.mark], past: [...state.past, state.marks] } : state
    case "undo":
      return state.past.length === 0 ? state : { marks: state.past[state.past.length - 1]!, past: state.past.slice(0, -1) }
    case "clear":
      return state.marks.length === 0 ? state : { marks: [], past: [...state.past, state.marks] }
  }
}

/** What `drawMarks` uses of a 2D context, so the tests can record it. */
export type MarkupContext = Pick<
  CanvasRenderingContext2D,
  "save" | "restore" | "beginPath" | "moveTo" | "lineTo" | "closePath" | "arc" | "stroke" | "fill" | "strokeRect" | "fillText" | "strokeText"
  | "strokeStyle" | "fillStyle" | "lineWidth" | "lineCap" | "lineJoin" | "font" | "textBaseline"
>

export function markupFont(size: number) {
  return `600 ${size}px ui-sans-serif, system-ui, -apple-system, sans-serif`
}

/** Draws marks in the context's current transform, which maps image pixels to the canvas. */
export function drawMarks(context: MarkupContext, marks: readonly Mark[]) {
  for (const mark of marks) {
    context.save()
    context.lineCap = "round"
    context.lineJoin = "round"
    if (mark.kind === "pen") {
      context.strokeStyle = mark.color
      context.fillStyle = mark.color
      context.lineWidth = mark.width
      const [first, ...rest] = mark.points
      if (first && rest.length === 0) {
        context.beginPath()
        context.arc(first.x, first.y, mark.width / 2, 0, Math.PI * 2)
        context.fill()
      } else if (first) {
        context.beginPath()
        context.moveTo(first.x, first.y)
        for (const point of rest) context.lineTo(point.x, point.y)
        context.stroke()
      }
    } else if (mark.kind === "box") {
      context.strokeStyle = mark.color
      context.lineWidth = mark.width
      context.strokeRect(
        Math.min(mark.from.x, mark.to.x),
        Math.min(mark.from.y, mark.to.y),
        Math.abs(mark.to.x - mark.from.x),
        Math.abs(mark.to.y - mark.from.y),
      )
    } else if (mark.kind === "arrow") {
      context.strokeStyle = mark.color
      context.fillStyle = mark.color
      context.lineWidth = mark.width
      context.beginPath()
      context.moveTo(mark.from.x, mark.from.y)
      context.lineTo(mark.to.x, mark.to.y)
      context.stroke()
      const head = arrowHead(mark.from, mark.to, mark.width * 5)
      if (head) {
        context.beginPath()
        context.moveTo(mark.to.x, mark.to.y)
        context.lineTo(head[0].x, head[0].y)
        context.lineTo(head[1].x, head[1].y)
        context.closePath()
        context.fill()
      }
    } else {
      // A light halo, so a label reads over the lines and fills under it.
      context.font = markupFont(mark.size)
      context.textBaseline = "top"
      context.lineWidth = mark.size / 4
      context.strokeStyle = "rgba(255, 255, 255, 0.85)"
      context.strokeText(mark.text, mark.at.x, mark.at.y)
      context.fillStyle = mark.color
      context.fillText(mark.text, mark.at.x, mark.at.y)
    }
    context.restore()
  }
}

/**
 * The size the capture is shown at: all of it in the stage, and no larger
 * than half its pixels, about the size it was on screen (captures are 2x or more).
 */
export function fitMarkupStage(imageWidth: number, imageHeight: number, stageWidth: number, stageHeight: number) {
  if (imageWidth <= 0 || imageHeight <= 0 || stageWidth <= 0 || stageHeight <= 0) return { width: 0, height: 0, scale: 0 }
  const scale = Math.min(stageWidth / imageWidth, stageHeight / imageHeight, 0.5)
  return { width: Math.round(imageWidth * scale), height: Math.round(imageHeight * scale), scale }
}
