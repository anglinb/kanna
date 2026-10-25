import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/markdown against react-markdown and the transcript's
// TranscriptMarkdown, on the fixtures in src/foldkit/markdown/fixture.ts:
// every viewport-height of the page, then the copy button (hover, copied)
// and a local file link (click, right-click).
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-markdown",
    route: "/__gallery/markdown",
    async run({ page, capture, settle }) {
      // The page scrolls inside the gallery's own container: #root clips.
      const scrollTo = (top: number) => page.evaluate((y) => {
        document.querySelector("[data-gallery-scroll]")!.scrollTop = y
      }, top)
      const { scrollHeight, clientHeight } = await page.evaluate(() => {
        const scroller = document.querySelector("[data-gallery-scroll]")!
        return { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight }
      })
      // Overlapping steps, so nothing falls between two captures.
      const step = clientHeight - 100
      for (let index = 0, top = 0; ; index++, top += step) {
        await scrollTo(top)
        await capture(`scroll-${index}`)
        if (top + clientHeight >= scrollHeight) break
      }
      await scrollTo(0)
      await settle()

      const transcript = page.getByRole("region", { name: "Transcript" })
      await transcript.getByText("console.log(greeting)").hover()
      await capture("code-hover")
      await transcript.getByRole("button").first().click()
      await capture("code-copied")
      // Let the copied check lapse (two seconds) in both before going on.
      await page.waitForTimeout(2500)
      await settle()

      await transcript.getByRole("link", { name: "line and column" }).click()
      await capture("local-link-click")
      await transcript.getByRole("link", { name: "suffix line" }).click({ button: "right" })
      await capture("local-link-contextmenu")
    },
  }),
]
