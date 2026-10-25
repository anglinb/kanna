import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { childAttributes, type Html, type HtmlBuilder } from "foldkit/html"
import { canEncodeImageType, encodeVisualizationImage, saveFile } from "../../client/lib/visualization-image"
import type { ChartToolPayload } from "../../shared/display-tools"
import { VISUALIZATION_IMAGE_TYPES, visualizationImageFilename, visualizationImageName, type VisualizationImageType } from "../../shared/visualization-capture"
import type { VisualizationArtifact } from "../../shared/visualization"
import * as Messages from "../transcript/messages"
import { button } from "../ui/button"
import * as Dialog from "../ui/dialog"
import { ChartColumn, Download, PenLine, Shapes } from "../ui/icons"
import { input } from "../ui/input"
import { segmentedControl } from "../ui/segmented-control"
import { rowsSlot } from "./attachment"
import { captureOf } from "./capture"
import { markupView } from "./markup"
import { Message } from "./message"
import type { Model, VisualizationDialog } from "./model"
import { viewerIconButton, viewerSurface, type LayerContext } from "./surface"

// The chart and the visualization at full size: ChartFullView
// (messages/ChartTool.tsx) and VisualizationFullView (messages/Visualization.tsx),
// whose bodies are the transcript rows' (`chartFullViewBody`,
// `visualizationFrame`), drawn with the rows' Model under keys of the
// viewer's own. Download image and Mark up (VisualizationSaveDialog,
// VisualizationMarkup) are here and in markup.ts.

type H = HtmlBuilder<Message>

export const CHART_CARD_KEY = "chart"
/** The rows' state for the full-size chart: its legend and the table's menus. */
export const CHART_ROWS_KEY = "viewer-chart"

export function chartFullView(model: Model, context: LayerContext, payload: ChartToolPayload, h: H): Html {
  const title = payload.title || "Chart"
  return viewerSurface(model, context, {
    cardKey: CHART_CARD_KEY,
    label: `Chart: ${title}`,
    icon: ChartColumn({}, h),
    title,
    subtitle: payload.description ?? null,
    toolbar: [
      viewerIconButton(model, {
        id: "download-table",
        label: "Download table as CSV",
        onClick: Message.GotRowsMessage({ message: Messages.downloadChartTable(payload) }),
      }, Download({}, h), h),
    ],
    body: [rowsSlot(model, "viewer-chart-body", (rowContext, rowsH) => Messages.chartFullViewBody(CHART_ROWS_KEY, payload, rowContext, rowsH), h)],
  }, h)
}

/** Keyed by the document: a new one is a new frame, its own state. */
export function visualizationCardKey(artifact: VisualizationArtifact) {
  return `visualization:${artifact.url}`
}

export function visualizationRowsKey(artifact: VisualizationArtifact) {
  return `viewer-visualization:${artifact.url}`
}

/**
 * A visualization at full size in the viewer. A second copy of the
 * document, loaded fresh. The frame keeps its content's height and the card
 * scrolls, as inline.
 */
export function visualizationFullView(model: Model, context: LayerContext, artifact: VisualizationArtifact, hasComposer: boolean, h: H): Html {
  const dialog = model.card?.key === visualizationCardKey(artifact) ? model.visualizationDialog : null
  return viewerSurface(model, context, {
    cardKey: visualizationCardKey(artifact),
    label: `Visualization: ${artifact.title}`,
    icon: Shapes({}, h),
    title: artifact.title,
    toolbar: [
      // Only the app has a composer to add a marked-up image to.
      hasComposer ? viewerIconButton(model, { id: "markup", label: "Mark up and add to prompt", onClick: Message.ClickedMarkup() }, PenLine({}, h), h) : null,
      viewerIconButton(model, { id: "download-image", label: "Download image", onClick: Message.ClickedDownloadImage() }, Download({}, h), h),
    ],
    body: [
      dialog?.kind === "save" ? saveDialog(model, artifact.title, dialog, h) : null,
      dialog?.kind === "markup" ? markupView(model, artifact.title, h) : null,
      h.div([h.Class("p-4")], [
        // A key pressed in the frame is the frame's; the frame hands Escape back when it has no use for it.
        rowsSlot(model, "viewer-visualization-body", (rowContext, rowsH) => Messages.visualizationFrame(visualizationRowsKey(artifact), artifact, { reportsEscape: true }, rowContext, rowsH), h),
      ]),
    ],
  }, h)
}

