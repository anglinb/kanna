import type { Locator, Page } from "playwright"
import { defineScenario, type Scenario, type ScenarioContext } from "../scenario"
import { CHATS, click, composer, countUuids, openPalette, parkPointer, press, quietReadAnchor, reduceMotion, REGIONS, regions, rest, typeIntoComposer } from "./_lib/helpers"

// The viewer reached from a chat, without the widget column: links sent in a
// prompt render in its bubble, so a file link opens the file viewer (and
// from there the review of a changed file), and a chat link opens the
// previewer. Reduced motion throughout (see reduceMotion in _lib/helpers.ts):
// the pane opens at once, so the transcript's read position is written once.

const desktop = { viewports: ["desktop" as const] }

/** A changed file in tidepool (units.ts), and a chat to preview. */
const LINKS = "[units.ts](/Users/you/Projects/tidepool/src/lib/units.ts) and [deploy](/chat/demo-chat-deploy)"

function viewer(page: Page): Locator {
  return page.locator(REGIONS.viewer)
}

function bubbleLink(page: Page, name: string): Locator {
  return page.locator(REGIONS.transcript).getByRole("link", { name, exact: true }).first()
}

/**
 * Sends the prompt with the links, and waits for its bubble. The send moves
 * the transcript, and so does the pane opening beside it: each rides on a
 * chat.setReadAnchor written on a wall-clock throttle, so every step waits
 * that out (see quietReadAnchor in _lib/helpers.ts).
 *
 * On a desktop it is sent from a new chat in tidepool (the project with the
 * changes). In a long chat the pane narrowing the transcript re-wraps it
 * while it is scrolled to its end, and React's own read position lands
 * differently from run to run; a chat shorter than its column doesn't
 * scroll. On a phone the viewer covers the chat, which doesn't narrow.
 */
async function sendLinks(context: ScenarioContext) {
  await reduceMotion(context)
  if (context.viewport === "desktop") {
    await countUuids(context)
    await click(context, context.page.locator(REGIONS.sidebar).getByRole("button", { name: "New Chat" }))
    await parkPointer(context)
  }
  await quietReadAnchor(context)
  await typeIntoComposer(context, LINKS)
  // On a touch screen Enter is a new line; the send button sends.
  if (context.viewport === "mobile") await context.page.getByRole("button", { name: "Send message" }).click()
  else await composer(context.page).press("Enter")
  await rest(context)
  await quietReadAnchor(context)
}

/** A capture once the read position the last step moved has been written. */
async function quiet(context: ScenarioContext, label: string) {
  await quietReadAnchor(context)
  await context.capture(label)
}

async function openFile(context: ScenarioContext) {
  await sendLinks(context)
  await click(context, bubbleLink(context.page, "units.ts"))
  await parkPointer(context)
}

async function openReview(context: ScenarioContext) {
  await openFile(context)
  await click(context, viewer(context.page).getByRole("button", { name: "Show changes" }))
  await parkPointer(context)
}

