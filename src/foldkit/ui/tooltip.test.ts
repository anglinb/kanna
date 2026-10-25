import { describe, expect, test } from "bun:test"
import { inertHtml as ih } from "foldkit/html"
import { Scene, Story } from "foldkit/test"
import * as Tooltip from "./tooltip"

const closed = Tooltip.init({ id: "fetch" })
const instant = Tooltip.init({ id: "fetch", delayDuration: 0 })

const sceneView = Scene.withViewInputs(Tooltip.view, {
  content: () => ["Fetched 2m ago"],
  side: "bottom",
  toView: ({ trigger, portal }) => ih.button([...trigger, ih.AriaLabel("Fetch")], ["Fetch", portal]),
})

describe("Tooltip", () => {
  test("a pointer visit opens after the delay, as delayed-open", () => {
    Story.story(
      Tooltip.update,
      Story.given(closed),
      Story.message(Tooltip.Message.MovedPointerOnTrigger()),
      Story.Command.expectExact(Tooltip.ResolveOpenTiming({ version: 1, delayDuration: 700 })),
      Story.Command.resolve(Tooltip.ResolveOpenTiming, Tooltip.Message.ResolvedOpenTiming({ version: 1, timing: "Delayed" })),
      Story.Command.resolve(Tooltip.AnnounceOpen, Tooltip.Message.CompletedAnnounceOpen()),
      Story.model((model) => {
        expect(model.phase).toBe("Open")
        expect(Tooltip.stateAttribute(model)).toBe("delayed-open")
      }),
    )
  })

  test("leaving the trigger before the delay ends cancels the open", () => {
    // The pointer arrived (version 1's delay is running), then left.
    Story.story(
      Tooltip.update,
      Story.given({ ...closed, hasPointerMoveOpened: true, timerVersion: 1 }),
      Story.message(Tooltip.Message.LeftTrigger()),
      Story.message(Tooltip.Message.ResolvedOpenTiming({ version: 1, timing: "Delayed" })),
      Story.Command.expectNone(),
      Story.model((model) => expect(model.phase).toBe("Closed")),
    )
  })

  test("within the provider's skip delay a visit opens at once, as instant-open", () => {
    Story.story(
      Tooltip.update,
      Story.given(closed),
      Story.message(Tooltip.Message.MovedPointerOnTrigger()),
      Story.Command.resolve(Tooltip.ResolveOpenTiming, Tooltip.Message.ResolvedOpenTiming({ version: 1, timing: "Instant" })),
      Story.Command.resolve(Tooltip.AnnounceOpen, Tooltip.Message.CompletedAnnounceOpen()),
      Story.model((model) => expect(Tooltip.stateAttribute(model)).toBe("instant-open")),
    )
  })

  test("focus opens at once, but not the focus a pointer press causes", () => {
    Story.story(
      Tooltip.update,
      Story.given(closed),
      Story.message(Tooltip.Message.PressedTrigger()),
      Story.message(Tooltip.Message.FocusedTrigger()),
      Story.Command.expectNone(),
      Story.model((model) => expect(model.phase).toBe("Closed")),
      Story.message(Tooltip.Message.ClickedTrigger()),
      Story.message(Tooltip.Message.BlurredTrigger()),
      Story.message(Tooltip.Message.FocusedTrigger()),
      Story.Command.resolve(Tooltip.AnnounceOpen, Tooltip.Message.CompletedAnnounceOpen()),
      Story.model((model) => expect(Tooltip.stateAttribute(model)).toBe("instant-open")),
    )
  })

  test("Scene: focus shows the content and its role=tooltip copy; Escape (dismissal) fades it out", () => {
    Scene.scene(
      { update: Tooltip.update, view: sceneView() },
      Scene.given(instant),
      Scene.expect(Scene.role("tooltip")).toBeAbsent(),
      Scene.focus(Scene.role("button", { name: "Fetch" })),
      Scene.Command.resolve(Tooltip.AnnounceOpen, Tooltip.Message.CompletedAnnounceOpen()),
      Scene.expect(Scene.role("tooltip")).toHaveText("Fetched 2m ago"),
      Scene.expect(Scene.role("button", { name: "Fetch" })).toHaveAttr("data-state", "instant-open"),
      Scene.expect(Scene.role("button", { name: "Fetch" })).toHaveAccessibleDescription("Fetched 2m ago"),
      Scene.Mount.expectExact(Tooltip.TooltipContent),
      Scene.Mount.resolve(Tooltip.TooltipContent, Tooltip.Message.DismissedContent()),
      Scene.Command.resolve(Tooltip.AnnounceClose, Tooltip.Message.CompletedAnnounceClose()),
      Scene.expect(Scene.role("button", { name: "Fetch" })).toHaveAttr("data-state", "closed"),
      Scene.expect(Scene.selector("[data-radix-popper-content-wrapper]")).toExist(),
      Scene.Command.resolve(Tooltip.WaitForExitAnimation, Tooltip.Message.CompletedExitAnimation({ version: 1 })),
      Scene.expect(Scene.role("tooltip")).toBeAbsent(),
      Scene.Mount.expectEnded(Tooltip.TooltipContent),
    )
  })

  test("hotkey content: the first shortcut as keys, or the label in capitals", () => {
    const keys = Tooltip.hotkeyContent({ shortcut: ["cmd+j", "ctrl+j"] }, ih)()
    expect(keys).toHaveLength(1)
    const label = Tooltip.hotkeyContent({ label: "Open in editor" }, ih)()
    expect(JSON.stringify(label)).toContain("OPEN IN EDITOR")
  })
})