// DOWNLOAD IMAGE

/** The type last saved, for the next save in this session. */
let lastImageType: VisualizationImageType = "png"

export function encodableTypes(): VisualizationImageType[] {
  return (Object.keys(VISUALIZATION_IMAGE_TYPES) as VisualizationImageType[]).filter(canEncodeImageType)
}

/** The type the dialog opens on: the last one saved, if this browser can write it. Asks the canvas, so a Command's. */
export function initialImageType(): VisualizationImageType {
  return encodableTypes().includes(lastImageType) ? lastImageType : "png"
}

export function initialSaveDialog(title: string, captureId: string, type: string, types: ReadonlyArray<string>): VisualizationDialog {
  return {
    kind: "save",
    captureId,
    name: visualizationImageName(title),
    type,
    types,
    saving: false,
    error: null,
  }
}

/** Names and saves a capture. A capture that fails says so here, and the dialog stays open. */
export const SaveImage = Command.define("SaveVisualizationImage", {
  args: { captureId: Schema.String, name: Schema.String, title: Schema.String, type: Schema.String },
  messages: [Message.SucceededSaveImage, Message.FailedSaveImage],
  execute: ({ captureId, name, title, type }) => Effect.tryPromise(async () => {
    const imageType = type as VisualizationImageType
    const blob = await encodeVisualizationImage(await captureOf(captureId), imageType)
    saveFile(blob, visualizationImageFilename(name, title, imageType))
    lastImageType = imageType
  }).pipe(
    Effect.map(() => Message.SucceededSaveImage()),
    Effect.catch((error) => Effect.succeed(Message.FailedSaveImage({
      error: error.cause instanceof Error ? error.cause.message : "The image could not be saved.",
    }))),
  ),
})

function saveDialog(model: Model, title: string, dialog: VisualizationDialog, h: H): Html {
  const types = dialog.types as VisualizationImageType[]
  const type = dialog.type as VisualizationImageType
  return h.submodel({
    slotId: "viewer-visualization-save",
    model: model.dialog,
    view: Dialog.view,
    viewInputs: {
      size: "sm",
      initialFocus: "input[aria-label='File name']",
      content: ({ titleId, descriptionId }) => [
        h.form([h.Class("flex min-h-0 flex-col"), h.OnSubmit(Message.SubmittedSaveImage())], [
          Dialog.dialogBody({ class: "space-y-4" }, [
            Dialog.dialogTitle({ id: titleId }, ["Download image"], h),
            Dialog.dialogDescription({ id: descriptionId }, ["The visualization at full height, in the current theme."], h),
            h.div([h.Class("flex items-center gap-2")], [
              input({
                type: "text",
                value: dialog.name,
                placeholder: visualizationImageName(title),
                onInput: (value) => Message.ChangedImageName({ value }),
                attributes: [h.AriaLabel("File name"), h.Spellcheck(false), h.Autocomplete("off")],
              }, h),
              h.span([h.Class("shrink-0 text-sm text-muted-foreground")], [`.${VISUALIZATION_IMAGE_TYPES[type].extension}`]),
            ]),
            types.length > 1
              ? segmentedControl({
                size: "sm",
                value: type,
                onValueChange: (value) => Message.ChoseImageType({ value }),
                options: types.map((value) => ({ value, label: [VISUALIZATION_IMAGE_TYPES[value].label] })),
              }, h)
              : null,
            dialog.error ? h.p([h.Role("alert"), h.Class("text-sm text-destructive")], [dialog.error]) : null,
          ], h),
          Dialog.dialogFooter({}, [
            button({ type: "button", variant: "ghost", size: "sm", attributes: [h.OnClick(Message.ClickedCancelSave())] }, ["Cancel"], h),
            button({ type: "submit", variant: "secondary", size: "sm", disabled: dialog.saving }, [dialog.saving ? "Saving…" : "Download"], h),
          ], h),
        ]),
      ],
    },
    toParentMessage: (message: Dialog.Message) => Message.GotDialogMessage({ message }),
  })
}

export { childAttributes }
