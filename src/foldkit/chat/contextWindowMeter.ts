import { Submodel } from "foldkit"
import { formatContextWindowTokens, type ContextWindowSnapshot } from "../../client/lib/contextWindow"
import { cn } from "../../client/lib/utils"
import * as Tooltip from "../ui/tooltip"

// ContextWindowMeter (components/chat-ui/ContextWindowMeter.tsx): the ring
// in the composer's footer showing how much of the context window the chat
// has used, with the numbers in a tooltip. Its only state is the tooltip's,
// so its Model is the tooltip's:
//
//   Model:   contextMeter: ContextWindowMeter.Model      init: ContextWindowMeter.init()
//   Message: GotContextMeterMessage: { message: ContextWindowMeter.Message }
//   update:  GotContextMeterMessage: ({ message }) => ContextWindowMeter.update(model.contextMeter, message)
//   view:    h.submodel({ slotId: "context-meter", model: model.contextMeter, view: ContextWindowMeter.view,
//              viewInputs: { usage }, toParentMessage: … })
//
// A leaf: it imports nothing of the chat page, so the composer can embed it
// without a cycle.

export const Model = Tooltip.Model
export type Model = Tooltip.Model
export const Message = Tooltip.Message
export type Message = Tooltip.Message
export const update = Tooltip.update

/** `<Tooltip delayDuration={0}>`. */
export function init(id = "context-window-meter"): Model {
  return Tooltip.init({ id, delayDuration: 0 })
}

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`
  }
  return `${Math.round(value)}%`
}

export interface ViewInputs {
  usage: ContextWindowSnapshot
}

const RADIUS = 9.75
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, { usage }, h) => {
  const usedPercentage = formatPercentage(usage.usedPercentage)
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0))
  const dashOffset = CIRCUMFERENCE - (normalizedPercentage / 100) * CIRCUMFERENCE
  const withMax = usage.maxTokens !== undefined && usedPercentage

  return h.submodel({
    slotId: "tooltip",
    model,
    view: Tooltip.view,
    viewInputs: {
      side: "top",
      align: "center",
      className: "w-max max-w-none px-3 py-2",
      content: () => [
        h.div([h.Class("space-y-1.5 leading-tight")], [
          withMax
            ? h.div([h.Class("whitespace-nowrap text-xs font-medium text-foreground")], [
              h.span([], [usedPercentage]),
              h.span([h.Class("mx-1")], ["·"]),
              h.span([], [formatContextWindowTokens(usage.usedTokens)]),
              h.span([], ["/"]),
              h.span([], [`${formatContextWindowTokens(usage.maxTokens!)} context used`]),
            ])
            : h.div([h.Class("text-sm text-foreground")], [`${formatContextWindowTokens(usage.usedTokens)} tokens used so far`]),
        ]),
      ],
      toView: ({ trigger, portal }) => h.button([
        h.Type("button"),
        h.Class("group inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-85"),
        h.AriaLabel(withMax
          ? `Context window ${usedPercentage} used`
          : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`),
        ...trigger,
      ], [
        h.span([h.Class("relative flex h-6 w-6 items-center justify-center")], [
          h.svg([h.ViewBox("0 0 24 24"), h.Class("-rotate-90 absolute inset-0 h-full w-full transform-gpu"), h.AriaHidden(true)], [
            h.circle([
              h.Cx("12"), h.Cy("12"), h.R(String(RADIUS)), h.Fill("none"), h.Stroke("currentColor"), h.StrokeWidth("2"),
              h.Class("text-muted-foreground/20"),
            ], []),
            h.circle([
              h.Cx("12"), h.Cy("12"), h.R(String(RADIUS)), h.Fill("none"), h.Stroke("currentColor"), h.StrokeWidth("2"),
              h.StrokeLinecap("round"),
              h.StrokeDasharray(String(CIRCUMFERENCE)),
              h.StrokeDashoffset(String(dashOffset)),
              h.Class("text-muted-foreground transition-[stroke-dashoffset] duration-500 ease-out"),
            ], []),
          ]),
          h.span([h.Class(cn(
            "relative flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background text-[9px] font-medium",
            "text-muted-foreground",
          ))], [
            usage.usedPercentage !== null
              ? String(Math.round(usage.usedPercentage))
              : formatContextWindowTokens(usage.usedTokens),
          ]),
        ]),
        portal,
      ]),
    },
    toParentMessage: (message) => message,
  })
})
