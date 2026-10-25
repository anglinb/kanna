import type { Page } from "playwright"
import { defineScenario, type Scenario } from "../scenario"
import { captureScrolled, centerInGallery } from "./gallery-messages-text"

/** Moves the pointer to a point of a chart's plot, `x`/`y` as fractions of its box. */
async function pointAt(page: Page, chart: number, x: number, y: number) {
  const surface = page.locator(".chart-card").nth(chart).locator("svg.recharts-surface")
  const box = (await surface.boundingBox())!
  await page.mouse.move(Math.round(box.x + box.width * x), Math.round(box.y + box.height * y))
}

// src/foldkit/transcript/messages against the React rows on display tools:
// attachments (one image, a strip that scrolls, files that wrap, a preview
// that fails, waiting, failed), and charts (bar, stacked bar, line, area,
// pie, empty), and visualizations that can't load: every scroll step, then
// a strip's hover and scroll, a click on an attachment (the page stays), each
// chart's tooltip, a legend's hover (the others mute) and toggle (the series
// goes and the axis rescales).
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-messages-display",
    route: "/__gallery/messages-display",
    async run(context) {
      const { page, capture, settle } = context
      await captureScrolled(context)

      await centerInGallery(page, "[data-transcript-row-id='att-many']")
      await page.locator("[data-transcript-row-id='att-many'] figure").first().hover()
      await capture("strip-hover")
      await page.locator("[data-transcript-row-id='att-many'] .attachments-scroller").evaluate((element) => { element.scrollLeft = 200 })
      await settle()
      await capture("strip-scrolled")
      // A plain click opens the viewer (none on a gallery page), not the link.
      await page.locator("[data-transcript-row-id='att-one'] a").first().click()
      await settle()
      await capture("attachment-clicked")

      const charts = [
        { id: "chart-0", x: 0.2, y: 0.4 },
        { id: "chart-1", x: 0.9, y: 0.1 },
        { id: "chart-2", x: 0.35, y: 0.5 },
        { id: "chart-3", x: 0.6, y: 0.3 },
        { id: "chart-4", x: 0.42, y: 0.25 },
      ]
      for (const [index, chart] of charts.entries()) {
        await centerInGallery(page, `[data-transcript-row-id='${chart.id}']`)
        await pointAt(page, index, chart.x, chart.y)
        await settle()
        await capture(`${chart.id}-tooltip`)
      }

      // The legend: hover mutes the other series, a click hides this one.
      await centerInGallery(page, "[data-transcript-row-id='chart-0']")
      const legend = page.locator(".chart-card").first().locator(".chart-legend button")
      await legend.first().hover()
      await capture("legend-hover")
      await legend.first().click()
      await page.mouse.move(5, 5)
      await settle()
      await capture("legend-hidden")
      await pointAt(page, 0, 0.5, 0.5)
      await settle()
      await capture("legend-hidden-tooltip")

      await centerInGallery(page, "[data-transcript-row-id='chart-4']")
      await page.locator(".chart-card").nth(4).locator(".chart-legend button").nth(1).click()
      await page.mouse.move(5, 5)
      await settle()
      await capture("pie-hidden")
    },
  }),
]
