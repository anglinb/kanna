import { Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { attachFilesToComposer } from "../../client/app/chatFocusPolicy"
import { canvasToBlob, loadImageBlob } from "../../client/lib/visualization-image"
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
  type MarkupState,
  type MarkupTool,
} from "../../client/lib/visualization-markup"
import { cn } from "../../client/lib/utils"
import { visualizationImageName } from "../../shared/visualization-capture"
import { button } from "../ui/button"
import * as Dialog from "../ui/dialog"
import { MoveUpRight, Pencil, Square, Trash2, Type, Undo2 } from "../ui/icons"
import { domStream } from "../ui/overlay/stream"
import { segmentedControl } from "../ui/segmented-control"
import { captureOf } from "./capture"
import { Message } from "./message"
import type { Model } from "./model"
import { viewerIconButton } from "./surface"

// VisualizationMarkup (messages/VisualizationMarkup.tsx): draw on a capture
// of a visualization, then hand it to the composer as a PNG. The capture is
// shown whole in the stage and marked in its own pixels
// (`lib/visualization-markup`); "Add to prompt" draws the marks onto it at
// full size. Mouse, touch and pen all draw: the canvas alone takes
// `touch-action: none`, so a finger on it draws rather than scrolls.
//
// The stroke being drawn lives in the canvas's Mount, as React kept it in a
// ref: only a finished mark is a Message.

type H = HtmlBuilder<Message>

const TOOLS: ReadonlyArray<{ value: MarkupTool; label: string; icon: typeof Pencil }> = [
  { value: "pen", label: "Pen", icon: Pencil },
  { value: "arrow", label: "Arrow", icon: MoveUpRight },
  { value: "box", label: "Box", icon: Square },
  { value: "text", label: "Text", icon: Type },
]

export interface TextDraft { id: number; at: MarkupPoint; color: string; size: number; value: string }

export interface MarkupModel {
  captureId: string
  tool: MarkupTool
  color: string
  markup: MarkupState
  source: { width: number; height: number } | null
  loadError: string | null
  stage: { width: number; height: number }
  textDraft: TextDraft | null
  nextTextId: number
  attaching: boolean
  attachError: string | null
}

export function initialMarkup(captureId: string): MarkupModel {
  return {
    captureId,
    tool: "pen",
    color: MARKUP_COLORS[0].value,
    markup: EMPTY_MARKUP,
    source: null,
    loadError: null,
    stage: { width: 0, height: 0 },
    textDraft: null,
    nextTextId: 0,
    attaching: false,
    attachError: null,
  }
}

/** The decoded capture, by capture id: drawn by the canvas, flattened by Add to prompt. */
const sources = new Map<string, { image: HTMLImageElement; url: string }>()

export function releaseMarkupSource(captureId: string) {
  const source = sources.get(captureId)
  if (source) URL.revokeObjectURL(source.url)
  sources.delete(captureId)
}

export const LoadMarkupSource = Command.define("ViewerLoadMarkupSource", {
  args: { captureId: Schema.String },
  messages: [Message.LoadedMarkupSource, Message.FailedMarkupSource],
  execute: ({ captureId }) => Effect.tryPromise(async () => {
    const loaded = await loadImageBlob(await captureOf(captureId))
    sources.set(captureId, loaded)
    return Message.LoadedMarkupSource({ captureId, width: loaded.image.naturalWidth, height: loaded.image.naturalHeight })
  }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedMarkupSource({
    captureId,
    error: error.cause instanceof Error ? error.cause.message : "The visualization could not be drawn.",
  })))),
})

function textMark(draft: TextDraft): Mark {
  return { kind: "text", color: draft.color, size: draft.size, at: draft.at, text: draft.value.trim() }
}

/** A label being typed goes in when anything else happens. */
export function commitText(markup: MarkupModel): MarkupModel {
  const draft = markup.textDraft
  if (!draft) return markup
  return { ...markup, textDraft: null, markup: markupReducer(markup.markup, { type: "add", mark: textMark(draft) }) }
}

