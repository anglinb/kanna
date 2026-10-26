import { describe, expect, test } from "bun:test"
import { inertHtml as ih } from "foldkit/html"
import { Scene, Story } from "foldkit/test"
import * as Popover from "./popover"

const closed = Popover.init({ id: "filter" })

const sceneView = Scene.withViewInputs(Popover.view, {
  align: "end",
  sideOffset: 8,
  content: () => [ih.button([ih.Type("button")], ["This Mac"])],
  toView: ({ trigger, portal }) => ih.button([...trigger, ih.AriaLabel("Filter projects")], ["Everything", portal]),
})

describe("Popover", () => {
  test("the trigger toggles it; closing waits for the exit fade", () => {
    Story.story(
      Popover.update,
      Story.given(closed),
      Story.message(Popover.Message.ClickedTrigger()),
      Story.expectOutMessage(Popover.OutMessage.Opened()),
      Story.model((model) => expect(model.phase).toBe("Open")),
      Story.message(Popover.Message.ClickedTrigger()),
      Story.expectOutMessage(Popover.OutMessage.Closed()),
      Story.Command.expectExact(Popover.WaitForExitAnimation({ id: "filter", version: 2 })),
      Story.Command.resolve(Popover.WaitForExitAnimation, Popover.Message.CompletedExitAnimation({ version: 2 })),
      Story.model((model) => expect(model.phase).toBe("Closed")),
    )
  })

  test("a stale exit (reopened during the fade) leaves it open", () => {
    Story.story(
      Popover.update,
      Story.given({ ...closed, phase: "Closing", version: 2 }),
      Story.message(Popover.Message.ClickedTrigger()),
      Story.message(Popover.Message.CompletedExitAnimation({ version: 2 })),
      Story.model((model) => expect(model.phase).toBe("Open")),
    )
  })

  test("Scene: the trigger's disclosure state, and dismissal from the content", () => {
    Scene.scene(
      { update: Popover.update, view: sceneView() },
      Scene.given(closed),
      Scene.expect(Scene.role("button", { name: "Filter projects" })).toHaveAttr("aria-expanded", "false"),
      Scene.expect(Scene.role("button", { name: "Filter projects" })).toHaveAttr("aria-haspopup", "dialog"),
      Scene.click(Scene.role("button", { name: "Filter projects" })),
      Scene.expect(Scene.role("button", { name: "Filter projects" })).toHaveAttr("aria-expanded", "true"),
      Scene.expect(Scene.role("button", { name: "Filter projects" })).toHaveAttr("data-state", "open"),
      Scene.expect(Scene.role("dialog")).toExist(),
      Scene.expect(Scene.role("dialog")).toHaveAttr("data-align", "end"),
      Scene.Mount.resolve(Popover.PopoverContent, Popover.Message.DismissedContent()),
      Scene.expect(Scene.role("dialog")).toHaveAttr("data-state", "closed"),
      Scene.Command.resolve(Popover.WaitForExitAnimation, Popover.Message.CompletedExitAnimation({ version: 2 })),
      Scene.expect(Scene.role("dialog")).toBeAbsent(),
      Scene.Mount.expectEnded(Popover.PopoverContent),
    )
  })

  test("close() from the parent is a no-op when it isn't open", () => {
    expect(Popover.close(closed)).toEqual({ model: closed })
  })
})
