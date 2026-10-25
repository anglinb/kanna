import { Schema } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { domStream } from "../../ui/overlay/stream"
import { cn } from "../../../client/lib/utils"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { buttonClass } from "../../ui/button"
import { Check, CheckCheck, ChevronDown, CornerDownLeft, Pencil, Send } from "../../ui/icons"
import { transcriptMarkdownChildren, type RowContext } from "./context"
import { EMPTY_PLAN, keys, Message } from "./model"
import { copyButton } from "./shared"

/**
 * ExitPlanModeMessage.tsx: the agent's plan, and while it is the latest and
 * undecided, Approve & Clear, Approve, and Suggest Edits (a draft box). The
 * decisions are `ConfirmedExitPlanMode` OutMessages; the draft and Show
 * More are the Model's.
 */

type PlanCall = Extract<HydratedTranscriptMessage, { kind: "tool"; toolKind: "exit_plan_mode" }>

/**
 * The draft box's keys: Enter sends the draft (and only then is the
 * newline stopped), Escape drops it and lets the key go on. One listener on
 * the element, since Foldkit's key attributes either prevent every key they
 * handle or none.
 */
const PlanDraftKeys = Mount.defineStream("PlanDraftKeys", {
  args: { toolId: Schema.String },
  messages: [Message.ConfirmedPlan, Message.CancelledPlanEdit],
  execute: ({ element, toolId }) =>
    domStream<typeof Message.ConfirmedPlan.Type | typeof Message.CancelledPlanEdit.Type>((emit) => {
      const textarea = element as HTMLTextAreaElement
      const onKeyDown = (event: KeyboardEvent) => {
        const draft = textarea.value.trim()
        if (event.key === "Enter" && !event.shiftKey && draft) {
          event.preventDefault()
          emit(Message.ConfirmedPlan({ toolId, confirmed: false, message: draft }))
        }
        if (event.key === "Escape") emit(Message.CancelledPlanEdit({ toolId }))
      }
      textarea.addEventListener("keydown", onKeyDown)
      return () => textarea.removeEventListener("keydown", onKeyDown)
    }),
})

