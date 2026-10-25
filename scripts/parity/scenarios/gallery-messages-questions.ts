import { defineScenario, type Scenario } from "../scenario"
import { captureScrolled, centerInGallery } from "./gallery-messages-text"

// src/foldkit/transcript/messages against the React rows on AskUserQuestion
// and ExitPlanMode: every state on the page, then answering the live
// questions (a single pick that moves on by itself, a multi-select, a typed
// answer, Back, Submit) and deciding the live plan (Suggest Edits with Enter,
// Escape, Approve & Clear), and a finished plan's Show More.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-messages-questions",
    route: "/__gallery/messages-questions",
    async run(context) {
      const { page, capture, settle } = context
      await captureScrolled(context)

      const live = page.locator("[data-transcript-row-id='ask-live']")
      await centerInGallery(page, "[data-transcript-row-id='ask-live']")
      await live.getByRole("button", { name: /Memoize the row/ }).hover()
      await capture("question-hover")
      await live.getByRole("button", { name: /Memoize the row/ }).click()
      // The single pick moves on after 150ms.
      await page.waitForTimeout(400)
      await settle()
      await capture("question-advanced")
      await live.getByRole("button", { name: /macOS/ }).click()
      await live.getByRole("button", { name: /Windows/ }).click()
      await capture("question-multi")
      await live.getByRole("textbox", { name: "Which platforms should I test?" }).fill("BSD")
      await capture("question-typed")
      await live.locator("h3 button").click()
      await capture("question-back")
      await live.getByRole("button", { name: /Drop the observer/ }).click()
      await page.waitForTimeout(400)
      await settle()
      await live.getByRole("button", { name: "Submit" }).click()
      await capture("question-submitted")

      const plan = page.locator("[data-transcript-row-id='plan-live']")
      await centerInGallery(page, "[data-transcript-row-id='plan-live'] button")
      await plan.getByRole("button", { name: "Suggest Edits" }).click()
      await capture("plan-editing")
      await page.keyboard.type("Test on Linux too")
      await capture("plan-draft")
      await page.keyboard.press("Enter")
      await capture("plan-adjusted")
      await page.keyboard.press("Escape")
      await capture("plan-escaped")
      await plan.getByRole("button", { name: "Approve & Clear" }).click()
      await capture("plan-approved")

      const done = page.locator("[data-transcript-row-id='plan-approved']")
      await centerInGallery(page, "[data-transcript-row-id='plan-approved']")
      await done.hover()
      await capture("plan-done-hover")
      await done.getByRole("button", { name: "Show More" }).click()
      await capture("plan-done-open")
    },
  }),
]
