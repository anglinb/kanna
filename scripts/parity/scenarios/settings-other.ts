import { defineScenario, type Scenario } from "../scenario"
import { click, hover, parkPointer, regions, rest } from "./_lib/helpers"

// Settings → Keybindings, Usage, Labs, Changelog and This Mac.

const desktop = { viewports: ["desktop" as const] }

export const scenarios: Scenario[] = [
  defineScenario({
    name: "settings-keybindings",
    route: "/settings/keybindings",
    regions: regions("settings"),
    covers: { routes: ["/settings/keybindings"] },
  }),
  defineScenario({
    // A binding edited commits on blur; the row then offers its default back.
    name: "settings-keybindings-edit-and-reset",
    route: "/settings/keybindings",
    ...desktop,
    regions: regions("settings"),
    covers: { routes: ["/settings/keybindings"], commands: ["settings.writeKeybindings"] },
    async run(context) {
      const { page } = context
      // The shortcut fields have no label; Toggle Widgets is the second.
      const field = page.locator("[data-settings-page]").getByRole("textbox").nth(1)
      await field.fill("cmd+shift+b")
      await field.press("Tab")
      await parkPointer(context)
      await context.capture("edited")
      await click(context, page.getByRole("button", { name: /^Reset to/ }).first())
      await parkPointer(context)
      await context.capture("reset")
    },
  }),
  defineScenario({
    // The file opens in the editor, which the demo can't do.
    name: "settings-keybindings-open-file",
    route: "/settings/keybindings",
    ...desktop,
    regions: regions("settings"),
    covers: { routes: ["/settings/keybindings"], commands: ["system.openExternal"] },
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Open in Cursor" }))
      await parkPointer(context)
      await context.capture("needs-machine")
    },
  }),
  defineScenario({
    name: "settings-usage",
    route: "/settings/usage",
    regions: regions("settings"),
    covers: { routes: ["/settings/usage"], commands: ["usage.refresh"] },
  }),
  defineScenario({
    name: "settings-usage-refresh-and-tooltips",
    route: "/settings/usage",
    ...desktop,
    regions: regions("settings", "tooltip"),
    covers: { routes: ["/settings/usage"], commands: ["usage.refresh"] },
    async run(context) {
      const { page } = context
      await hover(context, page.getByRole("button", { name: "Refresh" }).first())
      await context.capture("refresh-tooltip")
      await click(context, page.getByRole("button", { name: "Refresh" }).first())
      await parkPointer(context)
      await context.capture("refreshed")
    },
  }),
  defineScenario({
    name: "settings-labs",
    route: "/settings/labs",
    regions: regions("settings"),
    covers: { routes: ["/settings/labs"] },
  }),
  defineScenario({
    name: "settings-labs-switches",
    route: "/settings/labs",
    ...desktop,
    regions: regions("settings", "sidebar"),
    covers: { routes: ["/settings/labs"], commands: ["settings.writeAppSettingsPatch"] },
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("switch", { name: "New Sidebar" }))
      await parkPointer(context)
      await context.capture("old-sidebar")
      await click(context, page.getByRole("switch", { name: "Terminal GPU Rendering" }))
      await parkPointer(context)
      await context.capture("gpu-on")
    },
  }),
  defineScenario({
    // Building a nightly happens on the machine: the demo says so.
    name: "settings-labs-build-latest",
    route: "/settings/labs",
    ...desktop,
    regions: regions("settings", "dialog"),
    covers: { routes: ["/settings/labs"], commands: ["update.installNightly"] },
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Build latest" }))
      await parkPointer(context)
      await context.capture("needs-machine")
    },
  }),
  defineScenario({
    // GitHub's releases feed isn't reachable from the demo: the error state, and Retry.
    name: "settings-changelog",
    route: "/settings/changelog",
    regions: regions("settings"),
    covers: { routes: ["/settings/changelog"] },
    async run(context) {
      await context.capture("error")
      await click(context, context.page.getByRole("button", { name: "Retry" }))
      await parkPointer(context)
      await context.capture("retried")
    },
  }),
  defineScenario({
    // This Mac exists only in Kanna for Mac; elsewhere its URL falls back to General.
    name: "settings-mac-unavailable",
    route: "/settings/mac",
    ...desktop,
    regions: regions("settings"),
    covers: { routes: ["/settings/mac"] },
    async run(context) {
      await rest(context)
      await context.capture("general")
    },
  }),
]