/** "Add to prompt": the marks drawn onto the capture at full size, into the page's composer. */
export const AttachMarkup = Command.define("ViewerAttachMarkup", {
  args: { captureId: Schema.String, title: Schema.String, marks: Schema.Unknown },
  messages: [Message.SucceededAttachMarkup, Message.FailedAttachMarkup],
  execute: ({ captureId, title, marks }) => Effect.tryPromise(async () => {
    const source = sources.get(captureId)
    if (!source) throw new Error("The image could not be made.")
    const canvas = document.createElement("canvas")
    canvas.width = source.image.naturalWidth
    canvas.height = source.image.naturalHeight
    const context = canvas.getContext("2d")
    if (!context) throw new Error("The image could not be made.")
    context.drawImage(source.image, 0, 0)
    drawMarks(context, marks as Mark[])
    const blob = await canvasToBlob(canvas, "image/png")
    if (!blob) throw new Error("The image could not be made.")
    const file = new File([blob], `${visualizationImageName(title)}-markup.png`, { type: "image/png" })
    if (!attachFilesToComposer([file])) throw new Error("There is no message box on this page to add it to.")
  }).pipe(
    Effect.map(() => Message.SucceededAttachMarkup()),
    Effect.catch((error) => Effect.succeed(Message.FailedAttachMarkup({
      error: error.cause instanceof Error ? error.cause.message : "The image could not be made.",
    }))),
  ),
})

// MOUNTS

/** The stage's size, which the capture is fitted into. */
export const MeasureMarkupStage = Mount.defineStream("ViewerMeasureMarkupStage", {
  messages: [Message.MeasuredMarkupStage],
  execute: ({ element }) => domStream<typeof Message.MeasuredMarkupStage.Type>((emit) => {
    const measure = () => emit(Message.MeasuredMarkupStage({ width: element.clientWidth, height: element.clientHeight }))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }),
})

/**
 * The canvas: the capture and the marks drawn on it, and the stroke being
 * drawn. Remade with each change of what it shows (its key), which is when
 * React's redraw ran.
 */
export const MarkupCanvas = Mount.defineStream("ViewerMarkupCanvas", {
  args: {
    captureId: Schema.String,
    tool: Schema.String,
    color: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
    scale: Schema.Number,
    marks: Schema.Unknown,
    hasDraft: Schema.Boolean,
  },
  messages: [Message.AddedMark, Message.PlacedTextDraft, Message.CommittedTextDraft],
  execute: ({ element, captureId, tool, color, width: fitWidth, height: fitHeight, scale, marks, hasDraft }) =>
    domStream<typeof Message.AddedMark.Type | typeof Message.PlacedTextDraft.Type | typeof Message.CommittedTextDraft.Type>((emit) => {
      const canvas = element as HTMLCanvasElement
      const source = sources.get(captureId)
      const kept = marks as Mark[]
      let draft: Mark | null = null
      let pointer: number | null = null
      let textPending = hasDraft

      const redraw = () => {
        const context = canvas.getContext("2d")
        if (!context || !source || scale === 0) return
        const ratio = window.devicePixelRatio || 1
        const width = Math.round(fitWidth * ratio)
        const height = Math.round(fitHeight * ratio)
        if (canvas.width !== width) canvas.width = width
        if (canvas.height !== height) canvas.height = height
        context.setTransform(1, 0, 0, 1, 0, 0)
        context.clearRect(0, 0, width, height)
        context.setTransform(scale * ratio, 0, 0, scale * ratio, 0, 0)
        context.drawImage(source.image, 0, 0, source.image.naturalWidth, source.image.naturalHeight)
        drawMarks(context, draft ? [...kept, draft] : kept)
      }
      redraw()
      if (!source) return () => {}
      const toImage = (event: { clientX: number; clientY: number }) =>
        imagePoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), source.image.naturalWidth, source.image.naturalHeight)

      const onPointerDown = (event: PointerEvent) => {
        if (scale === 0 || pointer !== null) return
        if (event.pointerType === "mouse" && event.button !== 0) return
        // No mouse events follow, so focus stays where it is.
        event.preventDefault()
        if (textPending) {
          textPending = false
          emit(Message.CommittedTextDraft({ id: null }))
        }
        const at = toImage(event)
        if (tool === "text") {
          emit(Message.PlacedTextDraft({ at, size: MARKUP_TEXT_SIZE / scale }))
          return
        }
        canvas.setPointerCapture(event.pointerId)
        pointer = event.pointerId
        const width = MARKUP_STROKE / scale
        draft = tool === "pen"
          ? { kind: "pen", color, width, points: [at] }
          : { kind: tool as "arrow" | "box", color, width, from: at, to: at }
        redraw()
      }
      const onPointerMove = (event: PointerEvent) => {
        if (event.pointerId !== pointer || !draft) return
        if (draft.kind === "pen") {
          // Every sample since the last frame, so a fast stroke stays smooth.
          const samples = event.getCoalescedEvents?.() ?? []
          for (const sample of samples.length > 0 ? samples : [event]) draft.points.push(toImage(sample))
        } else if (draft.kind === "arrow" || draft.kind === "box") {
          draft.to = toImage(event)
        }
        redraw()
      }
      const finish = (keep: boolean) => (event: PointerEvent) => {
        if (event.pointerId !== pointer) return
        pointer = null
        const finished = draft
        draft = null
        if (finished && keep) emit(Message.AddedMark({ mark: finished }))
        else redraw()
      }
      const onUp = finish(true)
      const onCancel = finish(false)
      canvas.addEventListener("pointerdown", onPointerDown)
      canvas.addEventListener("pointermove", onPointerMove)
      canvas.addEventListener("pointerup", onUp)
      canvas.addEventListener("pointercancel", onCancel)
      return () => {
        canvas.removeEventListener("pointerdown", onPointerDown)
        canvas.removeEventListener("pointermove", onPointerMove)
        canvas.removeEventListener("pointerup", onUp)
        canvas.removeEventListener("pointercancel", onCancel)
      }
    }),
})

