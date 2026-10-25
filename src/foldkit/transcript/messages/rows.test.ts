import { describe, expect, test } from "bun:test"
import { Scene } from "foldkit/test"
import { displaySections, questionSections, textSections, toolSections, type GallerySection } from "./fixture"
import { AdvanceQuestion, init, Message, OutMessage, update } from "./model"
import type { TranscriptRow } from "./rows"
import { VisualizationFrame } from "./visualization"
import { AppAction } from "../../app/action"
import * as Stores from "../../app/stores"
import * as Viewer from "../../core/stores/viewer"
import { view, type ViewInputs } from "./index"

function row(sections: ReadonlyArray<GallerySection>, id: string): TranscriptRow {
  const found = sections.flatMap((section) => section.rows).find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no row ${id}`)
  return found
}

const rowView = (target: TranscriptRow, inputs: Partial<ViewInputs> = {}) =>
  Scene.withViewInputs(view, { item: { kind: "row", row: target }, ...inputs })()

describe("tool rows", () => {
  test("a call opens to its input and result, and closes again", () => {
    const bash = row(toolSections(), "bash-1")
    Scene.scene(
      { update, view: rowView(bash) },
      Scene.given(init()),
      Scene.expect(Scene.role("button", { name: "Run the socket tests" })).toExist(),
      Scene.expect(Scene.text("Command")).not.toExist(),
      Scene.click(Scene.role("button", { name: "Run the socket tests" })),
      Scene.expect(Scene.text("bun test src/socket.test.ts")).toExist(),
      Scene.expect(Scene.text("timeout: 120000ms")).toExist(),
      Scene.expect(Scene.text("background")).toExist(),
      Scene.expect(Scene.text("12 pass", { exact: false })).toExist(),
      Scene.click(Scene.role("button", { name: "Run the socket tests" })),
      Scene.expect(Scene.text("bun test src/socket.test.ts")).not.toExist(),
    )
  })

  test("an edit opens to its diff", () => {
    const edit = row(toolSections(), "edit-1")
    Scene.scene(
      { update, view: rowView(edit) },
      Scene.given(init()),
      Scene.click(Scene.role("button", { name: "Edit src/app.ts" })),
      Scene.expect(Scene.text("  return Effect.log(\"hello, world\")")).toExist(),
      Scene.expect(Scene.text("export const version = 2")).toExist(),
    )
  })

  test("a folded run names what it holds and opens to every call", () => {
    const run = row(toolSections(), "g1-a")
    Scene.scene(
      { update, view: rowView(run) },
      Scene.given(init()),
      Scene.expect(Scene.role("button", { name: "2 reads, 1 search" })).toHaveAttr("aria-expanded", "false"),
      Scene.click(Scene.role("button", { name: "2 reads, 1 search" })),
      Scene.expect(Scene.role("button", { name: "2 reads, 1 search" })).toHaveAttr("aria-expanded", "true"),
      Scene.expect(Scene.role("button", { name: "Read src/a.ts" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Read src/b.ts" })).toExist(),
    )
  })
})

describe("AskUserQuestion", () => {
  test("pick, move on, pick several, submit: the answers go to the host", () => {
    const ask = row(questionSections(), "ask-live")
    Scene.scene(
      { update, view: rowView(ask) },
      Scene.given(init()),
      Scene.expect(Scene.text("1 of 2")).toExist(),
      Scene.click(Scene.text("Memoize the row")),
      Scene.Command.resolve(AdvanceQuestion, Message.AdvancedQuestion({ toolId: "t-ask-live", index: 1 })),
      Scene.expect(Scene.text("Which platforms should I test?")).toExist(),
      Scene.click(Scene.text("macOS")),
      Scene.click(Scene.text("Linux")),
      Scene.click(Scene.role("button", { name: "Submit" })),
      Scene.expectOutMessage(OutMessage.SubmittedAskUserQuestion({
        toolUseId: "t-ask-live",
        questions: (ask.kind === "single" && ask.message.kind === "tool" && ask.message.toolKind === "ask_user_question" ? ask.message.input.questions : []),
        answers: { "Which approach should I take for the flicker fix?": ["Memoize the row"], "Which platforms should I test?": ["macOS", "Linux"] },
      })),
      Scene.expect(Scene.text("macOS, Linux")).toExist(),
    )
  })

  test("Submit stays disabled until every question has an answer", () => {
    const ask = row(questionSections(), "ask-live")
    Scene.scene(
      { update, view: rowView(ask) },
      Scene.given({ ...init(), questions: { "t-ask-live": { currentIndex: 1, answers: {}, customInputs: {}, submitted: null } } }),
      Scene.expect(Scene.role("button", { name: "Submit" })).toBeDisabled(),
    )
  })

  test("a question that isn't the latest only says so", () => {
    const stale = row(questionSections(), "ask-stale")
    Scene.scene(
      { update, view: rowView(stale) },
      Scene.given(init()),
      Scene.expect(Scene.text("Questions pending (newer question active)")).toExist(),
    )
  })
})

describe("ExitPlanMode", () => {
  test("Approve & Clear and Approve go to the host; a finished plan says how it ended", () => {
    const plan = row(questionSections(), "plan-live")
    Scene.scene(
      { update, view: rowView(plan) },
      Scene.given(init()),
      Scene.click(Scene.role("button", { name: "Approve & Clear" })),
      Scene.expectOutMessage(OutMessage.ConfirmedExitPlanMode({ toolUseId: "t-plan-live", confirmed: true, clearContext: true })),
      Scene.click(Scene.role("button", { name: "Approve" })),
      Scene.expectOutMessage(OutMessage.ConfirmedExitPlanMode({ toolUseId: "t-plan-live", confirmed: true })),
    )
    const adjusted = row(questionSections(), "plan-adjusted")
    Scene.scene(
      { update, view: rowView(adjusted) },
      Scene.given(init()),
      Scene.expect(Scene.text("Adjusted: \"Test on Linux too\"")).toExist(),
    )
  })

  test("in an export a live plan is only pending", () => {
    const plan = row(questionSections(), "plan-live")
    Scene.scene(
      { update, view: rowView(plan, { options: { readonly: true } }) },
      Scene.given(init()),
      Scene.expect(Scene.text("Plan pending in original session")).toExist(),
      Scene.expect(Scene.role("button", { name: "Approve" })).not.toExist(),
    )
  })
})

describe("session and turn rows", () => {
  test("the first system row opens to its tools, MCP servers and raw message", () => {
    const system = row(textSections("http://localhost"), "sys-1")
    Scene.scene(
      { update, view: rowView(system) },
      Scene.given(init()),
      Scene.click(Scene.first(Scene.all.role("button"))),
      Scene.expect(Scene.text("claude-opus-4-1")).toExist(),
      Scene.click(Scene.text("MCP Servers")),
      Scene.expect(Scene.text("spawn ENOENT")).toExist(),
      Scene.click(Scene.role("button", { name: "Raw Message" })),
      Scene.expect(Scene.text("\"subtype\":\"init\"", { exact: false })).toExist(),
    )
  })

  test("a failed result shows its error; a successful one only its time", () => {
    const sections = textSections("http://localhost")
    Scene.scene(
      { update, view: rowView(row(sections, "result-2")) },
      Scene.given(init()),
      Scene.expect(Scene.text("API Error: 529 overloaded")).toExist(),
    )
    expect(() => Scene.scene(
      { update, view: rowView(row(sections, "result-1")) },
      Scene.given(init()),
      Scene.expect(Scene.text("Done")).toExist(),
    )).toThrow()
  })
})

describe("visualizations", () => {
  test("the frame holds its declared height while loading, then draws the page, with Expand once loaded", () => {
    const sections = displaySections("http://localhost")
    const viz = row(sections, "viz-missing")
    Scene.scene(
      { update, view: rowView(viz) },
      Scene.given(init()),
      Scene.expect(Scene.text("Loading visualization...")).toExist(),
      Scene.Mount.resolve(VisualizationFrame, Message.GotFrameDocument({ key: "viz-missing", document: "<html></html>" })),
      Scene.expect(Scene.selector("iframe[title='Flicker timeline']")).toHaveAttr("sandbox", "allow-scripts"),
      Scene.expect(Scene.role("button", { name: "Expand" })).not.toExist(),
    )
    Scene.scene(
      { update, view: rowView(viz) },
      // Measured before at this width: the frame starts there.
      Scene.given({ ...init(), frames: { "viz-missing": { document: "<html></html>", failed: false, width: 600, measured: null, known: [[608, 320]], loaded: false } } }),
      Scene.Mount.resolve(VisualizationFrame, Message.LoadedFrame({ key: "viz-missing" })),
      Scene.click(Scene.role("button", { name: "Expand" })),
      Scene.expectOutMessage(OutMessage.RequestedAppAction({
        action: AppAction.Store({ message: Stores.Message.GotViewerMessage({ message: Viewer.Message.OpenedItem({ item: { kind: "visualization", artifact: { type: "visualization", version: 1, title: "Flicker timeline", url: "/api/chats/demo/media/visualization-flicker.html", height: 240 } as never }, expanded: true, byKey: false }) }) }),
      })),
    )
  })

  test("a document that won't load says so; one from elsewhere is unavailable", () => {
    const sections = displaySections("http://localhost")
    Scene.scene(
      { update, view: rowView(row(sections, "viz-missing")) },
      Scene.given({ ...init(), frames: { "viz-missing": { document: null, failed: true, width: null, measured: null, known: [], loaded: false } } }),
      Scene.expect(Scene.role("alert")).toHaveText("This visualization could not be loaded."),
    )
    Scene.scene(
      { update, view: rowView(row(sections, "viz-bad")) },
      Scene.given(init()),
      Scene.expect(Scene.role("alert")).toHaveText("Visualization unavailable."),
    )
  })
})