export function exitPlanModeMessage(message: PlanCall, isLatest: boolean, context: RowContext, h: HtmlBuilder<Message>): Html {
  const isComplete = !!message.result
  const toolId = message.toolId
  const expanded = Boolean(context.model.open[keys.plan(toolId)])
  const plan = context.model.plans[toolId] ?? EMPTY_PLAN
  const input = message.input
  const result = isComplete ? message.result : null
  const isDiscarded = result?.discarded === true
  const draft = plan.draft.trim()

  const decision = (): Html => {
    if (isComplete) {
      return h.div([h.Class("flex justify-end mx-2")], [
        h.span([h.Class("pl-4 inline text-sm font-medium bg-surface text-foreground/60 border border-border py-1.5 px-3 rounded-[20px] leading-relaxed max-w-[85%] sm:max-w-[80%]")], [
          h.em([], [
            isDiscarded ? "Discarded"
            : result?.clearContext ? "Approved & Cleared Context"
            : result?.confirmed ? "Approved"
            : result?.message ? `Adjusted: "${result.message}"`
            : "Adjusted Plan",
          ]),
          CornerDownLeft({ class: "inline h-4 w-4 ml-1.5 -mt-0.5" }, h),
        ]),
      ])
    }
    if (!isLatest) {
      return h.div([h.Class("flex justify-end mx-2")], [
        h.span([h.Class("inline text-sm text-muted-foreground italic")], ["Plan pending (newer prompt active)"]),
      ])
    }
    if (context.options.readonly) {
      return h.div([h.Class("flex justify-end mx-2")], [
        h.span([h.Class("inline text-sm text-muted-foreground italic")], ["Plan pending in original session"]),
      ])
    }
    return h.div([h.Class("flex flex-col gap-3")], [
      !plan.editing
        ? h.div([h.Class("flex flex-col md:flex-row items-stretch md:items-center justify-end gap-2 mx-2")], [
          h.button([
            h.Class(buttonClass({ size: "sm", class: "rounded-full bg-primary text-background pr-4 md:order-last" })),
            h.OnClick(Message.ConfirmedPlan({ toolId, confirmed: true, clearContext: true })),
          ], [CheckCheck({ class: "h-4 w-4 mr-1.5" }, h), "Approve & Clear"]),
          h.div([h.Class("flex items-stretch md:items-center gap-2 md:contents")], [
            h.button([
              h.Class(buttonClass({ size: "sm", variant: "outline", class: "rounded-full border-border flex-1 md:flex-initial md:order-first" })),
              h.OnClick(Message.ClickedSuggestEdits({ toolId })),
            ], [Pencil({ class: "h-4 w-4 mr-1.5" }, h), "Suggest Edits"]),
            h.button([
              h.Class(buttonClass({ size: "sm", variant: "outline", class: "rounded-full border-border flex-1 md:flex-initial" })),
              h.OnClick(Message.ConfirmedPlan({ toolId, confirmed: true })),
            ], [Check({ class: "h-4 w-4 mr-1.5" }, h), "Approve"]),
          ]),
        ])
        : null,
      plan.editing
        ? h.div([h.Class("flex flex-col gap-2")], [
          h.textarea([
            h.DataAttribute("plan-draft", toolId),
            h.Value(plan.draft),
            h.OnInput((value) => Message.ChangedPlanDraft({ toolId, value })),
            h.OnMount(PlanDraftKeys({ toolId })),
            h.Placeholder("Describe what you'd like to change..."),
            h.Rows(3),
            h.Class("w-full rounded-2xl border border-border bg-muted dark:bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none"),
          ]),
          h.div([h.Class("flex items-center justify-end gap-2 mx-2")], [
            h.button([
              h.Class(buttonClass({ size: "sm", variant: "ghost", class: "rounded-full text-muted-foreground" })),
              h.OnClick(Message.CancelledPlanEdit({ toolId })),
            ], ["Cancel"]),
            h.button([
              h.Class(buttonClass({ size: "sm", class: "rounded-full bg-primary text-background disabled:opacity-50 disabled:pointer-events-none" })),
              ...(draft ? [h.OnClick(Message.ConfirmedPlan({ toolId, confirmed: false, message: draft }))] : [h.Disabled(true)]),
            ], [Send({ class: "h-4 w-4 mr-1.5" }, h), "Adjust Plan"]),
          ]),
        ])
        : null,
    ])
  }

  return h.div([h.Class("flex flex-col gap-3")], [
    h.div([h.Class("relative rounded-2xl border border-border overflow-hidden group/plan")], [
      input?.plan
        ? copyButton({
          key: `plan-copy:${toolId}`,
          text: input.plan,
          class: "absolute top-2 right-2 z-10 h-8 w-8 rounded-md text-muted-foreground opacity-0 group-hover/plan:opacity-100 transition-opacity",
        }, context, h)
        : null,
      h.div([h.Class(cn(
        "!pt-5 !pb-0 px-4 md:py-4.5 md:px-5.5 bg-muted dark:bg-card overflow-scroll no-pre-highlight transition-all",
        isComplete && !expanded ? "max-h-[min(400px,40vh)] " : "",
        isComplete ? "hover:!pb-[32px]" : "",
      ))], [
        isComplete
          ? h.button([
            h.Class(buttonClass({
              variant: "ghost",
              class: "absolute z-10 bottom-2 pr-2.5 !pl-3.5 h-[34px] inline-flex gap-1 text-sm left-[50%] -translate-x-[50%] text-muted-foreground backdrop-blur-sm hover:text-foreground opacity-0 group-hover/plan:opacity-100 transition-all rounded-full border border-border",
            })),
            h.OnClick(Message.ToggledOpen({ key: keys.plan(toolId) })),
          ], [
            expanded ? "Show Less" : "Show More",
            ChevronDown({ class: `size-3.5 transition-transform ${expanded ? "rotate-180" : ""}` }, h),
          ])
          : null,
        input?.plan
          ? h.div([h.Class("prose prose-sm dark:prose-invert max-w-none")], [
            ...transcriptMarkdownChildren(input.plan, `plan:${toolId}`, context, h),
            h.div([h.Class("mt-5")], []),
          ])
          : h.p([h.Class("text-sm text-muted-foreground")], ["No plan provided"]),
      ]),
    ]),
    decision(),
  ])
}
