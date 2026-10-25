// src/foldkit/ui/segmented-control.ts against the React <SegmentedControl>
// (gallery/ui-segmented-control.tsx).
import { Schema } from "effect"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { Folder, Pencil, Square } from "../../../foldkit/ui/icons"
import { segmentedControl, type SegmentedOption } from "../../../foldkit/ui/segmented-control"
import { galleryPage } from "../gallery-page"

const Tool = Schema.Literals(["pan", "pen", "box"])
type Tool = typeof Tool.Type
const Format = Schema.Literals(["png", "svg", "html"])
type Format = typeof Format.Type

const TOOLS: ReadonlyArray<SegmentedOption<Tool>> = [
  { value: "pan", label: ["Pan"], icon: Folder },
  { value: "pen", label: ["Pen"], icon: Pencil },
  { value: "box", label: ["Box"], icon: Square },
]

const FORMATS: ReadonlyArray<SegmentedOption<Format>> = [
  { value: "png", label: ["PNG"] },
  { value: "svg", label: ["SVG"] },
  { value: "html", label: ["HTML"], disabled: true },
]

const Model = Schema.Struct({ tool: Tool, format: Format })
type Model = typeof Model.Type
const Message = defineMessageUnion({ ChoseTool: { tool: Tool }, ChoseFormat: { format: Format } })
type Message = typeof Message.Type

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: { tool: "pen", format: "png" } }),
  update: (model, message) =>
    Message.match(message, {
      ChoseTool: ({ tool }) => ({ model: modifyFields(model, { tool: () => tool }) }),
      ChoseFormat: ({ format }) => ({ model: modifyFields(model, { format: () => format }) }),
    }),
  view: (model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("flex flex-col items-start gap-4 bg-background p-4 text-foreground")], [
      segmentedControl({ size: "sm", value: model.tool, onValueChange: (tool) => Message.ChoseTool({ tool }), options: TOOLS }, h),
      segmentedControl({ value: model.format, onValueChange: (format) => Message.ChoseFormat({ format }), options: FORMATS }, h),
      segmentedControl({
        value: model.format,
        onValueChange: (format) => Message.ChoseFormat({ format }),
        options: FORMATS,
        class: "w-80",
        optionClass: "flex-1 justify-center",
      }, h),
    ]),
  }),
})
