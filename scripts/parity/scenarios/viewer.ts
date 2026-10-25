import type { Page } from "playwright"
import { defineScenario, type Scenario, type ScenarioContext } from "../scenario"
import { CHATS, click, openWidgets, parkPointer, press, quickClick, REGIONS, regions } from "./_lib/helpers"

// The diff viewer (Review changes): opened from the widget column, which is
// then closed so its polls stop (the viewer stays). Next/previous file by
// button and by J/K, unified and side by side, word wrap, full file,
// collapsing a file, where to open it, closing with Esc.

const desktop = { viewports: ["desktop" as const] }

function viewer(page: Page) {
  return page.locator(REGIONS.viewer)
}

/** Opens Review all, then hides the widget column so nothing polls. */
async function openReview(context: ScenarioContext, file?: string) {
  const { page } = context
  await openWidgets(context)
  const widgets = page.locator(REGIONS.widgets)
  if (file) await quickClick(context, widgets.getByText(file, { exact: true }).first())
  else await quickClick(context, widgets.getByRole("button", { name: "Review all" }))
  await quickClick(context, page.locator(REGIONS.navbar).getByRole("button", { name: "Hide widgets" }))
  await parkPointer(context)
}

export const scenarios: Scenario[] = [
  defineScenario({
    name: "viewer-review-all",
    route: CHATS.units,
    themes: ["dark", "light"],
    ...desktop,
    regions: regions("viewer"),
    covers: { commands: ["project.readDiffPatch"] },
    async run(context) {
      await openReview(context)
      await context.capture("open")
    },
  }),
  defineScenario({
    // A file row opens the review on that file.
    name: "viewer-open-one-file",
    route: CHATS.units,
    ...desktop,
    regions: regions("viewer"),
    covers: { commands: ["project.readDiffPatch"] },
    async run(context) {
      await openReview(context, "units.ts")
      await context.capture("open")
    },
  }),
  defineScenario({
    name: "viewer-next-previous",
    route: CHATS.units,
    ...desktop,
    regions: regions("viewer"),
    async run(context) {
      await openReview(context)
      await press(context, "j")
      await context.capture("second-file")
      await click(context, viewer(context.page).getByRole("button", { name: "Next (j)" }))
      await parkPointer(context)
      await context.capture("third-file")
      await press(context, "k")
      await context.capture("back-to-second")
    },
  }),
  defineScenario({
    name: "viewer-layout-toggles",
    route: CHATS.units,
    ...desktop,
    regions: regions("viewer"),
    async run(context) {
      await openReview(context)
      await click(context, viewer(context.page).getByRole("button", { name: "Side-by-side diff" }))
      await parkPointer(context)
      await context.capture("side-by-side")
      await click(context, viewer(context.page).getByRole("button", { name: "Enable word wrap" }))
      await parkPointer(context)
      await context.capture("wrapped")
    },
  }),
  defineScenario({
    name: "viewer-full-file-and-collapse",
    route: CHATS.units,
    ...desktop,
    regions: regions("viewer"),
    covers: { commands: ["project.readDiffPatch"] },
    async run(context) {
      const page = context.page
      await openReview(context)
      await click(context, viewer(page).getByRole("button", { name: "Show full file" }).first())
      await parkPointer(context)
      await context.capture("full-file")
      await click(context, viewer(page).getByRole("button", { name: "Collapse src/components/ForecastCard.tsx" }))
      await parkPointer(context)
      await context.capture("collapsed")
    },
  }),
  defineScenario({
    name: "viewer-open-in-list",
    route: CHATS.units,
    ...desktop,
    regions: regions("listbox"),
    async run(context) {
      await openReview(context)
      await click(context, viewer(context.page).getByRole("combobox", { name: "Choose where to open" }).first())
      await context.capture("open")
    },
  }),
  defineScenario({
    name: "viewer-open-in-editor",
    route: CHATS.units,
    ...desktop,
    regions: regions("viewer"),
    covers: { commands: ["system.openExternal"] },
    async run(context) {
      await openReview(context)
      await click(context, viewer(context.page).getByRole("button", { name: "Open in Cursor" }).first())
      await parkPointer(context)
      await context.capture("needs-machine")
    },
  }),
  defineScenario({
    name: "viewer-close-with-escape",
    route: CHATS.units,
    ...desktop,
    regions: regions("transcript"),
    async run(context) {
      await openReview(context)
      await press(context, "Escape")
      await parkPointer(context)
      await context.capture("closed")
    },
  }),
  defineScenario({
    name: "viewer-close-button",
    route: CHATS.units,
    ...desktop,
    async run(context) {
      await openReview(context)
      await click(context, viewer(context.page).getByRole("button", { name: "Close (Esc)" }))
      await parkPointer(context)
      await context.capture("closed")
    },
  }),
]
