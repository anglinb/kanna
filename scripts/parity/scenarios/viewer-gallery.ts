import { defineScenario, type Scenario } from "../scenario"
import { click, parkPointer, REGIONS, regions } from "./_lib/helpers"

// The viewer on its own (gallery/viewer.tsx and gallery/viewer.ts), as a
// page without a chat shows it, on each kind of thing it opens: an image, a
// markdown file (rendered and as text), a CSV as a table (sorted), JSON, a
// log, a file it can't preview, a chart and a visualization at full size.

const desktop = { viewports: ["desktop" as const] }

const route = (item: string) => `/__gallery/viewer?item=${item}`

function shown(name: string, item: string, themes: Array<"dark" | "light"> = ["dark", "light"]): Scenario {
  return defineScenario({
    name,
    route: route(item),
    themes,
    ...desktop,
    regions: regions("viewer"),
    async run(context) {
      await parkPointer(context)
      await context.capture("open")
    },
  })
}

export const scenarios: Scenario[] = [
  shown("viewer-gallery-image", "image"),
  shown("viewer-gallery-markdown", "markdown"),
  shown("viewer-gallery-csv", "csv"),
  shown("viewer-gallery-json", "json", ["dark"]),
  shown("viewer-gallery-text", "text", ["dark"]),
  shown("viewer-gallery-external", "external", ["dark"]),
  shown("viewer-gallery-chart", "chart"),
  shown("viewer-gallery-pie", "pie", ["light"]),
  shown("viewer-gallery-visualization", "visualization"),
  defineScenario({
    // Preview / Original: the text as it is, and back to the rendered page.
    name: "viewer-gallery-markdown-original",
    route: route("markdown"),
    ...desktop,
    regions: regions("viewer"),
    async run(context) {
      const viewer = context.page.locator(REGIONS.viewer)
      await click(context, viewer.getByRole("radio", { name: "Original" }))
      await parkPointer(context)
      await context.capture("original")
      await click(context, viewer.getByRole("radio", { name: "Preview" }))
      await parkPointer(context)
      await context.capture("preview")
    },
  }),
  defineScenario({
    // A header click sorts its column: ascending, descending, then the file's order.
    name: "viewer-gallery-csv-sort",
    route: route("csv"),
    ...desktop,
    regions: regions("viewer"),
    async run(context) {
      const viewer = context.page.locator(REGIONS.viewer)
      await click(context, viewer.getByRole("button", { name: "height_m" }))
      await parkPointer(context)
      await context.capture("ascending")
      await click(context, viewer.getByRole("button", { name: "height_m" }))
      await parkPointer(context)
      await context.capture("descending")
      await click(context, viewer.getByRole("radio", { name: "Original" }))
      await parkPointer(context)
      await context.capture("original")
    },
  }),
  defineScenario({
    // The close button: nothing open, nothing left.
    name: "viewer-gallery-close",
    route: route("image"),
    ...desktop,
    async run(context) {
      await click(context, context.page.locator(REGIONS.viewer).getByRole("button", { name: "Close (Esc)" }))
      await parkPointer(context)
      await context.capture("closed")
    },
  }),
  defineScenario({
    // Escape closes it from anywhere.
    name: "viewer-gallery-escape",
    route: route("chart"),
    ...desktop,
    async run(context) {
      await context.page.keyboard.press("Escape")
      await parkPointer(context)
      await context.capture("closed")
    },
  }),
  defineScenario({
    // Download image: the dialog that names the file.
    name: "viewer-gallery-visualization-download",
    route: route("visualization"),
    ...desktop,
    regions: regions("dialog"),
    async run(context) {
      await click(context, context.page.locator(REGIONS.viewer).getByRole("button", { name: "Download image" }))
      await context.capture("dialog")
    },
  }),
]
