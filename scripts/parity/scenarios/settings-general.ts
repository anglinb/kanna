import { defineScenario, type Scenario } from "../scenario"
import { click, parkPointer, regions, rest } from "./_lib/helpers"

// Settings → General: every control, each written back with
// settings.writeAppSettingsPatch, and the dialogs and links it opens.

const route = "/settings/general"
const desktop = { viewports: ["desktop" as const] }
const covers = { routes: [route], commands: ["settings.writeAppSettingsPatch"] }

/** A settings select (Radix select: a combobox) by the row it sits in. */
function rowControl(page: import("playwright").Page, rowTitle: string, role: "combobox" | "switch" | "spinbutton" | "textbox") {
  // CSS: rows carry `data-settings-row` and their title as text; the control has no label of its own.
  return page.locator("[data-settings-row]").filter({ hasText: rowTitle }).getByRole(role)
}

export const scenarios: Scenario[] = [
  defineScenario({
    // The whole page, scrolled to the bottom (the Privacy group and machine card).
    name: "settings-general-bottom",
    route,
    regions: regions("settings"),
    covers: { routes: [route] },
    async run(context) {
      await context.page.getByRole("switch", { name: "Anonymous Analytics" }).scrollIntoViewIfNeeded()
      await rest(context)
      await context.capture("bottom")
    },
  }),
  defineScenario({
    name: "settings-general-theme",
    route,
    regions: regions("settings", "listbox"),
    covers,
    async run(context) {
      const { page } = context
      await click(context, rowControl(page, "Theme", "combobox"))
      await context.capture("open")
      await click(context, page.getByRole("option", { name: "Light" }))
      await parkPointer(context)
      await context.capture("light")
      await click(context, rowControl(page, "Theme", "combobox"))
      await click(context, page.getByRole("option", { name: "System" }))
      await parkPointer(context)
      await context.capture("system")
    },
  }),
  defineScenario({
    name: "settings-general-switches",
    route,
    ...desktop,
    regions: regions("settings", "sidebar"),
    covers,
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("switch", { name: "Project Icons in Chats" }))
      await click(context, page.getByRole("switch", { name: "Chat Tabs" }))
      await click(context, page.getByRole("switch", { name: "Peek at Widgets" }))
      await parkPointer(context)
      await context.capture("toggled")
    },
  }),
  defineScenario({
    // Chat tabs on: the title bar holds the open chats as tabs.
    name: "settings-general-chat-tabs",
    route,
    ...desktop,
    regions: regions("navbar"),
    covers,
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("switch", { name: "Chat Tabs" }))
      await click(context, page.locator("[data-sidebar=open] [data-chat-id=demo-chat-units]"))
      await click(context, page.locator("[data-sidebar=open] [data-chat-id=demo-chat-deploy]"))
      await parkPointer(context)
      await context.capture("two-tabs")
    },
  }),
  defineScenario({
    name: "settings-general-notifications",
    route,
    ...desktop,
    regions: regions("settings", "listbox"),
    covers,
    async run(context) {
      const { page } = context
      await click(context, rowControl(page, "Chat Sounds", "combobox"))
      await context.capture("sounds-open")
      await click(context, page.getByRole("option").nth(1))
      await parkPointer(context)
      await context.capture("sounds-on")
      await click(context, rowControl(page, "System Notifications", "combobox"))
      await context.capture("notifications-open")
    },
  }),
  defineScenario({
    name: "settings-general-chats-and-layout",
    route,
    ...desktop,
    regions: regions("settings", "listbox"),
    covers,
    async run(context) {
      const { page } = context
      await click(context, rowControl(page, "Enter While Running", "combobox"))
      await context.capture("enter-open")
      await click(context, page.getByRole("option").nth(1))
      await click(context, rowControl(page, "Widgets Visibility", "combobox"))
      await context.capture("widgets-open")
      await click(context, page.getByRole("option").nth(1))
      await click(context, rowControl(page, "Terminal Visibility", "combobox"))
      await click(context, page.getByRole("option").nth(1))
      await parkPointer(context)
      await context.capture("changed")
    },
  }),
  defineScenario({
    // Number fields commit on blur, clamped to their range.
    name: "settings-general-number-fields",
    route,
    ...desktop,
    regions: regions("settings"),
    covers,
    async run(context) {
      const { page } = context
      const window = rowControl(page, "Transcript Window", "spinbutton")
      await window.fill("12")
      await window.press("Tab")
      const scrollback = rowControl(page, "Terminal Scrollback", "spinbutton")
      await scrollback.fill("99999")
      await scrollback.press("Tab")
      const width = rowControl(page, "Terminal Min Column Width", "spinbutton")
      await width.fill("300")
      await width.press("Tab")
      await parkPointer(context)
      await context.capture("committed")
    },
  }),
  defineScenario({
    name: "settings-general-editor",
    route,
    ...desktop,
    regions: regions("settings", "listbox"),
    covers,
    async run(context) {
      const { page } = context
      await click(context, rowControl(page, "Default Editor", "combobox"))
      await context.capture("open")
      await click(context, page.getByRole("option", { name: "Custom" }))
      await parkPointer(context)
      await context.capture("custom")
      const projects = rowControl(page, "New Projects Directory", "textbox")
      await projects.fill("~/Code")
      await projects.press("Tab")
      await parkPointer(context)
      await context.capture("projects-directory")
    },
  }),
  defineScenario({
    name: "settings-general-analytics",
    route,
    ...desktop,
    regions: regions("settings", "dialog"),
    covers: { routes: [route], commands: ["settings.writeAppSettingsPatch"] },
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("button", { name: "View tracked events" }))
      await context.capture("events-dialog")
      await click(context, page.getByRole("dialog").getByRole("button").last())
      await click(context, page.getByRole("switch", { name: "Anonymous Analytics" }))
      await parkPointer(context)
      await context.capture("analytics-on")
    },
  }),
  defineScenario({
    name: "settings-general-check-updates",
    route,
    ...desktop,
    regions: regions("settings"),
    covers: { routes: [route], commands: ["update.check"] },
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Check for updates" }))
      await parkPointer(context)
      await context.capture("checked")
    },
  }),
  defineScenario({
    name: "settings-general-changelog-link",
    route,
    ...desktop,
    regions: regions("settings"),
    covers: { routes: [route, "/settings/changelog"] },
    async run(context) {
      // CSS: the update row's Changelog button shares its name with the nav's.
      await click(context, context.page.locator("[data-settings-row]").filter({ hasText: "Application Update" }).getByRole("button", { name: "Changelog" }))
      await parkPointer(context)
      await context.capture("changelog")
    },
  }),
  defineScenario({
    // The settings nav: every section in turn, by its button.
    name: "settings-nav",
    route,
    ...desktop,
    regions: regions("settings"),
    covers: { routes: ["/settings/:sectionId"] },
    async run(context) {
      const nav = context.page.getByRole("complementary")
      for (const section of ["Providers", "MCP Servers", "Skills", "Keybindings", "Usage", "Labs", "Changelog", "General"]) {
        await click(context, nav.getByRole("button", { name: section, exact: true }))
        await parkPointer(context)
        await context.capture(section.toLowerCase().replace(/\s+/g, "-"))
      }
    },
  }),
]
