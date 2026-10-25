import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../../client/lib/utils"
import type { AskUserQuestionAnswerMap, AskUserQuestionItem, AskUserQuestionOption, HydratedTranscriptMessage } from "../../../shared/types"
import type { Child } from "../../ui/attributes"
import { buttonClass } from "../../ui/button"
import { Check, ChevronLeft, MessageCircleQuestion } from "../../ui/icons"
import type { RowContext } from "./context"
import { EMPTY_QUESTION, effectiveAnswers, Message, questionKey, type QuestionState } from "./model"

/**
 * AskUserQuestionMessage.tsx: the agent's questions, one at a time while
 * they are the latest and unanswered; the answers once they are. What is
 * picked or typed before Submit is the Model's (`questions[toolId]`);
 * Submit emits `SubmittedAskUserQuestion`.
 */

type AskCall = Extract<HydratedTranscriptMessage, { kind: "tool"; toolKind: "ask_user_question" }>

function questionCard(
  question: string,
  currentIndex: number,
  totalQuestions: number,
  onBack: Message | undefined,
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<Message>,
): Html {
  const showBackButton = onBack !== undefined && currentIndex > 0
  return h.div([h.Class("rounded-2xl border border-border overflow-hidden")], [
    h.div([h.Class("relative")], [
      h.h3([h.Class("font-medium text-foreground text-sm p-3 px-4 bg-card border-b border-border text-foreground flex flex-row items-center gap-2")], [
        showBackButton
          ? h.button([h.OnClick(onBack!), h.Class(" text-muted-foreground hover:opacity-60 transition-all flex items-center")], [
            ChevronLeft({ class: "h-4 w-4 -ml-0.5", strokeWidth: 3 }, h),
          ])
          : totalQuestions > 1
            ? h.span([h.Class("font-bold text-muted-foreground whitespace-nowrap")], [`${currentIndex + 1} of ${totalQuestions}`])
            : null,
        question,
      ]),
      // Progress bar
      totalQuestions > 1
        ? h.div([h.Class("absolute bottom-0 left-0 right-0 h-0.5 bg-border")], [
          h.div([h.Class("h-full bg-muted-foreground/40 transition-all duration-300"), h.Style({ width: `${(currentIndex / totalQuestions) * 100}%` })], []),
        ])
        : null,
    ]),
    ...children,
  ])
}

function optionContent(label: string, description: string | undefined, h: HtmlBuilder<Message>): ReadonlyArray<Child> {
  return [
    h.span([h.Class("text-foreground text-sm")], [label]),
    description ? h.p([h.Class("text-xs text-muted-foreground mt-0.5")], [description]) : null,
  ]
}

function checkbox(selected: boolean, multiSelect: boolean | undefined, onClick: Message | undefined, h: HtmlBuilder<Message>): Html {
  return h.button([
    h.Type("button"),
    ...(onClick !== undefined ? [h.OnClick(onClick)] : []),
    h.Class(cn(
      "flex-shrink-0 w-5 h-5 border-1 flex items-center justify-center",
      multiSelect ? "rounded" : "rounded-full",
      selected
        ? "border-slate-500/0 bg-foreground"
        : "border-muted-foreground/50 bg-surface",
      onClick !== undefined && selected && "cursor-pointer",
    )),
  ], [
    selected ? Check({ strokeWidth: 3, class: "translate-y-[0.5px] h-3 w-3 text-white dark:text-background" }, h) : null,
  ])
}

function optionRow(option: AskUserQuestionOption, selected: boolean, multiSelect: boolean | undefined, onClick: Message, h: HtmlBuilder<Message>): Html {
  const baseClasses = "w-full text-left p-3 pt-2.5 pl-4 pr-5 bg-surface"
  return h.button([h.OnClick(onClick), h.Class(cn(baseClasses, "border-b border-border", "transition-all cursor-pointer"))], [
    h.div([h.Class("flex items-center justify-between gap-3")], [
      h.div([h.Class("flex-1 min-w-0")], optionContent(option.label, option.description, h)),
      checkbox(selected, multiSelect, undefined, h),
    ]),
  ])
}

