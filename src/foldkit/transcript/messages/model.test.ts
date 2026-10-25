import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Story } from "foldkit/test"
import * as Select from "../../ui/select"
import type { AskUserQuestionItem, TranscriptEntry } from "../../../shared/types"
import {
  AdvanceQuestion,
  CopyText,
  FlushPayloadRequests,
  FocusPlanDraft,
  init,
  keys,
  Message,
  MoveClamp,
  OutMessage,
  receivedDebugRaw,
  receivedToolEntries,
  settledQueued,
  update,
  WaitCopied,
} from "./model"

const QUESTIONS: AskUserQuestionItem[] = [
  { question: "Which approach?", options: [{ label: "Memoize" }, { label: "Measure" }] },
  { question: "Which platforms?", multiSelect: true, options: [{ label: "macOS" }, { label: "Linux" }] },
]

describe("rows' own state", () => {
  test("a toggle opens and closes, by key", () => {
    Story.story(
      update,
      Story.given(init()),
      Story.message(Message.ToggledOpen({ key: keys.tool("t1") })),
      Story.model((model) => expect(model.open[keys.tool("t1")]).toBe(true)),
      Story.message(Message.ToggledOpen({ key: keys.tool("t1") })),
      Story.model((model) => expect(model.open[keys.tool("t1")]).toBe(false)),
    )
  })

  test("a copy shows its check for two seconds; an older timeout leaves a newer check", () => {
    Story.story(
      update,
      Story.given(init()),
      Story.message(Message.ClickedCopy({ key: "input:t1", block: -1, text: "ls" })),
      Story.Command.expectExact(CopyText({ key: "input:t1", block: -1, text: "ls" })),
      Story.Command.resolve(CopyText, Message.CompletedCopy({ key: "input:t1", block: -1, didCopy: true })),
      Story.model((model) => expect(model.copied).toEqual({ key: "input:t1", block: -1, version: 1 })),
      Story.Command.resolve(WaitCopied, Message.ElapsedCopied({ version: 1 })),
      Story.model((model) => expect(model.copied).toBeNull()),
    )
    Story.story(
      update,
      Story.given({ ...init(), copyVersion: 2, copied: { key: "input:t1", block: -1, version: 2 } }),
      Story.message(Message.ElapsedCopied({ version: 1 })),
      Story.model((model) => expect(model.copied?.version).toBe(2)),
    )
  })

  test("a failed copy shows nothing", () => {
    Story.story(
      update,
      Story.given(init()),
      Story.message(Message.ClickedCopy({ key: "plan-copy:p", block: -1, text: "plan" })),
      Story.Command.resolve(CopyText, Message.CompletedCopy({ key: "plan-copy:p", block: -1, didCopy: false })),
      Story.model((model) => expect(model.copied).toBeNull()),
      Story.Command.expectNone(),
    )
  })
})

describe("tool payloads", () => {
  test("wanted payloads go out once, batched per tick, and never twice", () => {
    Story.story(
      update,
      Story.given(init()),
      Story.message(Message.WantedPayloads({ entryIds: ["call-1", "result-1"] })),
      Story.Command.expectExact(FlushPayloadRequests()),
      Story.Command.resolve(FlushPayloadRequests, Message.FlushedPayloadRequests()),
      Story.expectOutMessage(OutMessage.RequestedToolEntries({ entryIds: ["call-1", "result-1"] })),
      Story.model((model) => {
        expect(model.queued).toEqual([])
        expect(model.inFlight["call-1"]).toBe(true)
      }),
      // In flight: still not asked again.
      Story.message(Message.WantedPayloads({ entryIds: ["result-1"] })),
      Story.Command.expectNone(),
    )
  })

  test("asked again before the tick's flush: joins the batch, no second flush", () => {
    Story.story(
      update,
      Story.given({ ...init(), inFlight: { "call-1": true }, queued: ["call-1"] }),
      Story.message(Message.WantedPayloads({ entryIds: ["call-1", "call-2"] })),
      Story.Command.expectNone(),
      Story.model((model) => expect(model.queued).toEqual(["call-1", "call-2"])),
    )
  })

  test("what comes back is kept; a failure forgets the request so the next open retries", () => {
    const entry = { _id: "call-1", kind: "tool_result", toolId: "t", content: "ok", createdAt: 0 } as TranscriptEntry
    const asked = { ...init(), inFlight: { "call-1": true, "call-2": true } }
    const model = receivedToolEntries(asked, ["call-1", "call-2"], [entry])
    expect(model.payloads["call-1"]).toBe(entry)
    expect(model.inFlight).toEqual({})
    Story.story(
      update,
      Story.given(model),
      Story.message(Message.WantedPayloads({ entryIds: ["call-1", "call-2"] })),
      Story.Command.resolve(FlushPayloadRequests, Message.FlushedPayloadRequests()),
      Story.expectOutMessage(OutMessage.RequestedToolEntries({ entryIds: ["call-2"] })),
    )
  })

  test("a Raw Message section asks for its body once, and shows a failure", () => {
    Story.story(
      update,
      Story.given(init()),
      Story.message(Message.OpenedRawMessage({ key: keys.systemSection("s", "Raw Message"), entryId: "s" })),
      Story.expectOutMessage(OutMessage.RequestedDebugRaw({ entryId: "s" })),
      Story.model((model) => expect(model.debugRaw.s).toEqual({ state: "loading", body: null })),
      Story.message(Message.OpenedRawMessage({ key: keys.systemSection("s", "Raw Message"), entryId: "s" })),
      Story.expectNoOutMessage(),
    )
    expect(receivedDebugRaw(init(), "s", Option.none()).debugRaw.s).toEqual({ state: "error", body: null })
    expect(receivedDebugRaw(init(), "s", Option.some(null)).debugRaw.s).toEqual({ state: "idle", body: "" })
  })
})

