import type { Page } from "playwright"
import { defineScenario, type Scenario, type ScenarioContext } from "../scenario"
import { CHATS, click, hover, parkPointer, quietReadAnchor, reduceMotion, REGIONS, regions } from "./_lib/helpers"

// The transcript viewport around its rows: the minimap (a tick's card, a
// jump from it), the scroll-to-bottom button, a local link's right-click
// menu, and the standalone export viewer (its gallery page).

const desktop = { viewports: ["desktop" as const] }

function transcript(page: Page) {
  return page.locator(REGIONS.transcript)
}

/** The featured chat with its tool group open: long enough to scroll, so the minimap and the scroll button show. */
async function openToolGroup(context: ScenarioContext) {
  await click(context, transcript(context.page).getByRole("button", { name: "1 search, 2 reads, 4 edits, 2 writes, 1 command" }))
  await parkPointer(context)
  await quietReadAnchor(context)
}

/**
 * The scroll-to-bottom button. CSS: an icon button with no accessible name
 * in either app; its arrow is lucide's arrow-down in both.
 */
function scrollToBottomButton(page: Page) {
  return page.locator("button:has(> svg.lucide-arrow-down)")
}

export const scenarios: Scenario[] = [
  defineScenario({
    // Hovering the strip's tick brings up the turn's card; its reply jumps there.
    name: "transcript-minimap-jump",
    route: CHATS.units,
    ...desktop,
    regions: regions("transcript"),
    covers: { commands: ["chat.getToolEntries", "chat.setReadAnchor"] },
    async run(context) {
      await reduceMotion(context)
      await openToolGroup(context)
      await context.capture("strip")
      await hover(context, context.page.getByRole("button", { name: /^Jump to: / }).first())
      await context.capture("card")
      await click(context, context.page.getByRole("button", { name: "Jump to this reply" }))
      await parkPointer(context)
      await quietReadAnchor(context)
      await context.capture("jumped")
    },
  }),
  defineScenario({
    // Away from the end, the button comes up; pressing it goes back to the end.
    name: "transcript-scroll-to-bottom",
    route: CHATS.units,
    regions: regions("transcript"),
    covers: { commands: ["chat.getToolEntries", "chat.setReadAnchor"] },
    async run(context) {
      await reduceMotion(context)
      await openToolGroup(context)
      await context.capture("away")
      await click(context, scrollToBottomButton(context.page))
      await parkPointer(context)
      await quietReadAnchor(context)
      await context.capture("at-end")
    },
  }),
  defineScenario({
    // Where the reader left a chat is where it opens again: the position is
    // written (chat.setReadAnchor, with the offset into the row) and restored.
    name: "transcript-read-anchor-restore",
    route: CHATS.units,
    ...desktop,
    regions: regions("transcript"),
    covers: { commands: ["chat.setReadAnchor"] },
    async run(context) {
      const { page } = context
      await reduceMotion(context)
      await openToolGroup(context)
      // The reader's own scroll: a press in the transcript marks it theirs,
      // then one step down (set, not animated, so one scroll event).
      await transcript(page).dispatchEvent("pointerdown")
      await page.locator(REGIONS.transcript).evaluate((viewport) => {
        viewport.scrollTop = 260
      })
      await quietReadAnchor(context)
      await context.capture("scrolled")
      // Away to Settings and back through history: not through the sidebar's
      // chat rows, whose hover cards load previews as the pointer passes.
      await click(context, page.locator(REGIONS.sidebar).getByRole("button", { name: "Settings Connected" }))
      await quietReadAnchor(context)
      await page.goBack()
      await parkPointer(context)
      await quietReadAnchor(context)
      await context.capture("restored")
    },
  }),
  defineScenario({
    // A local file link's right-click menu: where to open it.
    name: "transcript-local-link-menu",
    route: CHATS.rateLimit,
    ...desktop,
    regions: regions("transcript", "menu"),
    async run(context) {
      await transcript(context.page).getByRole("link", { name: "src/middleware/rateLimit.ts" }).click({ button: "right" })
      await context.settle()
      await context.capture("open")
      // A press outside closes it. (Not Escape: React's menu stays up on
      // Escape here, focus in the menu or not; a bug to file, not to copy.)
      await context.page.mouse.click(1430, 450)
      await parkPointer(context)
      await context.capture("closed")
    },
  }),
  defineScenario({
    // A window of a longer chat: Load More lands the older turns in front of
    // the rows on screen without moving them; the minimap's tick for a turn
    // before the window loads until it and lands there.
    name: "transcript-window",
    route: "/__gallery/transcript-window",
    ...desktop,
    regions: regions("transcript"),
    async run(context) {
      const { page } = context
      await reduceMotion(context)
      await context.capture("opened")
      await click(context, transcript(page).getByRole("button", { name: "Load More" }))
      await parkPointer(context)
      await context.capture("older")
      await hover(context, page.getByRole("button", { name: "Jump to: Now add the tide chart's axis labels." }))
      await context.capture("card")
      await click(context, page.getByRole("button", { name: "Jump to this prompt" }))
      await parkPointer(context)
      await context.capture("jumped")
    },
  }),
  defineScenario({
    // The standalone export viewer, once its transcript has loaded: header,
    // read-only rows, the Try It banner; a tool group opened, then back to the end.
    name: "transcript-export-viewer",
    route: "/__gallery/transcript-export-viewer",
    regions: regions("transcript"),
    async run(context) {
      await reduceMotion(context)
      await context.capture("loaded")
      await click(context, transcript(context.page).getByRole("button", { name: /search, .*read/ }))
      await parkPointer(context)
      await context.capture("group-open")
      await click(context, scrollToBottomButton(context.page))
      await parkPointer(context)
      await context.capture("at-end")
    },
  }),
  defineScenario({
    // The export viewer's own viewer, over the whole page: a chart in the
    // export opens full size, and Escape closes it.
    name: "transcript-export-viewer-chart",
    route: "/__gallery/transcript-export-viewer?bundle=chart",
    regions: regions("viewer"),
    async run(context) {
      await reduceMotion(context)
      await click(context, context.page.getByTitle("Expand chart").first())
      await context.page.locator(REGIONS.viewer).first().waitFor()
      await parkPointer(context)
      await context.capture("chart-open")
      await context.page.keyboard.press("Escape")
      await context.page.locator(REGIONS.viewer).first().waitFor({ state: "hidden" })
      await parkPointer(context)
      await context.capture("closed")
    },
  }),
]
