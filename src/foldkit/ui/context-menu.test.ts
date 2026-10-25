import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { inertHtml as ih } from "foldkit/html"
import { Scene, Story } from "foldkit/test"
import * as ContextMenu from "./context-menu"

const closed = ContextMenu.init({ id: "row" })

const sceneView = Scene.withViewInputs(ContextMenu.view, {
  items: [
    ContextMenu.item({ value: "rename" }),
    ContextMenu.item({ value: "fork", disabled: true }),
    ContextMenu.separator(),
    ContextMenu.item({ value: "archive" }),
  ],
  renderItem: (value) => [value.charAt(0).toUpperCase() + value.slice(1)],
  toView: ({ trigger, portal }) => ih.div([...trigger, ih.Role("row")], ["Port the UI", portal]),
})

describe("ContextMenu", () => {
  test("opens at the right-button press point", () => {
    Story.story(
      ContextMenu.update,
      Story.given(closed),
      Story.message(ContextMenu.Message.PressedTrigger({ pointerType: "mouse", button: 2, x: 120, y: 48 })),
      Story.message(ContextMenu.Message.RequestedContextMenu()),
      Story.expectOutMessage(ContextMenu.OutMessage.Opened()),
      Story.model((model) => {
        expect(model.phase).toBe("Open")
        expect(model.point).toEqual({ x: 120, y: 48 })
      }),
    )
  })

  test("a long touch press opens it; moving cancels", () => {
    Story.story(
      ContextMenu.update,
      Story.given(closed),
      Story.message(ContextMenu.Message.PressedTrigger({ pointerType: "touch", button: 0, x: 5, y: 6 })),
      Story.Command.expectExact(ContextMenu.WaitForLongPress({ version: 1 })),
      Story.Command.resolve(ContextMenu.WaitForLongPress, ContextMenu.Message.CompletedLongPress({ version: 1 })),
      Story.expectOutMessage(ContextMenu.OutMessage.Opened()),
      Story.model((model) => expect(model.point).toEqual({ x: 5, y: 6 })),
    )
    // Pressed (version 1's wait running), then the finger moved.
    Story.story(
      ContextMenu.update,
      Story.given({ ...closed, version: 1, longPressVersion: Option.some(1), pressedAt: Option.some({ x: 5, y: 6 }) }),
      Story.message(ContextMenu.Message.CancelledLongPress()),
      Story.message(ContextMenu.Message.CompletedLongPress({ version: 1 })),
      Story.model((model) => expect(model.phase).toBe("Closed")),
    )
  })

  test("choosing closes at once (no fade); Escape fades", () => {
    Story.story(
      ContextMenu.update,
      Story.given({ ...closed, phase: "Open", version: 1 }),
      Story.message(ContextMenu.Message.ChoseItem({ value: "archive" })),
      Story.expectOutMessage(ContextMenu.OutMessage.Selected({ value: "archive" })),
      Story.Command.expectNone(),
      Story.model((model) => expect(model.phase).toBe("Closed")),
    )
    Story.story(
      ContextMenu.update,
      Story.given({ ...closed, phase: "Open", version: 1 }),
      Story.message(ContextMenu.Message.DismissedContent()),
      Story.expectOutMessage(ContextMenu.OutMessage.Closed()),
      Story.Command.resolve(ContextMenu.WaitForExitAnimation, ContextMenu.Message.CompletedExitAnimation({ version: 1 })),
      Story.model((model) => expect(model.phase).toBe("Closed")),
    )
  })

  test("Scene: a menu of menuitems with a separator; a click chooses", () => {
    Scene.scene(
      { update: ContextMenu.update, view: sceneView() },
      Scene.given(closed),
      Scene.contextMenu(Scene.role("row")),
      Scene.Mount.resolve(ContextMenu.ContextMenuContent, ContextMenu.Message.CompletedMountContent()),
      Scene.expect(Scene.role("menu")).toHaveAttr("data-state", "open"),
      Scene.expect(Scene.role("row")).toHaveAttr("data-state", "open"),
      Scene.expect(Scene.role("menuitem", { name: "Fork" })).toBeDisabled(),
      Scene.expect(Scene.role("separator")).toExist(),
      Scene.click(Scene.role("menuitem", { name: "Archive" })),
      Scene.expectOutMessage(ContextMenu.OutMessage.Selected({ value: "archive" })),
      Scene.expect(Scene.role("menu")).toBeAbsent(),
      Scene.Mount.expectEnded(ContextMenu.ContextMenuContent),
    )
  })
})