describe("AskUserQuestion", () => {
  test("a single pick moves on after 150ms; a multi-select toggles; Submit goes once", () => {
    Story.story(
      update,
      Story.given(init()),
      Story.message(Message.SelectedOption({ toolId: "t", questions: QUESTIONS, questionKey: "Which approach?", label: "Memoize", multiSelect: false })),
      Story.Command.expectExact(AdvanceQuestion({ toolId: "t", index: 1 })),
      Story.Command.resolve(AdvanceQuestion, Message.AdvancedQuestion({ toolId: "t", index: 1 })),
      Story.message(Message.SelectedOption({ toolId: "t", questions: QUESTIONS, questionKey: "Which platforms?", label: "macOS", multiSelect: true })),
      Story.message(Message.SelectedOption({ toolId: "t", questions: QUESTIONS, questionKey: "Which platforms?", label: "Linux", multiSelect: true })),
      Story.message(Message.SelectedOption({ toolId: "t", questions: QUESTIONS, questionKey: "Which platforms?", label: "macOS", multiSelect: true })),
      Story.model((model) => {
        expect(model.questions.t?.currentIndex).toBe(1)
        expect(model.questions.t?.answers).toEqual({ "Which approach?": "Memoize", "Which platforms?": "Linux" })
      }),
      Story.message(Message.SubmittedAnswers({ toolId: "t", questions: QUESTIONS, answers: { "Which approach?": ["Memoize"], "Which platforms?": ["Linux"] } })),
      Story.expectOutMessage(OutMessage.SubmittedAskUserQuestion({ toolUseId: "t", questions: QUESTIONS, answers: { "Which approach?": ["Memoize"], "Which platforms?": ["Linux"] } })),
      // A second press while the first is on its way is ignored.
      Story.message(Message.SubmittedAnswers({ toolId: "t", questions: QUESTIONS, answers: {} })),
      Story.expectNoOutMessage(),
    )
  })

  test("typing an answer clears a single pick; a multi-select keeps both", () => {
    Story.story(
      update,
      Story.given({ ...init(), questions: { t: { currentIndex: 0, answers: { "Which approach?": "Memoize", "Which platforms?": "macOS" }, customInputs: {}, submitted: null } } }),
      Story.message(Message.ChangedCustomInput({ toolId: "t", questionKey: "Which approach?", value: "Both", multiSelect: false })),
      Story.message(Message.ChangedCustomInput({ toolId: "t", questionKey: "Which platforms?", value: "BSD", multiSelect: true })),
      Story.model((model) => {
        expect(model.questions.t?.answers).toEqual({ "Which approach?": "", "Which platforms?": "macOS" })
        expect(model.questions.t?.customInputs).toEqual({ "Which approach?": "Both", "Which platforms?": "BSD" })
      }),
    )
  })
})

describe("ExitPlanMode", () => {
  test("Suggest Edits opens the draft and focuses it; a decision goes to the host", () => {
    Story.story(
      update,
      Story.given(init()),
      Story.message(Message.ClickedSuggestEdits({ toolId: "p" })),
      Story.Command.expectExact(FocusPlanDraft({ toolId: "p" })),
      Story.Command.resolve(FocusPlanDraft, Message.CompletedFocus()),
      Story.message(Message.ChangedPlanDraft({ toolId: "p", value: "Test Linux" })),
      Story.model((model) => expect(model.plans.p).toEqual({ editing: true, draft: "Test Linux" })),
      Story.message(Message.ConfirmedPlan({ toolId: "p", confirmed: false, message: "Test Linux" })),
      Story.expectOutMessage(OutMessage.ConfirmedExitPlanMode({ toolUseId: "p", confirmed: false, message: "Test Linux" })),
      Story.message(Message.CancelledPlanEdit({ toolId: "p" })),
      Story.model((model) => expect(model.plans.p).toEqual({ editing: false, draft: "" })),
    )
  })
})

