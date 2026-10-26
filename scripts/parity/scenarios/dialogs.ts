import { defineScenario, type Scenario } from "../scenario"
import {
  CHATS,
  click,
  contextClick,
  countUuids,
  openPalette,
  openWidgets,
  parkPointer,
  press,
  quickClick,
  REGIONS,
  regions,
  rest,
  sidebarChatRow,
  switchSidebarView,
} from "./_lib/helpers"

// Dialogs not opened in their area's file: Kanna Cloud setup, the archived
// chats dialog from the Projects view, Push to GitHub for a project with no
// remote, and the ways out of a dialog
// (Escape, Close, clicking outside). Rename / delete chat are in
// sidebar.ts, rename project in home.ts, settings dialogs in settings-*.ts.

const desktop = { viewports: ["desktop" as const] }

export const scenarios: Scenario[] = [
  defineScenario({
    name: "dialog-kanna-cloud",
    route: CHATS.units,
    // The sidebar's Setup Kanna Cloud: not on a phone's chat page.
    viewports: ["desktop"],
    regions: regions("dialog"),
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Setup Kanna Cloud" }))
      await context.capture("open")
    },
  }),
  defineScenario({
    name: "dialog-close-button",
    route: CHATS.units,
    ...desktop,
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Setup Kanna Cloud" }))
      await click(context, context.page.getByRole("dialog").getByRole("button", { name: "Close" }))
      await parkPointer(context)
      await context.capture("closed")
    },
  }),
  defineScenario({
    name: "dialog-escape",
    route: CHATS.units,
    ...desktop,
    async run(context) {
      await contextClick(context, sidebarChatRow(context.page, "demo-chat-units"))
      await click(context, context.page.getByRole("menuitem", { name: "Rename" }))
      await press(context, "Escape")
      await parkPointer(context)
      await context.capture("closed")
    },
  }),
  defineScenario({
    // Clicking the overlay outside the dialog closes it.
    name: "dialog-click-outside",
    route: CHATS.units,
    ...desktop,
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Setup Kanna Cloud" }))
      await context.page.mouse.click(20, 880)
      await parkPointer(context)
      await context.capture("closed")
    },
  }),
  defineScenario({
    // The Projects view's Show Archived: the project's archived chats, one restored.
    name: "dialog-archived-chats",
    route: CHATS.units,
    ...desktop,
    regions: regions("dialog", "sidebar"),
    covers: { commands: ["chat.archive", "chat.unarchive"] },
    async run(context) {
      const { page } = context
      await contextClick(context, sidebarChatRow(page, "demo-chat-safari"))
      await click(context, page.getByRole("menuitem", { name: "Archive Chat" }))
      await switchSidebarView(context, "Projects")
      await contextClick(context, page.locator(REGIONS.sidebar).getByText("tidepool", { exact: true }).first())
      await click(context, page.getByRole("menuitem", { name: "Show Archived" }))
      await parkPointer(context)
      await context.capture("open")
      await click(context, page.getByRole("dialog").getByRole("button", { name: /Restore/ }).first())
      await parkPointer(context)
      await context.capture("restored")
    },
  }),
  defineScenario({
    // A project renamed from the sidebar's Projects view.
    name: "dialog-rename-project-from-sidebar",
    route: CHATS.units,
    ...desktop,
    regions: regions("dialog", "sidebar"),
    covers: { commands: ["project.rename"] },
    async run(context) {
      const { page } = context
      await switchSidebarView(context, "Projects")
      await contextClick(context, page.locator(REGIONS.sidebar).getByText("portfolio", { exact: true }).first())
      await click(context, page.getByRole("menuitem", { name: "Rename" }))
      await context.capture("open")
      await page.getByRole("dialog").getByRole("textbox").fill("sam.dev")
      await press(context, "Enter")
      await parkPointer(context)
      await rest(context)
      await context.capture("renamed")
    },
  }),
  defineScenario({
    // A project made from the palette has no GitHub remote: the Changes
    // card offers Push to GitHub, whose dialog asks for gh to be signed in.
    name: "dialog-push-to-github",
    route: CHATS.units,
    ...desktop,
    regions: regions("dialog", "widgets"),
    covers: { commands: ["project.create", "chat.getGitHubPublishInfo"] },
    async run(context) {
      const { page } = context
      const palette = page.getByRole("dialog", { name: "Command Palette" })
      await countUuids(context)
      await openPalette(context)
      await click(context, palette.getByRole("option", { name: /^Add Project…/ }).first())
      await click(context, palette.getByRole("option", { name: "Create New…" }).first())
      await palette.getByRole("combobox").pressSequentially("surf-log")
      await rest(context)
      await press(context, "Enter")
      await parkPointer(context)
      await openWidgets(context)
      await context.capture("no-remote")
      await quickClick(context, page.locator(REGIONS.widgets).getByRole("button", { name: "Push to GitHub" }))
      await context.capture("open")
    },
  }),
]
