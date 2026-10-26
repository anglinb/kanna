import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Scene, Story } from "foldkit/test"
import * as CopyButton from "./copy-button"

const idle = CopyButton.init({ id: "plan" })

describe("CopyButton", () => {
  test("copies its text, shows the check, and clears it after two seconds", () => {
    Story.story(
      CopyButton.update,
      Story.given(idle),
      Story.message(CopyButton.Message.ClickedCopy({ text: Option.some("npm i") })),
      Story.Command.expectExact(CopyButton.CopyText({ text: "npm i" })),
      Story.Command.resolve(CopyButton.CopyText, CopyButton.Message.CompletedCopyText({ didCopy: true })),
      Story.model((model) => expect(model.isCopied).toBe(true)),
      Story.Command.resolve(CopyButton.WaitCopiedFeedback, CopyButton.Message.ElapsedCopiedFeedback({ copyVersion: 1 })),
      Story.model((model) => expect(model.isCopied).toBe(false)),
    )
  })

  test("a failed copy shows nothing", () => {
    Story.story(
      CopyButton.update,
      Story.given(idle),
      Story.message(CopyButton.Message.ClickedCopy({ text: Option.some("npm i") })),
      Story.Command.resolve(CopyButton.CopyText, CopyButton.Message.CompletedCopyText({ didCopy: false })),
      Story.model((model) => expect(model.isCopied).toBe(false)),
    )
  })

  test("an older copy's timeout doesn't clear a newer check", () => {
    Story.story(
      CopyButton.update,
      Story.given({ ...idle, isCopied: true, copyVersion: 2 }),
      Story.message(CopyButton.Message.ElapsedCopiedFeedback({ copyVersion: 1 })),
      Story.model((model) => expect(model.isCopied).toBe(true)),
    )
  })

  test("without text, a click asks the parent", () => {
    Story.story(
      CopyButton.update,
      Story.given(idle),
      Story.message(CopyButton.Message.ClickedCopy({ text: Option.none() })),
      Story.expectOutMessage(CopyButton.OutMessage.RequestedCopy()),
      Story.Command.expectNone(),
    )
  })

  test("Scene: the title swaps to copiedTitle while copied", () => {
    const view = Scene.withViewInputs(CopyButton.view, { text: "ABCD", title: "Copy code", copiedTitle: "Copied" })
    Scene.scene(
      { update: CopyButton.update, view: view() },
      Scene.given(idle),
      Scene.click(Scene.role("button", { name: "Copy code" })),
      Scene.Command.resolve(CopyButton.CopyText, CopyButton.Message.CompletedCopyText({ didCopy: true })),
      Scene.expect(Scene.role("button", { name: "Copied" })).toHaveClass("hover:!bg-transparent"),
      Scene.Command.resolve(CopyButton.WaitCopiedFeedback, CopyButton.Message.ElapsedCopiedFeedback({ copyVersion: 1 })),
      Scene.expect(Scene.role("button", { name: "Copy code" })).toExist(),
    )
  })
})
