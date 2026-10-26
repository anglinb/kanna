import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { type HtmlBuilder } from "foldkit/html"
import { Scene, Story } from "foldkit/test"
import * as AppDialog from "./app-dialog"
import * as Dialog from "./dialog"

const idle = AppDialog.init()

const deleteRequest = AppDialog.confirm({ requestId: "delete", title: "Delete project?", confirmLabel: "Delete", confirmVariant: "destructive" })
const renameRequest = AppDialog.prompt({ requestId: "rename", title: "Rename chat", initialValue: "Port the UI", resetLabel: "Use generated title", resetValue: "Primitives" })

const opened = (request: AppDialog.Request) => AppDialog.open(idle, request).model

// The dialog renders nothing while closed; Scene wants an element.
const sceneView = (model: AppDialog.Model, h: HtmlBuilder<AppDialog.Message>) =>
  h.main([], [h.submodel({ slotId: "app-dialog", model, view: AppDialog.view, toParentMessage: (message: AppDialog.Message) => message })])

describe("AppDialog", () => {
  test("a prompt opens with its initial value and focuses the field", () => {
    const result = AppDialog.open(idle, renameRequest)
    expect(result.model.inputValue).toBe("Port the UI")
    expect(Dialog.isOpen(result.model.dialog)).toBe(true)
    expect(result.commands?.map((command) => command.name)).toEqual(["FocusAppDialogInput"])
  })

  test("Enter confirms a confirm dialog", () => {
    Story.story(
      AppDialog.update,
      Story.given(opened(deleteRequest)),
      Story.message(AppDialog.Message.PressedEnter()),
      Story.expectOutMessage(AppDialog.OutMessage.Answered({ requestId: "delete", answer: { _tag: "Confirm", confirmed: true } })),
      Story.Command.resolve(Dialog.WaitForExitAnimation, Dialog.Message.CompletedExitAnimation({ version: 2 })),
      Story.model((model) => {
        expect(Option.isNone(model.request)).toBe(true)
        expect(model.dialog.phase).toBe("Closed")
      }),
    )
  })

  test("a prompt answers its trimmed text; reset puts the reset value in", () => {
    Story.story(
      AppDialog.update,
      Story.given(opened(renameRequest)),
      Story.message(AppDialog.Message.ChangedInput({ value: "  " })),
      Story.message(AppDialog.Message.ClickedConfirm()),
      Story.expectNoOutMessage(),
      Story.message(AppDialog.Message.ClickedReset()),
      Story.model((model) => expect(model.inputValue).toBe("Primitives")),
      Story.message(AppDialog.Message.ChangedInput({ value: "  New title " })),
      Story.message(AppDialog.Message.ClickedConfirm()),
      Story.expectOutMessage(AppDialog.OutMessage.Answered({ requestId: "rename", answer: { _tag: "Prompt", value: Option.some("New title") } })),
      Story.Command.resolve(Dialog.WaitForExitAnimation, Dialog.Message.CompletedExitAnimation({ version: 2 })),
    )
  })

  test("Escape (the dialog's own dismissal) answers cancel", () => {
    Story.story(
      AppDialog.update,
      Story.given(opened(renameRequest)),
      Story.message(AppDialog.Message.GotDialogMessage({ message: Dialog.Message.DismissedContent() })),
      Story.expectOutMessage(AppDialog.OutMessage.Answered({ requestId: "rename", answer: { _tag: "Prompt", value: Option.none() } })),
      Story.Command.resolve(Dialog.WaitForExitAnimation, Dialog.Message.CompletedExitAnimation({ version: 2 })),
    )
  })

  test("Scene: an alert hides Cancel and answers OK", () => {
    Scene.scene(
      { update: AppDialog.update, view: sceneView },
      Scene.given(opened(AppDialog.alert({ requestId: "about", title: "Up to date", description: "Version 0.68.0" }))),
      Scene.Mount.resolve(Dialog.DialogContent, Dialog.Message.CompletedMountContent()),
      Scene.expect(Scene.role("dialog")).toHaveAccessibleName("Up to date"),
      Scene.expect(Scene.role("dialog")).toHaveAccessibleDescription("Version 0.68.0"),
      Scene.expect(Scene.text("Cancel")).toHaveClass("hidden"),
      Scene.click(Scene.role("button", { name: "OK" })),
      Scene.expectOutMessage(AppDialog.OutMessage.Answered({ requestId: "about", answer: { _tag: "Alert" } })),
      Scene.Command.resolve(Dialog.WaitForExitAnimation, Dialog.Message.CompletedExitAnimation({ version: 2 })),
      Scene.expect(Scene.role("dialog")).toBeAbsent(),
      Scene.Mount.expectEnded(Dialog.DialogContent),
    )
  })

  test("Scene: an empty prompt disables Confirm", () => {
    Scene.scene(
      { update: AppDialog.update, view: sceneView },
      Scene.given(opened(AppDialog.prompt({ requestId: "name", title: "Name it" }))),
      Scene.Mount.resolve(Dialog.DialogContent, Dialog.Message.CompletedMountContent()),
      Scene.expect(Scene.role("button", { name: "Confirm" })).toBeDisabled(),
      Scene.type(Scene.role("textbox"), "Foldkit"),
      Scene.expect(Scene.role("button", { name: "Confirm" })).toBeEnabled(),
    )
  })
})
