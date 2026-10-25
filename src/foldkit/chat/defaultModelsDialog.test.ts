import { describe, expect, test } from "bun:test"
import * as Dialog from "../ui/dialog"
import * as DefaultModelsDialog from "./defaultModelsDialog"

// The Default Models dialog edits a draft and saves on Done or a dismissal,
// dropping rows that never got a model id.

const saved = [{ label: "Kimi", id: "moonshot/kimi-k2" }]

describe("DefaultModelsDialog", () => {
  test("opens on a copy of the saved list; typing in the blank row appends", () => {
    const opened = DefaultModelsDialog.open(DefaultModelsDialog.init(), saved).model
    expect(opened.dialog.phase).toBe("Open")
    expect(opened.draft).toEqual(saved)
    const typed = DefaultModelsDialog.update(opened, DefaultModelsDialog.Message.ChangedField({ index: 1, field: "label", value: "GLM" })).model
    expect(typed.draft).toEqual([...saved, { label: "GLM", id: "" }])
  })

  test("Done saves the rows with an id and closes", () => {
    const opened = DefaultModelsDialog.open(DefaultModelsDialog.init(), saved).model
    const typed = DefaultModelsDialog.update(opened, DefaultModelsDialog.Message.ChangedField({ index: 1, field: "label", value: "half-filled" })).model
    const done = DefaultModelsDialog.update(typed, DefaultModelsDialog.Message.ClickedDone())
    expect(done.model.dialog.phase).toBe("Closing")
    expect(done.outMessage).toEqual(DefaultModelsDialog.OutMessage.Saved({ faveModels: saved }))
  })

  test("a dismissal saves too; a removed row is gone", () => {
    const opened = DefaultModelsDialog.open(DefaultModelsDialog.init(), saved).model
    const removed = DefaultModelsDialog.update(opened, DefaultModelsDialog.Message.ClickedRemove({ index: 0 })).model
    const dismissed = DefaultModelsDialog.update(removed, DefaultModelsDialog.Message.GotDialogMessage({ message: Dialog.Message.DismissedContent() }))
    expect(dismissed.outMessage).toEqual(DefaultModelsDialog.OutMessage.Saved({ faveModels: [] }))
  })
})
