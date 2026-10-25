import { describe, expect, test } from "bun:test"
import { inertHtml as ih } from "foldkit/html"
import { Scene, Story } from "foldkit/test"
import * as HoverCard from "./hover-card"

const closed = HoverCard.init({ id: "branch" })

const sceneView = Scene.withViewInputs(HoverCard.view, {
  content: () => [ih.p([], ["3 commits ahead"])],
  toView: ({ trigger, portal }) => ih.a([...trigger, ih.Href("#branch")], ["feat/ui", portal]),
})

describe("HoverCard", () => {
  test("opens after the open delay; leaving starts the close delay", () => {
    Story.story(
      HoverCard.update,
      Story.given(closed),
      Story.message(HoverCard.Message.EnteredTrigger()),
      Story.Command.expectExact(HoverCard.WaitOpenDelay({ version: 1, delay: 700 })),
      Story.Command.resolve(HoverCard.WaitOpenDelay, HoverCard.Message.ElapsedOpenDelay({ version: 1 })),
      Story.model((model) => expect(model.phase).toBe("Open")),
      Story.message(HoverCard.Message.LeftTrigger()),
      Story.Command.expectExact(HoverCard.WaitCloseDelay({ version: 2, delay: 300 })),
      Story.Command.resolve(HoverCard.WaitCloseDelay, HoverCard.Message.ElapsedCloseDelay({ version: 2 })),
      Story.Command.resolve(HoverCard.WaitForExitAnimation, HoverCard.Message.CompletedExitAnimation({ version: 2 })),
      Story.model((model) => expect(model.phase).toBe("Closed")),
    )
  })

  test("entering the card before the close delay ends keeps it open", () => {
    Story.story(
      HoverCard.update,
      Story.given({ ...closed, phase: "Open", timerVersion: 2 }),
      Story.message(HoverCard.Message.EnteredContent()),
      Story.Command.resolve(HoverCard.WaitOpenDelay, HoverCard.Message.ElapsedOpenDelay({ version: 3 })),
      Story.message(HoverCard.Message.ElapsedCloseDelay({ version: 2 })),
      Story.model((model) => expect(model.phase).toBe("Open")),
    )
  })

  test("text held in the card stops leaving from closing it", () => {
    Story.story(
      HoverCard.update,
      Story.given({ ...closed, phase: "Open", isHoldingContent: true }),
      Story.message(HoverCard.Message.LeftContent()),
      Story.Command.expectNone(),
    )
  })

  test("Scene: focus opens it after the delay; dismissal closes it", () => {
    Scene.scene(
      { update: HoverCard.update, view: sceneView() },
      Scene.given(closed),
      Scene.focus(Scene.role("link", { name: "feat/ui" })),
      Scene.Command.resolve(HoverCard.WaitOpenDelay, HoverCard.Message.ElapsedOpenDelay({ version: 1 })),
      Scene.expect(Scene.text("3 commits ahead")).toExist(),
      // In Scene the card is still inside the link (nothing portals a VNode tree).
      Scene.expect(Scene.selector('a[href="#branch"]')).toHaveAttr("data-state", "open"),
      Scene.Mount.resolve(HoverCard.HoverCardContent, HoverCard.Message.DismissedContent()),
      Scene.Command.resolve(HoverCard.WaitForExitAnimation, HoverCard.Message.CompletedExitAnimation({ version: 2 })),
      Scene.expect(Scene.text("3 commits ahead")).toBeAbsent(),
      Scene.Mount.expectEnded(HoverCard.HoverCardContent),
    )
  })
})
