import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { inertHtml as ih } from "foldkit/html"
import { Scene, Story } from "foldkit/test"
import * as Select from "./select"

const closed = Select.init({ id: "mode" })

const sceneView = Scene.withViewInputs(Select.view, {
  value: "queue",
  grouped: true,
  items: [
    { value: "queue" },
    { value: "steer" },
    { value: "interrupt", disabled: true },
  ],
  renderItem: (value) => [value.charAt(0).toUpperCase() + value.slice(1)],
  toView: ({ trigger, value, portal }) => Select.selectTrigger({ attributes: [...trigger, ih.AriaLabel("Follow-up mode")] }, [value], portal, ih),
})

describe("Select", () => {
  test("an item is chosen once per opening: the click after a mouse release chooses nothing more", () => {
    const opened = Select.update(closed, Select.Message.PressedTrigger({ pointerType: "mouse", button: 0, x: 10, y: 12, disabled: false })).model
    const chosen = Select.update(opened, Select.Message.ChoseItem({ value: "steer", pointerType: "mouse" }))
    expect(chosen.outMessage).toEqual(Select.OutMessage.Selected({ value: "steer" }))
    const again = Select.update(chosen.model, Select.Message.ChoseItem({ value: "steer", pointerType: "touch" }))
    expect(again.outMessage).toBeUndefined()
  })

  test("a mouse press opens it; a touch press waits for the click", () => {
    Story.story(
      Select.update,
      Story.given(closed),
      Story.message(Select.Message.PressedTrigger({ pointerType: "touch", button: 0, x: 10, y: 10, disabled: false })),
      Story.model((model) => expect(model.phase).toBe("Closed")),
      Story.message(Select.Message.ClickedTrigger({ disabled: false })),
      Story.model((model) => {
        expect(model.phase).toBe("Open")
        expect(Option.isNone(model.openedAt)).toBe(true)
      }),
    )
    Story.story(
      Select.update,
      Story.given(closed),
      Story.message(Select.Message.PressedTrigger({ pointerType: "mouse", button: 0, x: 10, y: 12, disabled: false })),
      Story.model((model) => expect(Option.getOrNull(model.openedAt)).toEqual({ x: 10, y: 12 })),
      Story.message(Select.Message.ClickedTrigger({ disabled: false })),
      Story.model((model) => expect(model.phase).toBe("Open")),
    )
  })

  test("a disabled select doesn't open", () => {
    Story.story(
      Select.update,
      Story.given(closed),
      Story.message(Select.Message.PressedTrigger({ pointerType: "mouse", button: 0, x: 0, y: 0, disabled: true })),
      Story.message(Select.Message.ClickedTrigger({ disabled: true })),
      Story.model((model) => expect(model.phase).toBe("Closed")),
    )
  })

  test("choosing emits Selected and closes", () => {
    Story.story(
      Select.update,
      Story.given({ ...closed, phase: "Open", version: 1 }),
      Story.message(Select.Message.ChoseItem({ value: "steer", pointerType: "mouse" })),
      Story.expectOutMessage(Select.OutMessage.Selected({ value: "steer" })),
      Story.Command.resolve(Select.WaitForExitAnimation, Select.Message.CompletedExitAnimation({ version: 2 })),
      Story.model((model) => expect(model.phase).toBe("Closed")),
    )
  })

  test("Scene: combobox trigger, listbox with the chosen option checked, keyboard choice", () => {
    Scene.scene(
      { update: Select.update, view: sceneView() },
      Scene.given(closed),
      Scene.Mount.resolve(Select.SelectTrigger, Select.Message.CompletedMountTrigger()),
      Scene.expect(Scene.role("combobox", { name: "Follow-up mode" })).toHaveAttr("aria-expanded", "false"),
      Scene.expect(Scene.role("combobox", { name: "Follow-up mode" })).toHaveText("Queue"),
      Scene.keydown(Scene.role("combobox", { name: "Follow-up mode" }), "Enter"),
      Scene.expectHandled(),
      Scene.Mount.resolve(Select.SelectContent, Select.Message.CompletedMountContent()),
      Scene.expect(Scene.role("listbox")).toExist(),
      Scene.expect(Scene.role("option", { name: "Queue" })).toHaveAttr("data-state", "checked"),
      Scene.expect(Scene.role("option", { name: "Interrupt" })).toBeDisabled(),
      Scene.focus(Scene.role("option", { name: "Steer" })),
      Scene.expect(Scene.role("option", { name: "Steer" })).toHaveAttr("data-highlighted", ""),
      Scene.keydown(Scene.role("option", { name: "Steer" }), "Enter"),
      Scene.expectOutMessage(Select.OutMessage.Selected({ value: "steer" })),
      Scene.Command.resolve(Select.WaitForExitAnimation, Select.Message.CompletedExitAnimation({ version: 2 })),
      Scene.expect(Scene.role("listbox")).toBeAbsent(),
      Scene.Mount.expectEnded(Select.SelectContent),
    )
  })
})
