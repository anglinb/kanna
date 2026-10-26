import { defineScenario, type Scenario, type ScenarioContext } from "../scenario"
import { click, parkPointer, rest } from "./_lib/helpers"

// The setup wizard's parts on gallery pages (src/parity/*/gallery/setup-*):
// what the demo can't show on the real page (wizard.ts covers that). The
// demo's sign-ins never change and it isn't Kanna for Mac, so these pages
// draw every card state from fixed data, and stand-ins answer for the Mac
// app (the This Mac step) and the machine's pairing endpoint (Kanna Cloud).

const desktop = { viewports: ["desktop" as const] }

/** Opens the wizard the way the Mac app's menu does. */
async function openWizard(context: ScenarioContext, step?: "cloud") {
  await context.page.evaluate((requested) => {
    const open = (window as unknown as { __kannaOpenSetup?: (step?: string) => void }).__kannaOpenSetup
    if (!open) throw new Error("window.__kannaOpenSetup is missing")
    open(requested)
  }, step)
  await rest(context)
}

export const scenarios: Scenario[] = [
  defineScenario({
    // Every header action and sign-in phase of an AuthCard, as rows and on
    // their own, and the Setup card; then a code pasted into Claude's.
    name: "setup-cards",
    route: "/__gallery/setup-cards",
    ...desktop,
    async run(context) {
      await context.capture("states")
      await context.page.getByPlaceholder("Paste code").first().fill("abc-123-xyz")
      await parkPointer(context)
      await context.capture("code-pasted")
    },
  }),
  defineScenario({
    // The This Mac step's states: checking, needs approval (lid warning),
    // staying awake with its battery row, everything done.
    name: "setup-mac",
    route: "/__gallery/setup-mac",
    ...desktop,
  }),
  defineScenario({
    // Kanna for Mac's wizard: the This Mac step first, its switches answered
    // by the app, then on through the sign-ins to the summary.
    name: "setup-mac-wizard",
    route: "/__gallery/setup-mac-wizard",
    ...desktop,
    async run(context) {
      const { page } = context
      await parkPointer(context)
      await context.capture("mac")
      await click(context, page.getByRole("switch", { name: "Open at login" }))
      await click(context, page.getByRole("switch", { name: "Stay awake while plugged in" }))
      await parkPointer(context)
      await context.capture("awake")
      await click(context, page.getByRole("button", { name: "Open Settings" }))
      await parkPointer(context)
      await context.capture("full-disk-access")
      await click(context, page.getByRole("button", { name: "Continue" }))
      await parkPointer(context)
      await context.capture("github")
      await click(context, page.getByRole("button", { name: "Back" }))
      await parkPointer(context)
      await context.capture("back-to-mac")
      await click(context, page.getByRole("button", { name: "Continue" }))
      await click(context, page.getByRole("button", { name: "Skip for now" }))
      await click(context, page.getByRole("button", { name: "Continue" }))
      await parkPointer(context)
      await context.capture("openrouter")
      await click(context, page.getByRole("button", { name: "Skip for now" }))
      await parkPointer(context)
      await context.capture("done")
    },
  }),
  defineScenario({
    // Put This Mac Online…: the wizard opens at Kanna Cloud and mints a
    // claim link; once the browser finishes the claim, the step shows where
    // the machine lives and moves on to the summary.
    name: "setup-cloud-wizard",
    route: "/__gallery/setup-cloud-wizard",
    ...desktop,
    async run(context) {
      const { page } = context
      await openWizard(context, "cloud")
      await parkPointer(context)
      await context.capture("claim-link")
      await page.evaluate(() => (window as unknown as { __setupGalleryPair: () => void }).__setupGalleryPair())
      // The 2s poll sees it, the success lands, and 1.8s later the summary.
      await page.waitForTimeout(6000)
      await parkPointer(context)
      await context.capture("paired")
    },
  }),
]
