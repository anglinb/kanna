import { defineScenario, type Scenario } from "../scenario"
import { click, parkPointer, press, regions, rest } from "./_lib/helpers"

// Settings dialogs the per-section files open but don't work through: the
// Default Models list edited and saved, and the Model Registry's validation
// error.

const route = "/settings/providers"
const desktop = { viewports: ["desktop" as const] }

export const scenarios: Scenario[] = [
  defineScenario({
    // Rows edit a local draft; Done saves the rows that have a model id.
    name: "settings-default-models-edit",
    route,
    ...desktop,
    regions: regions("settings", "dialog"),
    covers: { routes: [route], commands: ["settings.writeLlmProvider"] },
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("button", { name: "Edit models" }))
      const dialog = page.getByRole("dialog")
      // The blank row at the bottom: typing there adds an entry and a new blank row.
      await dialog.getByPlaceholder("Name").last().fill("Sonnet")
      // The new blank row is on screen before anyone types into the row above it.
      await rest(context)
      await dialog.getByPlaceholder("Model id").nth(-2).fill("anthropic/claude-sonnet")
      await rest(context)
      await context.capture("added")
      await click(context, dialog.getByRole("button", { name: "Remove default model" }).first())
      await context.capture("removed")
      await click(context, dialog.getByRole("button", { name: "Done" }))
      await parkPointer(context)
      await context.capture("saved")
    },
  }),
  defineScenario({
    // Escape closes the list and saves it too.
    name: "settings-default-models-escape",
    route,
    ...desktop,
    regions: regions("settings", "dialog"),
    covers: { routes: [route], commands: ["settings.writeLlmProvider"] },
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("button", { name: "Edit models" }))
      await page.getByRole("dialog").getByPlaceholder("Name").last().fill("Draft only")
      await press(context, "Escape")
      await parkPointer(context)
      await context.capture("closed")
    },
  }),
  defineScenario({
    // A Custom registry with no key fails its check; See error shows why.
    name: "settings-providers-validation-error",
    route,
    ...desktop,
    regions: regions("settings", "dialog"),
    covers: { routes: [route], commands: ["settings.writeLlmProvider", "settings.validateLlmProvider"] },
    async run(context) {
      const { page } = context
      await click(context, page.locator("[data-settings-row]").filter({ hasText: "Model Registry" }).getByRole("combobox"))
      await click(context, page.getByRole("option", { name: "Custom" }))
      await parkPointer(context)
      await click(context, page.getByRole("button", { name: "See error" }))
      await context.capture("error-dialog")
      await press(context, "Escape")
      await parkPointer(context)
      await context.capture("closed")
    },
  }),
]
