import { defineScenario, type Scenario } from "../scenario"
import { click, parkPointer, regions, rest } from "./_lib/helpers"

// Settings → Providers: saved accounts (add, default, replace key, remove,
// sign in), the provider setup cards, per-harness defaults, the Model
// Registry and the Default Models dialog.

const route = "/settings/providers"
const desktop = { viewports: ["desktop" as const] }

function accountRow(page: import("playwright").Page, title: string) {
  // CSS: a settings row is a div holding its title text and its buttons; no role of its own.
  return page.locator("div").filter({ has: page.getByText(title, { exact: true }) }).filter({ has: page.getByRole("button") }).last()
}

export const scenarios: Scenario[] = [
  defineScenario({
    name: "settings-providers",
    route,
    regions: regions("settings"),
    covers: { routes: [route], commands: ["settings.readLlmProvider"] },
  }),
  defineScenario({
    name: "settings-providers-refresh",
    route,
    ...desktop,
    regions: regions("settings"),
    covers: { routes: [route], commands: ["auth.refresh"] },
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Refresh" }))
      await parkPointer(context)
      await context.capture("refreshed")
    },
  }),
  defineScenario({
    // An API-key account (Cursor) is added signed in.
    name: "settings-providers-add-key-account",
    route,
    ...desktop,
    regions: regions("settings", "dialog", "listbox"),
    covers: { routes: [route], commands: ["accounts.create"] },
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("button", { name: "Add account" }))
      await context.capture("dialog")
      await click(context, page.getByRole("combobox", { name: "Account provider" }))
      await context.capture("providers")
      await click(context, page.getByRole("option", { name: "Cursor" }))
      await page.getByRole("textbox", { name: "Account name" }).fill("Side project")
      await page.getByLabel("Account API key").fill("key_demo_123")
      await rest(context)
      await context.capture("filled")
      await click(context, page.getByRole("dialog").getByRole("button", { name: "Add account" }))
      await parkPointer(context)
      await context.capture("added")
    },
  }),
  defineScenario({
    // A Claude account signs in through its CLI, which the demo can't run:
    // the sign-in dialog shows why.
    name: "settings-providers-add-native-account",
    route,
    ...desktop,
    regions: regions("settings", "dialog"),
    covers: { routes: [route], commands: ["accounts.create", "accounts.login"] },
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("button", { name: "Add account" }))
      await page.getByRole("textbox", { name: "Account name" }).fill("Work")
      await click(context, page.getByRole("dialog").getByRole("button", { name: "Add account" }))
      await parkPointer(context)
      await context.capture("signing-in")
    },
  }),
  defineScenario({
    name: "settings-providers-pi-account-fields",
    route,
    ...desktop,
    regions: regions("dialog", "listbox"),
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("button", { name: "Add account" }))
      await click(context, page.getByRole("combobox", { name: "Account provider" }))
      await click(context, page.getByRole("option", { name: "Pi" }))
      await click(context, page.getByRole("combobox", { name: "Account API provider" }))
      await context.capture("api-providers")
      await click(context, page.getByRole("option", { name: "Custom" }))
      await parkPointer(context)
      await context.capture("custom")
    },
  }),
  defineScenario({
    name: "settings-providers-account-actions",
    route,
    ...desktop,
    regions: regions("settings", "dialog"),
    covers: { routes: [route], commands: ["accounts.setDefault", "accounts.updateKey", "accounts.remove"] },
    async run(context) {
      const { page } = context
      const work = accountRow(page, "Cursor · Work")
      await click(context, work.getByRole("button", { name: "Use by default" }))
      await parkPointer(context)
      await context.capture("default")
      await click(context, work.getByRole("button", { name: "Replace key" }))
      await context.capture("replace-key")
      await page.getByRole("textbox", { name: "Replacement API key" }).or(page.getByLabel("Replacement API key")).fill("key_new_456")
      await click(context, page.getByRole("button", { name: "Save key" }))
      await click(context, accountRow(page, "Cursor · Work").getByRole("button", { name: "Remove" }))
      await parkPointer(context)
      await context.capture("removed")
    },
  }),
  defineScenario({
    name: "settings-providers-default-provider",
    route,
    ...desktop,
    regions: regions("settings", "listbox"),
    covers: { routes: [route], commands: ["settings.writeAppSettingsPatch"] },
    async run(context) {
      const { page } = context
      // CSS: the Default Provider select has no label of its own.
      await click(context, page.locator("[data-settings-row]").filter({ hasText: "Default Provider" }).getByRole("combobox"))
      await context.capture("open")
      await click(context, page.getByRole("option", { name: "Codex" }))
      await parkPointer(context)
      await context.capture("codex")
    },
  }),
  defineScenario({
    // Each harness's defaults are the composer's pickers.
    name: "settings-providers-model-defaults",
    route,
    ...desktop,
    regions: regions("settings", "popover"),
    covers: { routes: [route], commands: ["settings.writeAppSettingsPatch"] },
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("button", { name: "Opus", exact: true }))
      await context.capture("claude-models")
      await click(context, page.getByRole("dialog").getByRole("button", { name: "Sonnet" }))
      await click(context, page.getByRole("button", { name: "Full Access" }).first())
      await context.capture("claude-modes")
      await click(context, page.getByRole("dialog").getByRole("button", { name: "Plan Mode" }))
      await click(context, page.getByRole("button", { name: "1M", exact: true }))
      await context.capture("context-window")
      await parkPointer(context)
      await click(context, page.getByRole("button", { name: "Fable Latest", exact: true }))
      await context.capture("pi-models")
    },
  }),
  defineScenario({
    name: "settings-providers-model-registry",
    route,
    ...desktop,
    regions: regions("settings", "listbox", "dialog"),
    covers: { routes: [route], commands: ["settings.writeLlmProvider", "settings.validateLlmProvider"] },
    async run(context) {
      const { page } = context
      await click(context, page.locator("[data-settings-row]").filter({ hasText: "Model Registry" }).getByRole("combobox"))
      await context.capture("providers")
      await click(context, page.getByRole("option", { name: "Custom" }))
      await parkPointer(context)
      await context.capture("custom")
      const key = page.getByPlaceholder("Required")
      await key.fill("sk-demo-123")
      await key.press("Enter")
      await parkPointer(context)
      await context.capture("saved")
    },
  }),
  defineScenario({
    name: "settings-providers-default-models-dialog",
    route,
    ...desktop,
    regions: regions("dialog"),
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Edit models" }))
      await context.capture("open")
    },
  }),
  defineScenario({
    // Grok Build isn't installed in the demo; installing a CLI needs the real machine.
    name: "settings-providers-install-cli",
    route,
    ...desktop,
    regions: regions("settings"),
    covers: { routes: [route], commands: ["auth.install"] },
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Install" }).first())
      await parkPointer(context)
      await context.capture("after-install")
    },
  }),
  defineScenario({
    // GitHub's CLI is signed out in the demo; Log In starts a sign-in the demo can't run.
    name: "settings-providers-log-in",
    route,
    ...desktop,
    regions: regions("settings"),
    covers: { routes: [route], commands: ["auth.login.start"] },
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Log In" }).first())
      await parkPointer(context)
      await context.capture("after-log-in")
    },
  }),
]
