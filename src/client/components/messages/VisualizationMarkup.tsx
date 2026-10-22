import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { MoveUpRight, Pencil, Square, Trash2, Type, Undo2 } from "lucide-react"
import { Button } from "../ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog"
import { SegmentedControl } from "../ui/segmented-control"
import { ViewerIconButton } from "../viewer/ViewerSurface"
import { cn } from "../../lib/utils"
import { canvasToBlob, loadImageBlob } from "../../lib/visualization-image"
import {
  drawMarks,
  EMPTY_MARKUP,
  fitMarkupStage,
  imagePoint,
  MARKUP_COLORS,
  MARKUP_STROKE,
  MARKUP_TEXT_SIZE,
  markupFont,
  markupReducer,
  type Mark,
  type MarkupPoint,
  type MarkupTool,
} from "../../lib/visualization-markup"
import { visualizationImageName } from "../../../shared/visualization-capture"

const TOOLS = [
  { value: "pen", label: "Pen", icon: Pencil },
  { value: "arrow", label: "Arrow", icon: MoveUpRight },
  { value: "box", label: "Box", icon: Square },
  { value: "text", label: "Text", icon: Type },
] satisfies { value: MarkupTool; label: string; icon: typeof Pencil }[]

interface TextDraft { id: number; at: MarkupPoint; color: string; size: number; value: string }

/**
 * Draw on a capture of a visualization, then hand it to the composer as a
 * PNG. The capture is shown whole in the stage and marked in its own pixels
 * (`lib/visualization-markup`); "Add to prompt" draws the marks onto it at
 * full size. Mouse, touch and pen all draw: the canvas alone takes
 * `touch-action: none`, so a finger on it draws rather than scrolls.
 */
