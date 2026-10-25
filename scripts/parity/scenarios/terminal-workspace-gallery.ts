import type { Page } from "playwright"
import { defineScenario, type Scenario } from "../scenario"

// The chat page's terminal workspace on its own (gallery/terminal-workspace):
// one project's shells, Add's hotkey tooltip, a split and its output,
// closing the split, and the only pane's X hiding the panel. The chat page
// around it is covered by terminal.ts once the chat shell is ported.
//
// As in terminal-page.ts: the demo's null terminal snapshot races a new
// pane's terminal.create (one create or two, run to run), so those frames
// are addressed to no subscription here.

const REGION = { workspace: "[data-terminal-visual]" }

async function open(page: Page, settle: () => Promise<void>) {
  await page.addInitScript(() => {
    const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")!
    Object.defineProperty(MessageEvent.prototype, "data", {
      configurable: true,
      get(this: MessageEvent) {
        const value = data.get!.call(this) as unknown
        if (typeof value !== "string") return value
        return value.includes("\"snapshot\":{\"type\":\"terminal\",\"data\":null}") ? value.replace("\"id\":\"", "\"id\":\"parity-dropped-") : value
      },
    })
  })
  await page.reload()
  await page.locator(".kanna-terminal .xterm-rows").first().waitFor()
  await page.getByText("This terminal is simulated.").first().waitFor()
  await settle()
}

/** Takes focus out of the xterm, so its cursor stops blinking before a capture. */
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

export const scenarios: Scenario[] = [
  defineScenario({
    name: "terminal-workspace-gallery",
    route: "/__gallery/terminal-workspace",
    viewports: ["desktop"],
    regions: REGION,
    covers: { commands: ["terminal.create", "terminal.input", "terminal.resize", "terminal.close", "terminal.tail"] },
    async run({ page, capture, settle }) {
      await open(page, settle)
      await capture("open")

      await page.getByRole("button", { name: "Add terminal to the right" }).hover()
      await page.getByRole("tooltip").waitFor()
      await settle()
      await capture("add-tooltip")

      await page.getByRole("button", { name: "Add terminal to the right" }).click()
      await page.locator(".kanna-terminal .xterm-rows").nth(1).waitFor()
      await page.mouse.move(0, 0)
      await settle()
      await capture("split")

      await page.locator(".kanna-terminal").nth(1).click()
      await page.keyboard.type("git status")
      await page.keyboard.press("Enter")
      await blur(page)
      await settle()
      await capture("output")

      await page.getByRole("button", { name: "Close terminal" }).nth(1).click()
      await page.mouse.move(0, 0)
      await settle()
      await capture("one-left")

      await page.getByRole("button", { name: "Hide terminal" }).click()
      await page.getByText("Panel hidden").waitFor()
      await page.mouse.move(0, 0)
      await settle()
      await capture("hidden")
    },
  }),
]