describe("clamped text", () => {
  test("a press on the folded bubble opens it only while it overflows and is closed", () => {
    const key = keys.clamp("u1")
    Story.story(
      update,
      Story.given(init()),
      Story.message(Message.PressedFoldSurface({ key, id: "clamp", from: 100, lines: 25, scope: "surface" })),
      Story.Command.expectNone(),
      Story.message(Message.MeasuredClamp({ key, overflows: true })),
      Story.message(Message.PressedFoldSurface({ key, id: "clamp", from: 100, lines: 25, scope: "surface" })),
      Story.Command.expectExact(MoveClamp({ id: "clamp", expanding: true, from: 100, byKeyboard: false, lines: 25, scope: "surface" })),
      Story.Command.resolve(MoveClamp, Message.CompletedClampMotion()),
      Story.model((model) => expect(model.open[key]).toBe(true)),
      Story.message(Message.PressedFoldSurface({ key, id: "clamp", from: 400, lines: 25, scope: "surface" })),
      Story.Command.expectNone(),
    )
  })
})

describe("queue and resume", () => {
  test("a queued press can't fire twice until it settles", () => {
    Story.story(
      update,
      Story.given(init()),
      Story.message(Message.ClickedQueued({ messageId: "q1", action: "send-now" })),
      Story.expectOutMessage(OutMessage.RequestedQueueAction({ messageId: "q1", action: "send-now" })),
      Story.message(Message.ClickedQueued({ messageId: "q1", action: "remove" })),
      Story.expectNoOutMessage(),
    )
    const settled = settledQueued({ ...init(), busy: { "queued:q1": true } }, "q1")
    expect(settled.busy).toEqual({})
  })

  test("a resume press dims until it settles", () => {
    Story.story(
      update,
      Story.given(init()),
      Story.message(Message.ClickedResume({ key: "usage", action: "now" })),
      Story.expectOutMessage(OutMessage.RequestedResumeAction({ action: "now" })),
      Story.model((model) => expect(model.busy.usage).toBe(true)),
      Story.message(Message.ClickedResume({ key: "usage", action: "cancel" })),
      Story.expectNoOutMessage(),
    )
  })
})

describe("chart tables", () => {
  test("an aggregate menu's choice is the table's; the first column stays between 128 and 360px", () => {
    Story.story(
      update,
      Story.given(init()),
      Story.message(Message.GotAggregateSelectMessage({ key: "viewer", which: "row", message: Select.Message.ChoseItem({ value: "median", pointerType: "mouse" }) })),
      Story.model((model) => expect(model.charts.viewer?.rowAggregate).toBe("median")),
      Story.message(Message.ResizedChartColumn({ key: "viewer", width: 40 })),
      Story.model((model) => expect(model.charts.viewer?.firstColumnWidth).toBe(128)),
      Story.message(Message.ResizedChartColumn({ key: "viewer", width: 900 })),
      Story.model((model) => expect(model.charts.viewer?.firstColumnWidth).toBe(360)),
    )
  })
})

describe("charts", () => {
  test("the legend hides and mutes series; the pointer and the tooltip's box are kept", () => {
    Story.story(
      update,
      Story.given(init()),
      Story.message(Message.ToggledChartSeries({ key: "c", series: "desktop" })),
      Story.message(Message.HoveredChartSeries({ key: "c", series: "mobile" })),
      Story.message(Message.MeasuredChart({ key: "c", width: 766, height: 511 })),
      Story.message(Message.MovedOverChart({ key: "c", pointer: { x: 150, y: 200 } })),
      Story.message(Message.MeasuredChartTooltip({ key: "c", width: 164, height: 70 })),
      Story.model((model) => expect(model.charts.c).toMatchObject({
        hidden: ["desktop"],
        active: "mobile",
        hover: { x: 150, y: 200 },
        size: { width: 766, height: 511 },
        tooltip: { width: 164, height: 70 },
      })),
      Story.message(Message.ToggledChartSeries({ key: "c", series: "desktop" })),
      Story.message(Message.MovedOverChart({ key: "c", pointer: null })),
      Story.model((model) => {
        expect(model.charts.c?.hidden).toEqual([])
        expect(model.charts.c?.hover).toBeNull()
      }),
    )
  })
})
