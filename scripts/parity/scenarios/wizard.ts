import { defineScenario, type Scenario, type ScenarioContext } from "../scenario"
import { CHATS, click, parkPointer, rest } from "./_lib/helpers"

// The setup wizard (components/auth/SetupWizard), full screen over any page.
// The demo marks setup done so the wizard never opens on its own; the Mac
// app's Kanna › Setup… opens it through `window.__kannaOpenSetup`, and so do
// these scenarios. In the demo GitHub's CLI is signed out, every agent but
// Grok Build is signed in, and OpenRouter is connected, so it opens at
// Connect GitHub.

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
    name: "wizard-open",
    route: CHATS.units,
    async run(context) {
      await openWizard(context)
      await parkPointer(context)
      await context.capture("github")
    },
  }),
  defineScenario({
    // Skip GitHub, see the agents, go back, then forward to the end and finish.
    name: "wizard-steps",
    route: CHATS.units,
    ...desktop,
    covers: { commands: ["settings.writeAppSettingsPatch"] },
    async run(context) {
      const { page } = context
      await openWizard(context)
      await click(context, page.getByRole("button", { name: "Skip for now" }))
      await parkPointer(context)
      await context.capture("agents")
      await click(context, page.getByRole("button", { name: "Back" }))
      await parkPointer(context)
      await context.capture("back-to-github")
      await click(context, page.getByRole("button", { name: "Skip for now" }))
      await click(context, page.getByRole("button", { name: "Continue" }))
      await parkPointer(context)
      await context.capture("openrouter")
      await click(context, page.getByRole("button", { name: "Continue" }))
      await parkPointer(context)
      await context.capture("done")
      await click(context, page.getByRole("button", { name: "Start Building" }))
      await parkPointer(context)
      await context.capture("finished")
    },
  }),
  defineScenario({
    // Logging GitHub in starts the CLI's sign-in, which needs the real machine.
    name: "wizard-github-log-in",
    route: CHATS.units,
    ...desktop,
    covers: { commands: ["auth.login.start"] },
    async run(context) {
      await openWizard(context)
      await click(context, context.page.getByRole("button", { name: "Log In" }).first())
      await parkPointer(context)
      await context.capture("needs-machine")
    },
  }),
  defineScenario({
    // Set up later closes it and keeps the Setup card for another time.
    name: "wizard-set-up-later",
    route: "/",
    ...desktop,
    covers: { commands: ["settings.writeAppSettingsPatch"] },
    async run(context) {
      await openWizard(context)
      await click(context, context.page.getByRole("button", { name: "Set up later" }))
      await parkPointer(context)
      await context.capture("closed")
    },
  }),
]
