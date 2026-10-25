import type { Page } from "playwright"
import { defineScenario, type Scenario } from "../scenario"

// The dev box's full-screen terminal at /terminal (TerminalPage, the
// terminal workspace, a pane's xterm on the demo's fake shell).
//
// The demo backend is no dev box, and both apps start from settings seeded
// with `devbox: false`, so /terminal sends them to `/`. To reach the page,
// the app-settings frames the backend sends are read with `devbox: true`
// (the frames only; the backend is untouched), the page is reloaded, and the
// sidebar's Terminal button opens it as a person would. (Not a dev box,
// /terminal sends you home: routes.ts's terminal-page-redirect.)
//
// A new pane subscribes to its terminal, then sends terminal.create two
// frames later. The demo answers the subscription with a null snapshot (no
// shell yet), and a pane that hears "no shell" after its create went out
// sends a second create; whether it does is a race between the fake socket's
// round trip and two animation frames, so React against React disagreed run
// to run. Those null snapshots are addressed to no subscription here (the
// frames only), which leaves one create per pane, every run.

/** The TerminalPage's own element. */
const PAGE = "div.md\\:pt-0:has(.kanna-terminal)"

async function openAsDevbox(page: Page, settle: () => Promise<void>) {
  await page.addInitScript(() => {
    const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")!
    Object.defineProperty(MessageEvent.prototype, "data", {
      configurable: true,
      get(this: MessageEvent) {
        const value = data.get!.call(this) as unknown
        if (typeof value !== "string") return value
        if (value.includes("\"snapshot\":{\"type\":\"terminal\",\"data\":null}")) return value.replace("\"id\":\"", "\"id\":\"parity-dropped-")
        return value.includes("\"devbox\":false") ? value.replaceAll("\"devbox\":false", "\"devbox\":true") : value
      },
    })
  })
  await page.reload()
  await settle()
  await page.getByRole("button", { name: "Terminal", exact: true }).click()
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
    name: "terminal-page",
    route: "/",
    regions: { terminal: PAGE },
    covers: { routes: ["/terminal"], commands: ["terminal.create", "terminal.input", "terminal.resize"] },
    async run({ page, capture, settle }) {
      await openAsDevbox(page, settle)
      await capture("open")
      await page.locator(".kanna-terminal").first().click()
      await page.keyboard.type("ls")
      await page.keyboard.press("Enter")
      await page.getByText("README.md").first().waitFor()
      await blur(page)
      await settle()
      await capture("output")
    },
  }),
  defineScenario({
    name: "terminal-page-split",
    route: "/",
    viewports: ["desktop"],
    regions: { terminal: PAGE },
    covers: { commands: ["terminal.create", "terminal.close", "terminal.resize"] },
    async run({ page, capture, settle }) {
      await openAsDevbox(page, settle)
      await page.getByRole("button", { name: "Add terminal to the right" }).click()
      await page.locator(".kanna-terminal .xterm-rows").nth(1).waitFor()
      await settle()
      await page.mouse.move(0, 0)
      await settle()
      await capture("split")

      // Drag the handle between the panes 120px to the left.
      const handle = page.getByRole("separator").first()
      const box = (await handle.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 4 })
      await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 4 })
      await page.mouse.up()
      await page.mouse.move(0, 0)
      await settle()
      await capture("resized")

      // The keyboard moves it too.
      await handle.focus()
      await page.keyboard.press("ArrowRight")
      await settle()
      await capture("handle-keyboard")

      await page.getByRole("button", { name: "Close terminal" }).nth(1).click()
      await settle()
      await page.mouse.move(0, 0)
      await settle()
      await capture("closed")
    },
  }),
  defineScenario({
    name: "terminal-page-clear",
    route: "/",
    viewports: ["desktop"],
    regions: { terminal: PAGE },
    covers: { commands: ["terminal.close", "terminal.create", "terminal.input"] },
    async run({ page, capture, settle }) {
      await openAsDevbox(page, settle)
      await page.locator(".kanna-terminal").first().click()
      await page.keyboard.type("pwd")
      await page.keyboard.press("Enter")
      await settle()
      // Clear resets the xterm and closes the shell; the demo pushes nothing
      // after a close, so the pane stays empty.
      await page.getByRole("button", { name: "Clear terminal" }).click()
      await blur(page)
      await settle()
      await capture("cleared")
    },
  }),
]
