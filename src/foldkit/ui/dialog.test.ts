import { describe, expect, test } from "bun:test"
import { inertHtml as ih, type HtmlBuilder } from "foldkit/html"
import { Scene, Story } from "foldkit/test"
import * as Dialog from "./dialog"

const closed = Dialog.init({ id: "pair" })
const open = Dialog.init({ id: "pair", isOpen: true })

const dialogView = Scene.withViewInputs(Dialog.view, {
  size: "sm",
  content: ({ titleId, descriptionId }) => [
    Dialog.dialogTitle({ id: titleId }, ["Pair a device"], ih),
    Dialog.dialogDescription({ id: descriptionId }, ["Scan the code."], ih),
  ],
})

// The dialog renders nothing while closed; Scene wants an element.
const sceneView = () => (model: Dialog.Model, h: HtmlBuilder<Dialog.Message>) => h.main([], [dialogView()(model, h)])

describe("Dialog", () => {
  test("open and close from the parent emit nothing; closing waits for the exit", () => {
    Story.story(
      Dialog.update,
      Story.given(closed),
      Story.model((model) => expect(Dialog.open(model).model.phase).toBe("Open")),
    )
    const closing = Dialog.close(open)
    expect(closing.model.phase).toBe("Closing")
    expect(closing.commands?.map((command) => command.name)).toEqual(["WaitForDialogExitAnimation"])
  })

  test("a dismissal (Escape, outside, X) emits Closed", () => {
    Story.story(
      Dialog.update,
      Story.given(open),
      Story.message(Dialog.Message.DismissedContent()),
      Story.expectOutMessage(Dialog.OutMessage.Closed()),
      Story.Command.resolve(Dialog.WaitForExitAnimation, Dialog.Message.CompletedExitAnimation({ version: 1 })),
      Story.model((model) => expect(model.phase).toBe("Closed")),
    )
  })

  test("Scene: labelled and described dialog with a Close button", () => {
    Scene.scene(
      { update: Dialog.update, view: sceneView() },
      Scene.given(open),
      Scene.expect(Scene.role("dialog")).toHaveAccessibleName("Pair a device"),
      Scene.expect(Scene.role("dialog")).toHaveAccessibleDescription("Scan the code."),
      Scene.expect(Scene.role("dialog")).toHaveAttr("data-state", "open"),
      Scene.expect(Scene.role("dialog")).toHaveClass("max-w-sm"),
      Scene.Mount.expectExact(Dialog.DialogContent),
      Scene.Mount.resolve(Dialog.DialogContent, Dialog.Message.DismissedContent()),
      Scene.expectOutMessage(Dialog.OutMessage.Closed()),
      Scene.Command.resolve(Dialog.WaitForExitAnimation, Dialog.Message.CompletedExitAnimation({ version: 1 })),
      Scene.expect(Scene.role("dialog")).toBeAbsent(),
      Scene.Mount.expectEnded(Dialog.DialogContent),
    )
  })

  test("Scene: the X button closes it", () => {
    Scene.scene(
      { update: Dialog.update, view: sceneView() },
      Scene.given(open),
      Scene.Mount.resolve(Dialog.DialogContent, Dialog.Message.CompletedMountContent()),
      Scene.click(Scene.role("button", { name: "Close" })),
      Scene.expectOutMessage(Dialog.OutMessage.Closed()),
      Scene.Command.resolve(Dialog.WaitForExitAnimation, Dialog.Message.CompletedExitAnimation({ version: 1 })),
      Scene.expect(Scene.role("dialog")).toBeAbsent(),
      Scene.Mount.expectEnded(Dialog.DialogContent),
    )
  })
})
