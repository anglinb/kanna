import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { ChartToolPayload } from "../../shared/display-tools"
import type { VisualizationArtifact } from "../../shared/visualization"
import * as Messages from "../transcript/messages"
import { transcriptMarkdownChildren } from "../transcript/messages/context"
import { Message } from "./message"
import type { Model } from "./model"

// What the viewer draws with the transcript rows' own helpers, in their
// Model's boundary: a markdown file's prose (its code copy, its links), a
// text file, the full-size chart and the visualization's frame. Their
// Messages come back through `GotRowsMessage`.
//
// The slot is handed data, not a render callback: a function in a
// submodel's inputs runs in the parent's boundary, where the rows' Messages
// (a chart's measure, a menu's open) have nowhere to go.

export type RowsContent =
  | { kind: "markdown"; key: string; text: string }
  | { kind: "file-content"; content: string }
  | { kind: "chart"; key: string; payload: ChartToolPayload }
  | { kind: "visualization"; key: string; artifact: VisualizationArtifact }

const RowsSlot = Submodel.defineView<Messages.Model, Messages.Message, { content: RowsContent }>((rows, { content }, h) => {
  const context = Messages.rowContext(rows, { interceptLocalLinks: true })
  switch (content.kind) {
    case "markdown":
      return h.div([h.Class("prose prose-sm max-w-none dark:prose-invert")], transcriptMarkdownChildren(content.text, content.key, context, h))
    case "file-content":
      return Messages.fileContentView({ content: content.content }, h)
    case "chart":
      return Messages.chartFullViewBody(content.key, content.payload, context, h)
    case "visualization":
      return Messages.visualizationFrame(content.key, content.artifact, { reportsEscape: true }, context, h)
  }
})

/** A short, stable name for a slot whose key is long (a data: URL): a slot id takes no "|". */
function slotName(text: string) {
  let hash = 5381
  for (let index = 0; index < text.length; index++) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  return (hash >>> 0).toString(36)
}

export function rowsSlot(model: Model, slot: string, content: RowsContent, h: HtmlBuilder<Message>): Html {
  return h.submodel({
    slotId: `viewer-rows-${content.kind}-${slotName(slot)}`,
    model: model.rows,
    view: RowsSlot,
    viewInputs: { content },
    toParentMessage: (message: Messages.Message) => Message.GotRowsMessage({ message }),
  })
}