export function VisualizationMarkup({ title, image, onCancel, onAttach }: {
  title: string
  /** The capture, drawing since the Mark up click. */
  image: Promise<Blob>
  onCancel: () => void
  /** False when nothing took the file: a page with no composer. */
  onAttach: (file: File) => boolean
}) {
  const [source, setSource] = useState<{ image: HTMLImageElement; width: number; height: number } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tool, setTool] = useState<MarkupTool>("pen")
  const [color, setColor] = useState<string>(MARKUP_COLORS[0].value)
  const [markup, dispatch] = useReducer(markupReducer, EMPTY_MARKUP)
  const [stage, setStage] = useState({ width: 0, height: 0 })
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null)
  const [attaching, setAttaching] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Read by the pointer handlers and the redraw, which run outside render.
  const marksRef = useRef<Mark[]>(markup.marks)
  marksRef.current = markup.marks
  const draftRef = useRef<Mark | null>(null)
  const pointerRef = useRef<number | null>(null)
  const textDraftRef = useRef<TextDraft | null>(null)
  textDraftRef.current = textDraft
  const nextTextId = useRef(0)

  useEffect(() => {
    let url: string | undefined
    let cancelled = false
    image.then(loadImageBlob).then((loaded) => {
      url = loaded.url
      if (cancelled) URL.revokeObjectURL(loaded.url)
      else setSource({ image: loaded.image, width: loaded.image.naturalWidth, height: loaded.image.naturalHeight })
    }, (error: unknown) => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : "The visualization could not be drawn.")
    })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [image])

  useLayoutEffect(() => {
    const element = stageRef.current
    if (!element) return
    const measure = () => setStage({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const fit = source ? fitMarkupStage(source.width, source.height, stage.width, stage.height) : { width: 0, height: 0, scale: 0 }

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context || !source || fit.scale === 0) return
    const ratio = window.devicePixelRatio || 1
    const width = Math.round(fit.width * ratio)
    const height = Math.round(fit.height * ratio)
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, width, height)
    context.setTransform(fit.scale * ratio, 0, 0, fit.scale * ratio, 0, 0)
    context.drawImage(source.image, 0, 0, source.width, source.height)
    drawMarks(context, draftRef.current ? [...marksRef.current, draftRef.current] : marksRef.current)
  }, [fit.height, fit.scale, fit.width, source])

  useEffect(() => redraw(), [redraw, markup.marks])

  const textMark = (draft: TextDraft): Mark => ({ kind: "text", color: draft.color, size: draft.size, at: draft.at, text: draft.value.trim() })

  /** A label being typed goes in when anything else happens. Safe to call twice. */
  const commitText = useCallback(() => {
    const draft = textDraftRef.current
    if (!draft) return
    textDraftRef.current = null
    setTextDraft(null)
    dispatch({ type: "add", mark: textMark(draft) })
  }, [])

  const cancelText = () => {
    textDraftRef.current = null
    setTextDraft(null)
  }

  const toImage = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current!
    return imagePoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), source!.width, source!.height)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!source || fit.scale === 0 || pointerRef.current !== null) return
    if (event.pointerType === "mouse" && event.button !== 0) return
    // No mouse events follow, so focus stays where it is: a label just
    // placed keeps its field, and one being typed is committed here instead.
    event.preventDefault()
    commitText()
    const at = toImage(event)
    if (tool === "text") {
      const draft = { id: ++nextTextId.current, at, color, size: MARKUP_TEXT_SIZE / fit.scale, value: "" }
      textDraftRef.current = draft
      setTextDraft(draft)
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerRef.current = event.pointerId
    const width = MARKUP_STROKE / fit.scale
    draftRef.current = tool === "pen" ? { kind: "pen", color, width, points: [at] } : { kind: tool, color, width, from: at, to: at }
    redraw()
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const draft = draftRef.current
    if (event.pointerId !== pointerRef.current || !draft) return
    if (draft.kind === "pen") {
      // Every sample since the last frame, so a fast stroke stays smooth.
      const samples = event.nativeEvent.getCoalescedEvents?.() ?? []
      for (const sample of samples.length > 0 ? samples : [event.nativeEvent]) draft.points.push(toImage(sample))
    } else if (draft.kind === "arrow" || draft.kind === "box") {
      draft.to = toImage(event)
    }
    redraw()
  }

  const finishStroke = (event: ReactPointerEvent<HTMLCanvasElement>, keep: boolean) => {
    if (event.pointerId !== pointerRef.current) return
    pointerRef.current = null
    const draft = draftRef.current
    draftRef.current = null
    if (draft && keep) dispatch({ type: "add", mark: draft })
    else redraw()
  }

  const undo = () => {
    if (textDraftRef.current) cancelText()
    else dispatch({ type: "undo" })
  }

  const clear = () => {
    cancelText()
    dispatch({ type: "clear" })
  }

  const attach = async () => {
    if (!source || attaching) return
    const pending = textDraftRef.current
    commitText()
    const marks = pending ? markupReducer(markup, { type: "add", mark: textMark(pending) }).marks : markup.marks
    setAttaching(true)
    setAttachError(null)
    try {
      const canvas = document.createElement("canvas")
      canvas.width = source.width
      canvas.height = source.height
      const context = canvas.getContext("2d")
      if (!context) throw new Error("The image could not be made.")
      context.drawImage(source.image, 0, 0)
      drawMarks(context, marks)
      const blob = await canvasToBlob(canvas, "image/png")
      if (!blob) throw new Error("The image could not be made.")
      const file = new File([blob], `${visualizationImageName(title)}-markup.png`, { type: "image/png" })
      if (!onAttach(file)) {
        setAttachError("There is no message box on this page to add it to.")
        setAttaching(false)
      }
    } catch (error) {
      setAttachError(error instanceof Error ? error.message : "The image could not be made.")
      setAttaching(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent
        size="lg"
        className="h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[1200px]"
        // Escape while typing a label drops the label, not the markup.
        onEscapeKeyDown={(event) => {
          if (!textDraftRef.current) return
          event.preventDefault()
          cancelText()
        }}
        onKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement) return
          if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z") {
            event.preventDefault()
            undo()
          }
        }}
      >
        {/* Right padding clears the dialog's close button. */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border p-3 pr-12">
          <DialogTitle className="text-base">Mark up</DialogTitle>
          <DialogDescription className="sr-only">Draw on the visualization, then add the image to your next message.</DialogDescription>
          <SegmentedControl size="sm" value={tool} onValueChange={setTool} options={TOOLS} />
          <div role="radiogroup" aria-label="Color" className="flex items-center gap-1.5">
            {MARKUP_COLORS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={color === option.value}
                aria-label={option.name}
                onClick={() => setColor(option.value)}
                className={cn(
                  "size-6 rounded-full border-2 border-transparent ring-offset-background transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  color === option.value && "ring-2 ring-foreground ring-offset-2",
                )}
                style={{ backgroundColor: option.value }}
              />
            ))}
          </div>
          <div className="flex items-center gap-1">
            <ViewerIconButton label="Undo" disabled={markup.past.length === 0 && !textDraft} onClick={undo}><Undo2 /></ViewerIconButton>
            <ViewerIconButton label="Clear" disabled={markup.marks.length === 0 && !textDraft} onClick={clear}><Trash2 /></ViewerIconButton>
          </div>
        </div>
        <div ref={stageRef} className="relative m-3 flex min-h-0 flex-1 items-center justify-center">
          {loadError ? (
            <p role="alert" className="text-sm text-muted-foreground">{loadError}</p>
          ) : !source ? (
            <p className="text-sm text-muted-foreground">Drawing the visualization…</p>
          ) : fit.scale > 0 ? (
            <div className="relative shadow-sm ring-1 ring-border" style={{ width: fit.width, height: fit.height }}>
              <canvas
                ref={canvasRef}
                aria-label={`Markup canvas for ${title}`}
                className={cn("block size-full", tool === "text" ? "cursor-text" : "cursor-crosshair")}
                style={{ touchAction: "none" }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={(event) => finishStroke(event, true)}
                onPointerCancel={(event) => finishStroke(event, false)}
              />
              {textDraft ? (
                <input
                  key={textDraft.id}
                  autoFocus
                  aria-label="Label"
                  value={textDraft.value}
                  onChange={(event) => {
                    const next = { ...textDraft, value: event.target.value }
                    textDraftRef.current = next
                    setTextDraft(next)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      commitText()
                    }
                  }}
                  onBlur={() => { if (textDraftRef.current?.id === textDraft.id) commitText() }}
                  className="absolute min-w-[6ch] border border-dashed border-current bg-transparent p-0 leading-none outline-none [field-sizing:content]"
                  style={{
                    left: textDraft.at.x * fit.scale,
                    top: textDraft.at.y * fit.scale,
                    color: textDraft.color,
                    font: markupFont(MARKUP_TEXT_SIZE),
                    lineHeight: 1,
                  }}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter className="items-center">
          {attachError ? <p role="alert" className="mr-auto px-2 text-sm text-destructive">{attachError}</p> : null}
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button type="button" variant="secondary" size="sm" disabled={!source || attaching} onClick={() => void attach()}>
            Add to prompt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
