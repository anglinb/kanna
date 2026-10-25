// src/foldkit/ui/tooltip.ts against the React tooltip (gallery/ui-tooltip.tsx).
import { Option, Schema } from "effect"
import { Update } from "foldkit"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { Child } from "../../../foldkit/ui/attributes"
import { button } from "../../../foldkit/ui/button"
import * as Tooltip from "../../../foldkit/ui/tooltip"
import { galleryPage } from "../gallery-page"

const NAMES = ["edge", "top", "right", "bottom", "left", "usage", "delayed", "terminal", "label", "still"] as const
type Name = (typeof NAMES)[number]
const NameSchema = Schema.Literals(NAMES)

const Model = Schema.Struct(Object.fromEntries(NAMES.map((name) => [name, Tooltip.Model])) as Record<Name, typeof Tooltip.Model>)
type Model = typeof Model.Type

const Message = defineMessageUnion({
  GotTooltipMessage: { name: NameSchema, message: Tooltip.Message },
})
type Message = typeof Message.Type

const foldTooltip = Update.foldChildAt({
  update: Tooltip.update,
  readAt: (model: Model, name: Name) => Option.some(model[name]),
  writeAt: (model, name, next): Model => ({ ...model, [name]: next }),
  toParentMessage: (name, message) => Message.GotTooltipMessage({ name, message }),
})

const DELAYS: Partial<Record<Name, number>> = { delayed: 700, terminal: 700 }

const triggerClass = "rounded-md border border-border px-3 py-1.5 text-sm"

export default galleryPage<Model, Message>({
  Model,
  init: () => ({
    model: Object.fromEntries(NAMES.map((name) => [name, Tooltip.init({ id: name, delayDuration: DELAYS[name] ?? 0 })])) as Model,
  }),
  update: (model, message) =>
    Message.match(message, {
      GotTooltipMessage: ({ name, message: child }) => foldTooltip(model, name, child),
    }),
  view: (model, h: HtmlBuilder<Message>): Document => {
    const tooltip = (
      name: Name,
      inputs: Omit<Tooltip.ViewInputs, "toView" | "content"> & { content: () => ReadonlyArray<Child> },
      toView: (render: Tooltip.RenderInfo) => Html,
    ) =>
      h.submodel({
        slotId: name,
        model: model[name],
        view: Tooltip.view,
        viewInputs: { ...inputs, toView },
        toParentMessage: (message) => Message.GotTooltipMessage({ name, message }),
      })
    const plainTrigger = (label: string, extraClass = "") => ({ trigger, portal }: Tooltip.RenderInfo) =>
      h.button([...trigger, h.Type("button"), h.Class(`${triggerClass}${extraClass}`)], [label, portal])

    return {
      title: "Kanna",
      body: h.div([h.Class("relative min-h-dvh bg-background text-foreground")], [
        tooltip("edge", { content: () => ["Flips below at the top edge"] }, plainTrigger("Edge", " absolute left-4 top-1")),
        h.div([h.Class("flex flex-wrap items-center gap-16 p-24")], [
          tooltip("top", { content: () => ["Above by default"] }, plainTrigger("Top")),
          tooltip("right", { side: "right", sideOffset: 4, content: () => ["/Users/kanna/projects/foldkit"] }, plainTrigger("Right")),
          tooltip("bottom", { side: "bottom", content: () => ["Fetched 2m ago"] }, ({ trigger, portal }) =>
            button({ variant: "ghost", size: "sm", attributes: [...trigger, h.AriaLabel("Fetch")] }, ["Bottom", portal], h)),
          tooltip("left", { side: "left", align: "start", content: () => ["Left, start-aligned"] }, plainTrigger("Left")),
          tooltip("usage", {
            side: "top",
            align: "center",
            content: () => [h.div([], ["5-hour window"]), h.div([h.Class("text-muted-foreground")], ["Resets in 2h"])],
          }, ({ trigger, portal }) => h.div([...trigger, h.Class("flex items-center gap-2 pr-1")], ["Usage", portal])),
          tooltip("delayed", { content: () => ["After the provider's delay"] }, plainTrigger("Delayed")),
          tooltip("terminal", { side: "bottom", variant: "hotkey", content: Tooltip.hotkeyContent({ shortcut: "cmd+j" }, h) }, plainTrigger("Terminal")),
          tooltip("label", { side: "bottom", variant: "hotkey", content: Tooltip.hotkeyContent({ label: "Open in editor" }, h) }, plainTrigger("Label")),
          tooltip("still", { side: "right", still: true, content: () => ["No motion"] }, plainTrigger("Still")),
        ]),
      ]),
    }
  },
})