export function askUserQuestionMessage(message: AskCall, isLatest: boolean, context: RowContext, h: HtmlBuilder<Message>): Html {
  const questions = message.input.questions
  const isComplete = !!message.result
  const savedAnswers: AskUserQuestionAnswerMap | undefined = message.result?.answers
  const isDiscarded = message.result?.discarded === true
  const state: QuestionState = context.model.questions[message.toolId] ?? EMPTY_QUESTION
  const isSubmitted = state.submitted !== null

  // Completed state
  if (isSubmitted || isComplete) {
    const displayAnswers = savedAnswers || state.submitted || {}
    return h.div([h.Class("w-full")], [
      h.div([h.Class("rounded-2xl border border-border overflow-hidden")], [
        h.div([h.Class("font-medium text-sm p-3 px-4 pr-5 bg-muted  border-b border-border flex flex-row items-center justify-between")], [
          h.p([], [`Question${questions.length !== 1 ? "s" : ""}`]),
          h.p([h.Class("")], [isDiscarded ? "Discarded" : "Answers"]),
        ]),
        ...questions.map((question, index) => {
          const answerValue = displayAnswers[questionKey(question)] || displayAnswers[question.question] || []
          const isLast = index === questions.length - 1
          return h.div([h.Class(cn("w-full p-3 pt-2.5 pl-4 pr-5 bg-surface flex items-center justify-between gap-3", !isLast && "border-b border-border"))], [
            h.div([h.Class("text-sm text-pretty")], [question.question]),
            answerValue.length > 0 ? h.div([h.Class("text-sm font-medium text-right max-w-[50%] text-pretty")], [answerValue.join(", ")]) : null,
            answerValue.length === 0 ? h.div([h.Class("text-sm font-medium text-right italic")], [isDiscarded ? "Discarded" : "No Response"]) : null,
          ])
        }),
      ]),
    ])
  }

  if (context.options.readonly) {
    return h.div([h.Class("w-full")], [
      h.div([h.Class("rounded-2xl border border-border overflow-hidden")], [
        h.div([h.Class("font-medium text-sm p-3 px-4 pr-5 bg-muted border-b border-border flex flex-row items-center justify-between gap-3")], [
          h.p([], [`Question${questions.length !== 1 ? "s" : ""}`]),
          h.p([h.Class("text-muted-foreground")], ["Awaiting response"]),
        ]),
        ...questions.map((question, index) => h.div([h.Class(cn("w-full p-3 pt-2.5 pl-4 pr-5 bg-surface flex items-center justify-between gap-3", index < questions.length - 1 && "border-b border-border"))], [
          h.div([h.Class("text-sm text-pretty")], [question.question]),
          h.div([h.Class("max-w-[50%] text-right text-xs text-muted-foreground text-pretty")], [
            question.options?.map((option) => option.label).join(", ") || "Freeform response",
          ]),
        ])),
      ]),
    ])
  }

  // Pending state (not latest)
  if (!isLatest) {
    return h.div([h.Class("w-full py-2")], [
      h.div([h.Class("flex items-center gap-2")], [
        MessageCircleQuestion({ class: "h-4 w-4 text-muted-foreground" }, h),
        h.span([h.Class("text-sm text-muted-foreground")], ["Questions pending (newer question active)"]),
      ]),
    ])
  }

  // Active state - show one question at a time
  const currentIndex = state.currentIndex
  const currentQuestion = questions[currentIndex]
  if (!currentQuestion) return null

  const toolId = message.toolId
  const key = questionKey(currentQuestion)
  const multiSelect = Boolean(currentQuestion.multiSelect)
  const answer = state.answers[key] || ""
  const selectedOptions = multiSelect ? answer.split(", ").filter(Boolean) : [answer]
  const customInput = state.customInputs[key] || ""
  const allQuestionsAnswered = questions.every((question) => effectiveAnswers(state, questionKey(question), Boolean(question.multiSelect)).length > 0)
  const isLastQuestion = currentIndex === questions.length - 1
  const currentHasAnswer = effectiveAnswers(state, key, multiSelect).length > 0

  const finalAnswers = (): AskUserQuestionAnswerMap => {
    const answers: AskUserQuestionAnswerMap = {}
    for (const question of questions) answers[questionKey(question)] = effectiveAnswers(state, questionKey(question), Boolean(question.multiSelect))
    return answers
  }
  const submit = (): Message => Message.SubmittedAnswers({ toolId, questions: questions as ReadonlyArray<AskUserQuestionItem>, answers: finalAnswers() })
  const next = Message.ClickedNextQuestion({ toolId, count: questions.length })

  return h.div([h.Class("w-full space-y-3")], [
    questionCard(currentQuestion.question, currentIndex, questions.length, currentIndex > 0 ? Message.ClickedPreviousQuestion({ toolId }) : undefined, [
      ...(currentQuestion.options ?? []).map((option) => optionRow(
        option,
        selectedOptions.includes(option.label),
        currentQuestion.multiSelect,
        Message.SelectedOption({ toolId, questions, questionKey: key, label: option.label, multiSelect }),
        h,
      )),
      // Custom input
      h.div([h.Class("transition-all bg-surface")], [
        h.div([h.Class("flex pr-5 items-center justify-between gap-3")], [
          h.input([
            h.Type("text"),
            h.AriaLabel(currentQuestion.question),
            h.Value(customInput),
            h.OnInput((value) => Message.ChangedCustomInput({ toolId, questionKey: key, value, multiSelect })),
            h.OnKeyDownPreventDefault((pressed) => {
              if (pressed !== "Enter" || !currentHasAnswer) return Option.none()
              return Option.some(isLastQuestion ? submit() : next)
            }),
            h.Placeholder(currentQuestion.options?.length ? "Other..." : "Enter a value"),
            h.Class("flex-1 px-3 !py-1 pl-4 min-h-[55px] min-w-0 text-sm bg-transparent outline-none text-foreground placeholder:text-muted-foreground"),
          ]),
          currentQuestion.options?.length
            ? checkbox(Boolean(customInput), currentQuestion.multiSelect, multiSelect && customInput ? Message.ClearedCustomInput({ toolId, questionKey: key }) : undefined, h)
            : null,
        ]),
      ]),
    ], h),
    h.div([h.Class("flex justify-end gap-2 mx-2")], [
      !isLastQuestion && currentHasAnswer && (multiSelect || !!customInput)
        ? h.button([h.Class(buttonClass({ size: "sm" })), h.OnClick(next)], ["Next"])
        : null,
      isLastQuestion
        ? h.button([
          h.Class(buttonClass({ size: "sm", class: cn(!allQuestionsAnswered && "opacity-50 cursor-not-allowed", "rounded-full") })),
          ...(!allQuestionsAnswered ? [h.Disabled(true)] : [h.OnClick(submit())]),
        ], ["Submit"])
        : null,
    ]),
  ])
}