/** The label field takes focus when it is placed (`autoFocus`). */
export const FocusLabel = Mount.define("ViewerFocusMarkupLabel", {
  messages: [Message.CompletedSideEffect],
  execute: ({ element }) => Effect.sync(() => {
    (element as HTMLInputElement).focus()
    return Message.CompletedSideEffect()
  }),
})

// VIEW

export function markupView(model: Model, title: string, h: H): Html | null {
  const markup = model.markup
  if (!markup) return null
  const fit = markup.source
    ? fitMarkupStage(markup.source.width, markup.source.height, markup.stage.width, markup.stage.height)
    : { width: 0, height: 0, scale: 0 }
  const { textDraft } = markup
  return h.submodel({
    slotId: "viewer-visualization-markup",
    model: model.dialog,
    view: Dialog.view,
    viewInputs: {
      size: "lg",
      className: "h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[1200px]",
      // Escape while typing a label drops the label, not the markup.
      dismissOnEscape: textDraft === null,
      content: ({ titleId, descriptionId }) => [
        // Right padding clears the dialog's close button.
        h.div([h.Class("flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border p-3 pr-12")], [
          Dialog.dialogTitle({ id: titleId, class: "text-base" }, ["Mark up"], h),
          Dialog.dialogDescription({ id: descriptionId, class: "sr-only" }, ["Draw on the visualization, then add the image to your next message."], h),
          segmentedControl({
            size: "sm",
            value: markup.tool,
            onValueChange: (tool) => Message.ChoseMarkupTool({ tool }),
            options: TOOLS.map((tool) => ({ value: tool.value, label: [tool.label], icon: tool.icon })),
          }, h),
          h.div([h.Role("radiogroup"), h.AriaLabel("Color"), h.Class("flex items-center gap-1.5")], MARKUP_COLORS.map((option) =>
            h.keyed("button")(option.value, [
              h.Type("button"),
              h.Role("radio"),
              h.AriaChecked(markup.color === option.value),
              h.AriaLabel(option.name),
              h.OnClick(Message.ChoseMarkupColor({ color: option.value })),
              h.Class(cn(
                "size-6 rounded-full border-2 border-transparent ring-offset-background transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                markup.color === option.value && "ring-2 ring-foreground ring-offset-2",
              )),
              h.Style({ "background-color": option.value }),
            ], []))),
          h.div([h.Class("flex items-center gap-1")], [
            viewerIconButton(model, { id: "markup-undo", label: "Undo", disabled: markup.markup.past.length === 0 && !textDraft, onClick: Message.ClickedUndoMarkup() }, Undo2({}, h), h),
            viewerIconButton(model, { id: "markup-clear", label: "Clear", disabled: markup.markup.marks.length === 0 && !textDraft, onClick: Message.ClickedClearMarkup() }, Trash2({}, h), h),
          ]),
        ]),
        h.div([h.Class("relative m-3 flex min-h-0 flex-1 items-center justify-center"), h.OnMount(MeasureMarkupStage())], [
          markup.loadError
            ? h.p([h.Role("alert"), h.Class("text-sm text-muted-foreground")], [markup.loadError])
            : !markup.source
              ? h.p([h.Class("text-sm text-muted-foreground")], ["Drawing the visualization…"])
              : fit.scale > 0
                ? h.div([h.Class("relative shadow-sm ring-1 ring-border"), h.Style({ width: `${fit.width}px`, height: `${fit.height}px` })], [
                  h.keyed("canvas")(`markup-canvas:${markup.markup.marks.length}:${markup.markup.past.length}:${fit.width}x${fit.height}:${markup.tool}:${markup.color}:${textDraft?.id ?? ""}`, [
                    h.AriaLabel(`Markup canvas for ${title}`),
                    h.Class(cn("block size-full", markup.tool === "text" ? "cursor-text" : "cursor-crosshair")),
                    h.Style({ "touch-action": "none" }),
                    h.OnMount(MarkupCanvas({
                      captureId: markup.captureId,
                      tool: markup.tool,
                      color: markup.color,
                      width: fit.width,
                      height: fit.height,
                      scale: fit.scale,
                      marks: markup.markup.marks,
                      hasDraft: textDraft !== null,
                    })),
                  ], []),
                  textDraft
                    ? h.keyed("input")(`markup-label:${textDraft.id}`, [
                      h.AriaLabel("Label"),
                      h.Value(textDraft.value),
                      h.OnInput((value) => Message.ChangedTextDraft({ value })),
                      h.OnKeyDown((key) => (key === "Enter" ? Message.CommittedTextDraft({ id: textDraft.id }) : key === "Escape" ? Message.CancelledTextDraft() : Message.CompletedSideEffect())),
                      h.OnBlur(Message.CommittedTextDraft({ id: textDraft.id })),
                      h.Class("absolute min-w-[6ch] border border-dashed border-current bg-transparent p-0 leading-none outline-none [field-sizing:content]"),
                      h.Style({
                        left: `${textDraft.at.x * fit.scale}px`,
                        top: `${textDraft.at.y * fit.scale}px`,
                        color: textDraft.color,
                        font: markupFont(MARKUP_TEXT_SIZE),
                        "line-height": "1",
                      }),
                      h.OnMount(FocusLabel()),
                    ])
                    : null,
                ])
                : null,
        ]),
        Dialog.dialogFooter({ class: "items-center" }, [
          markup.attachError ? h.p([h.Role("alert"), h.Class("mr-auto px-2 text-sm text-destructive")], [markup.attachError]) : null,
          button({ type: "button", variant: "ghost", size: "sm", attributes: [h.OnClick(Message.ClosedMarkup({ attached: false }))] }, ["Cancel"], h),
          button({
            type: "button",
            variant: "secondary",
            size: "sm",
            disabled: !markup.source || markup.attaching,
            attributes: [h.OnClick(Message.ClickedAttachMarkup())],
          }, ["Add to prompt"], h),
        ], h),
      ],
    },
    toParentMessage: (message: Dialog.Message) => Message.GotDialogMessage({ message }),
  })
}

