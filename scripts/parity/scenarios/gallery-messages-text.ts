import type { Page } from "playwright"
import { defineScenario, type Scenario, type ScenarioContext } from "../scenario"

/**
 * Every viewport-height of a gallery page that scrolls in
 * `[data-gallery-scroll]` (#root clips), in overlapping steps so nothing
 * falls between two captures; then back to the top. Shared by the
 * gallery-messages-* scenarios.
 */
export async function captureScrolled({ page, capture, settle }: Pick<ScenarioContext, "page" | "capture" | "settle">, prefix = "scroll") {
  const { scrollHeight, clientHeight } = await page.evaluate(() => {
    const scroller = document.querySelector("[data-gallery-scroll]")!
    return { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight }
  })
  const step = clientHeight - 100
  for (let index = 0, top = 0; ; index++, top += step) {
    await scrollGallery(page, top)
    await capture(`${prefix}-${index}`)
    if (top + clientHeight >= scrollHeight) break
  }
  await scrollGallery(page, 0)
  await settle()
}

export function scrollGallery(page: Page, top: number) {
  return page.evaluate((y) => {
    document.querySelector("[data-gallery-scroll]")!.scrollTop = y
  }, top)
}

/**
 * Brings an element into the middle of the gallery's scroller, once what a
 * press just changed has been drawn (two frames: an app may draw on the next).
 */
export async function centerInGallery(page: Page, selector: string) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await page.evaluate((target) => {
    const element = document.querySelector(target)
    const scroller = document.querySelector("[data-gallery-scroll]")!
    if (!element) return
    const box = element.getBoundingClientRect()
    const frame = scroller.getBoundingClientRect()
    scroller.scrollTop += box.top - frame.top - Math.max(0, (frame.height - box.height) / 2)
  }, selector)
}

// src/foldkit/transcript/messages against the React rows on prompts,
// answers, session and turn rows, messages sent by others, and the footer
// (processing, usage-limit resume, queued, draining): every scroll step,
// then the presses that change a row (a folded prompt, a system row's
// sections, a queued message's buttons, a resume, Stop).
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-messages-text",
    route: "/__gallery/messages-text",
    async run(context) {
      const { page, capture, settle } = context
      await captureScrolled(context)

      // The system row opens, then its sections.
      const session = page.getByRole("region", { name: "Session" })
      await page.locator("[data-transcript-row-id='sys-1'] button").first().click()
      await session.getByRole("button", { name: /Tools/ }).click()
      await session.getByRole("button", { name: /MCP Servers/ }).click()
      await centerInGallery(page, "[data-transcript-row-id='sys-1']")
      await capture("system-open")
      await session.getByRole("button", { name: /Raw Message/ }).click()
      await capture("system-raw")

      // A long prompt opens from Show more, and from its bubble.
      const prompts = page.getByRole("region", { name: "Prompts" })
      await centerInGallery(page, "[data-transcript-row-id='user-3']")
      await prompts.getByRole("button", { name: "Show more" }).hover()
      await capture("prompt-show-more-hover")
      await prompts.getByRole("button", { name: "Show more" }).click()
      await settle()
      await capture("prompt-open")
      await prompts.getByRole("button", { name: "Show less" }).click()
      await settle()
      await capture("prompt-closed")

      // The summary and the account row open.
      const answers = page.getByRole("region", { name: "Answers" })
      await answers.getByRole("button", { name: /Summarized/ }).click()
      await centerInGallery(page, "[data-transcript-row-id='cs-1']")
      await capture("summary-open")

      // The footer's presses.
      const footer = page.getByRole("region", { name: "Footer" })
      await centerInGallery(page, "[aria-label='Footer']")
      await footer.getByRole("button", { name: "Send now" }).first().hover()
      await capture("queued-hover")
      await footer.getByRole("button", { name: "Send now" }).first().click()
      await capture("queued-send-now")
      await footer.getByRole("button", { name: "Remove from queue" }).first().click()
      await capture("queued-remove")
      await footer.getByRole("button", { name: /Continue now/ }).click()
      await capture("resume-now")
      await footer.getByRole("button", { name: "Stop" }).click({ force: true })
      await capture("stop")
    },
  }),
]