export const scenarios: Scenario[] = [
  defineScenario({
    // A project file from a link: its text (unreadable in the demo) and,
    // since it has changes, the way to them.
    name: "viewer-file-from-link",
    route: CHATS.units,
    themes: ["dark", "light"],
    ...desktop,
    regions: regions("viewer"),
    covers: { commands: ["chat.send"] },
    async run(context) {
      await openFile(context)
      await quiet(context, "file")
    },
  }),
  defineScenario({
    // The file's changes: the review opens on it, among every changed file.
    name: "viewer-show-changes",
    route: CHATS.units,
    themes: ["dark", "light"],
    ...desktop,
    regions: regions("viewer"),
    covers: { commands: ["project.readDiffPatch"] },
    async run(context) {
      await openReview(context)
      await quiet(context, "review")
    },
  }),
  defineScenario({
    name: "viewer-review-steps",
    route: CHATS.units,
    ...desktop,
    regions: regions("viewer"),
    async run(context) {
      await openReview(context)
      await press(context, "k")
      await quiet(context, "previous")
      await click(context, viewer(context.page).getByRole("button", { name: "Previous (k)" }))
      await parkPointer(context)
      await quiet(context, "previous-again")
      await press(context, "j")
      await quiet(context, "next")
    },
  }),
  defineScenario({
    name: "viewer-review-toggles",
    route: CHATS.units,
    ...desktop,
    regions: regions("viewer"),
    covers: { commands: ["project.readDiffPatch"] },
    async run(context) {
      await openReview(context)
      await click(context, viewer(context.page).getByRole("button", { name: "Side-by-side diff" }))
      await parkPointer(context)
      await quiet(context, "split")
      await click(context, viewer(context.page).getByRole("button", { name: "Enable word wrap" }))
      await parkPointer(context)
      await quiet(context, "wrapped")
      await click(context, viewer(context.page).getByRole("button", { name: "Show full file" }).first())
      await parkPointer(context)
      await quiet(context, "full-file")
      await click(context, viewer(context.page).getByRole("button", { name: "Collapse src/components/ForecastCard.tsx" }))
      await parkPointer(context)
      await quiet(context, "collapsed")
    },
  }),
  defineScenario({
    // Expanded over the chat, back into the pane, then closed with Escape.
    name: "viewer-expand-and-close",
    route: CHATS.units,
    ...desktop,
    regions: regions("viewer"),
    async run(context) {
      await openFile(context)
      await click(context, viewer(context.page).getByRole("button", { name: "Expand" }))
      await parkPointer(context)
      await quiet(context, "expanded")
      await click(context, viewer(context.page).getByRole("button", { name: "Show chat" }))
      await parkPointer(context)
      await quiet(context, "docked")
      await press(context, "Escape")
      await parkPointer(context)
      await quiet(context, "closed")
    },
  }),
  defineScenario({
    // The review closes with its own button, back to the chat.
    name: "viewer-review-close",
    route: CHATS.units,
    ...desktop,
    async run(context) {
      await openReview(context)
      await click(context, viewer(context.page).getByRole("button", { name: "Close (Esc)" }))
      await parkPointer(context)
      await quiet(context, "closed")
    },
  }),
  defineScenario({
    // A chat link opens the chat itself beside this one, live, with its own composer.
    name: "viewer-chat-preview",
    route: CHATS.units,
    themes: ["dark", "light"],
    ...desktop,
    regions: regions("viewer"),
    covers: { commands: ["chat.send"] },
    async run(context) {
      await sendLinks(context)
      await click(context, bubbleLink(context.page, "deploy"))
      await parkPointer(context)
      await quiet(context, "preview")
    },
  }),
  defineScenario({
    // The previewed chat's own button takes it to the main view.
    name: "viewer-chat-preview-open",
    route: CHATS.units,
    ...desktop,
    async run(context) {
      await sendLinks(context)
      await click(context, bubbleLink(context.page, "deploy"))
      await parkPointer(context)
      await click(context, viewer(context.page).getByRole("button", { name: "Open chat" }))
      await parkPointer(context)
      await quiet(context, "opened")
    },
  }),
  defineScenario({
    // A delegator's page: its list of chats is the pane's floor. A chat
    // opened over it has a Back to the list, Escape steps back one level
    // (to the list), and Close shuts the pane from any level.
    name: "viewer-levels-delegator",
    route: CHATS.units,
    ...desktop,
    regions: regions("viewer"),
    covers: { commands: ["chat.create", "chat.rename", "chat.send"] },
    async run(context) {
      const { page } = context
      await reduceMotion(context)
      await openPalette(context)
      const palette = page.getByRole("dialog", { name: "Command Palette" })
      await palette.getByRole("combobox").pressSequentially("delegator")
      await click(context, palette.getByRole("option", { name: /^New Delegator in tidepool/ }).first())
      await page.getByPlaceholder("Name (optional)").fill("Release captain")
      await click(context, page.getByRole("button", { name: "Create" }))
      await click(context, page.locator(REGIONS.sidebar).getByText("Release captain", { exact: true }).first())
      await parkPointer(context)
      await quiet(context, "floor")
      await quietReadAnchor(context)
      await typeIntoComposer(context, LINKS)
      await composer(page).press("Enter")
      await rest(context)
      await quietReadAnchor(context)
      await click(context, bubbleLink(page, "deploy"))
      await parkPointer(context)
      await quiet(context, "over-floor")
      await press(context, "Escape")
      await parkPointer(context)
      await quiet(context, "back-to-floor")
      await click(context, viewer(page).getByRole("button", { name: "Close (Esc)" }))
      await parkPointer(context)
      await quiet(context, "shut")
    },
  }),
  defineScenario({
    // On a phone the viewer covers the chat, an inset card with four corners.
    name: "viewer-file-mobile",
    route: CHATS.units,
    viewports: ["mobile"],
    regions: regions("viewer"),
    async run(context) {
      await openFile(context)
      await quiet(context, "file")
    },
  }),
]