// UPDATE

export type MarkupMessage = Extract<Message, {
  _tag:
    | "LoadedMarkupSource" | "FailedMarkupSource" | "MeasuredMarkupStage" | "ChoseMarkupTool" | "ChoseMarkupColor"
    | "AddedMark" | "PlacedTextDraft" | "ChangedTextDraft" | "CommittedTextDraft" | "CancelledTextDraft"
    | "ClickedUndoMarkup" | "ClickedClearMarkup"
}>

export function markupUpdate(markup: MarkupModel, message: MarkupMessage): MarkupModel {
  switch (message._tag) {
    case "LoadedMarkupSource":
      return message.captureId === markup.captureId ? { ...markup, source: { width: message.width, height: message.height } } : markup
    case "FailedMarkupSource":
      return message.captureId === markup.captureId ? { ...markup, loadError: message.error } : markup
    case "MeasuredMarkupStage":
      return markup.stage.width === message.width && markup.stage.height === message.height ? markup : { ...markup, stage: { width: message.width, height: message.height } }
    case "ChoseMarkupTool":
      return { ...markup, tool: message.tool as MarkupTool }
    case "ChoseMarkupColor":
      return { ...markup, color: message.color }
    case "AddedMark":
      return { ...markup, markup: markupReducer(markup.markup, { type: "add", mark: message.mark as Mark }) }
    case "PlacedTextDraft": {
      const id = markup.nextTextId + 1
      return { ...markup, nextTextId: id, textDraft: { id, at: message.at, color: markup.color, size: message.size, value: "" } }
    }
    case "ChangedTextDraft":
      return markup.textDraft ? { ...markup, textDraft: { ...markup.textDraft, value: message.value } } : markup
    case "CommittedTextDraft":
      return message.id === null || markup.textDraft?.id === message.id ? commitText(markup) : markup
    case "CancelledTextDraft":
      return { ...markup, textDraft: null }
    case "ClickedUndoMarkup":
      return markup.textDraft ? { ...markup, textDraft: null } : { ...markup, markup: markupReducer(markup.markup, { type: "undo" }) }
    case "ClickedClearMarkup":
      return { ...markup, textDraft: null, markup: markupReducer(markup.markup, { type: "clear" }) }
  }
}
