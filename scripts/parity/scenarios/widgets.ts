import type { Page } from "playwright"
import { defineScenario, type Scenario } from "../scenario"
import { CHATS, openWidgets, parkPointer, quickClick, REGIONS, regions } from "./_lib/helpers"

// The widget column beside a chat: Changes (files, staging, commit, the
// branch picker, fetch, merge), Commits, Quick Actions, Tasks, Schedules,
// Usage. Every
// scenario here opens the column, does one or two things and captures
// within its first poll interval (see quickClick in _lib/helpers.ts).

const desktop = { viewports: ["desktop" as const] }

function column(page: Page) {
  return page.locator(REGIONS.widgets)
}

export const scenarios: Scenario[] = [
  defineScenario({
    // Another project's chat: ledger-api, on its docs branch, with README.md uncommitted.
    name: "widgets-ledger-chat",
    route: CHATS.readme,
    ...desktop,
    regions: regions("widgets"),
    covers: { commands: ["browser.listLocalHttpServers", "usage.refresh", "chat.refreshDiffs"] },
    async run(context) {
      await openWidgets(context)
      await context.capture("open")
    },
  }),
  defineScenario({
    // Nothing uncommitted: the Changes card is empty.
    name: "widgets-clean-tree",
    route: CHATS.hero,
    ...desktop,
    regions: regions("widgets"),
    async run(context) {
      await openWidgets(context)
      await context.capture("open")
    },
  }),
  defineScenario({
    name: "widgets-file-actions-menu",
    route: CHATS.units,
    ...desktop,
    regions: regions("menu"),
    async run(context) {
      await openWidgets(context)
      await quickClick(context, column(context.page).getByRole("button", { name: "Actions for src/lib/units.ts", exact: true }))
      await context.capture("menu")
    },
  }),
  defineScenario({
    name: "widgets-discard-file",
    route: CHATS.units,
    ...desktop,
    regions: regions("widgets", "dialog"),
    covers: { commands: ["chat.discardDiffFile"] },
    async run(context) {
      const { page } = context
      await openWidgets(context)
      await quickClick(context, column(page).getByRole("button", { name: "Actions for src/lib/units.test.ts", exact: true }))
      await quickClick(context, page.getByRole("menuitem", { name: /^Discard/ }))
      const confirm = page.getByRole("dialog").getByRole("button", { name: /^Discard/ })
      if (await confirm.count()) await quickClick(context, confirm)
      await context.capture("discarded")
    },
  }),
  defineScenario({
    name: "widgets-ignore-file",
    route: CHATS.units,
    ...desktop,
    regions: regions("widgets", "dialog"),
    covers: { commands: ["chat.ignoreDiffFile"] },
    async run(context) {
      const { page } = context
      await openWidgets(context)
      await quickClick(context, column(page).getByRole("button", { name: "Actions for src/lib/units.test.ts", exact: true }))
      await quickClick(context, page.getByRole("menuitem", { name: "Ignore File" }))
      await context.capture("confirm")
      await quickClick(context, page.getByRole("dialog").getByRole("button", { name: /Ignore/ }).last())
      await context.capture("ignored")
    },
  }),
  defineScenario({
    // Files leave and rejoin the commit one by one, or all at once.
    name: "widgets-stage-files",
    route: CHATS.units,
    ...desktop,
    regions: regions("widgets"),
    async run(context) {
      const { page } = context
      await openWidgets(context)
      await quickClick(context, column(page).getByRole("button", { name: "Exclude file from commit", exact: true }).first())
      await quickClick(context, column(page).getByRole("button", { name: "Unselect all files from commit" }).or(column(page).getByRole("button", { name: "Select all files for commit" })).first())
      await context.capture("toggled")
    },
  }),
  defineScenario({
    name: "widgets-search-changes",
    route: CHATS.units,
    ...desktop,
    regions: regions("widgets"),
    async run(context) {
      await openWidgets(context)
      await column(context.page).getByRole("searchbox", { name: "Search changes" }).fill("units")
      await context.settle()
      await context.capture("filtered")
    },
  }),
  defineScenario({
    name: "widgets-file-hover-card",
    route: CHATS.units,
    ...desktop,
    regions: regions("popover"),
    covers: { commands: ["project.readDiffPatch"] },
    async run(context) {
      await openWidgets(context)
      await column(context.page).getByText("useHeightUnit.ts", { exact: true }).first().hover()
      await context.page.waitForTimeout(800)
      await context.settle()
      await context.capture("card")
    },
  }),
  defineScenario({
    name: "widgets-commit-message-form",
    route: CHATS.units,
    ...desktop,
    regions: regions("widgets"),
    covers: { commands: ["project.generateCommitMessage"] },
    async run(context) {
      const { page } = context
      await openWidgets(context)
      await quickClick(context, column(page).getByRole("button", { name: "Write commit message" }))
      await quickClick(context, column(page).getByRole("button", { name: "Generate commit message" }))
      await context.capture("generated")
    },
  }),
  defineScenario({
    // A message typed by hand commits with ⌘Enter from the field.
    name: "widgets-commit-with-keyboard",
    route: CHATS.units,
    ...desktop,
    regions: regions("widgets"),
    covers: { commands: ["project.commitDiffs"] },
    async run(context) {
      const { page } = context
      await openWidgets(context)
      await quickClick(context, column(page).getByRole("button", { name: "Write commit message" }))
      await column(page).getByPlaceholder("Commit message").fill("Let wave heights switch between feet and meters")
      await page.keyboard.press("Meta+Enter")
      await context.settle()
      await context.capture("committed")
    },
  }),
  defineScenario({
    // Generate & push: a message is drafted, the files committed, the card empties and Commits grows.
    name: "widgets-generate-and-push",
    route: CHATS.units,
    ...desktop,
    regions: regions("widgets"),
    covers: { commands: ["project.generateCommitMessage", "project.commitDiffs"] },
    async run(context) {
      await openWidgets(context)
      await quickClick(context, column(context.page).getByRole("button", { name: "Generate & push to main" }))
      await context.capture("committed")
    },
  }),
  defineScenario({
    name: "widgets-commit-hover-card",
    route: CHATS.units,
    ...desktop,
    regions: regions("popover"),
    covers: { commands: ["project.readCommit"] },
    async run(context) {
      await openWidgets(context)
      await column(context.page).getByRole("button", { name: /^Open commit .* on GitHub/ }).last().hover()
      await context.page.waitForTimeout(800)
      await context.settle()
      await context.capture("card")
    },
  }),
  defineScenario({
    name: "widgets-branch-picker",
    route: CHATS.units,
    ...desktop,
    regions: regions("widgets"),
    covers: { commands: ["chat.listBranches"] },
    async run(context) {
      await openWidgets(context)
      await quickClick(context, column(context.page).getByRole("button", { name: "Branch main" }))
      await context.capture("open")
    },
  }),
  defineScenario({
    name: "widgets-create-branch",
    route: CHATS.units,
    ...desktop,
    regions: regions("widgets"),
    covers: { commands: ["chat.listBranches", "chat.createBranch"] },
    async run(context) {
      const { page } = context
      await openWidgets(context)
      await quickClick(context, column(page).getByRole("button", { name: "Branch main" }))
      await page.getByRole("combobox", { name: "Find or create a branch…" }).fill("feature/arrows")
      await context.settle()
      await quickClick(context, page.getByRole("option", { name: "Create feature/arrows from main" }))
      await context.capture("created")
    },
  }),
  defineScenario({
    // ledger-api has a docs branch and main: checking out main brings the README along.
    name: "widgets-checkout-branch",
    route: CHATS.readme,
    ...desktop,
    regions: regions("widgets", "dialog"),
    covers: { commands: ["chat.listBranches", "chat.checkoutBranch"] },
    async run(context) {
      const { page } = context
      await openWidgets(context)
      await quickClick(context, column(page).getByRole("button", { name: "Branch docs/readme" }))
      await quickClick(context, page.getByRole("option", { name: /^main/ }).first())
      await context.capture("bring-changes")
      const bring = page.getByRole("button", { name: "Bring Changes" })
      if (await bring.count()) await quickClick(context, bring)
      await context.capture("checked-out")
    },
  }),
  defineScenario({
    name: "widgets-merge-dialog",
    route: CHATS.readme,
    ...desktop,
    regions: regions("dialog"),
    covers: { commands: ["chat.listBranches", "chat.previewMergeBranch"] },
    async run(context) {
      const { page } = context
      await openWidgets(context)
      await quickClick(context, column(page).getByRole("button", { name: "Branch docs/readme" }))
      await quickClick(context, page.getByRole("button", { name: /^Merge into/ }))
      await quickClick(context, page.getByRole("dialog").getByRole("button", { name: "main", exact: true }))
      await context.capture("preview")
    },
  }),
  defineScenario({
    name: "widgets-fetch",
    route: CHATS.units,
    ...desktop,
    regions: regions("widgets"),
    covers: { commands: ["chat.syncBranch"] },
    async run(context) {
      await openWidgets(context)
      await quickClick(context, column(context.page).getByRole("button", { name: "Fetch" }))
      await context.capture("fetched")
    },
  }),
  defineScenario({
    name: "widgets-add-quick-action",
    route: CHATS.units,
    ...desktop,
    regions: regions("widgets"),
    covers: { commands: ["project.writeQuickActions"] },
    async run(context) {
      const { page } = context
      await openWidgets(context)
      await quickClick(context, column(page).getByRole("button", { name: "Add quick action" }))
      await column(page).getByRole("textbox", { name: "Command" }).fill("bun run dev")
      await quickClick(context, column(page).getByRole("button", { name: "Save quick action" }))
      await context.capture("saved")
    },
  }),
  defineScenario({
    name: "widgets-usage-card",
    route: CHATS.units,
    ...desktop,
    regions: regions("widgets"),
    covers: { commands: ["usage.refresh"] },
    async run(context) {
      await openWidgets(context)
      await quickClick(context, column(context.page).getByRole("button", { name: /^Claude Code/ }))
      await context.capture("collapsed")
    },
  }),
  defineScenario({
    // The Usage card's refresh button, its tooltip up under the pointer.
    name: "widgets-usage-refresh",
    route: CHATS.units,
    ...desktop,
    regions: regions("widgets"),
    covers: { commands: ["usage.refresh"] },
    async run(context) {
      const { page } = context
      await openWidgets(context)
      await column(page).getByRole("button", { name: "Refresh usage" }).first().click()
      await page.waitForTimeout(300)
      await context.settle()
      await context.capture("refreshed")
    },
  }),
  defineScenario({
    // ledger-api's docs branch is a commit behind main: the merge previews, then runs.
    name: "widgets-merge-branch",
    route: CHATS.readme,
    ...desktop,
    regions: regions("dialog"),
    covers: { commands: ["chat.previewMergeBranch", "chat.mergeBranch"] },
    async run(context) {
      const { page } = context
      await openWidgets(context)
      await quickClick(context, column(page).getByRole("button", { name: "Branch docs/readme" }))
      await quickClick(context, page.getByRole("button", { name: /^Merge into/ }))
      await quickClick(context, page.getByRole("dialog").getByRole("button", { name: "main", exact: true }))
      await quickClick(context, page.getByRole("dialog").getByRole("button", { name: "Merge", exact: true }))
      await context.capture("merged")
    },
  }),
  defineScenario({
    // A branch in the picker has a hover card: its last commit and how far it is from main.
    name: "widgets-branch-hover-card",
    route: CHATS.readme,
    ...desktop,
    regions: regions("popover"),
    covers: { commands: ["chat.listBranches", "project.readBranch"] },
    async run(context) {
      const { page } = context
      await openWidgets(context)
      await quickClick(context, column(page).getByRole("button", { name: "Branch docs/readme" }))
      await page.getByRole("option", { name: /^main/ }).first().hover()
      await page.waitForTimeout(800)
      await context.settle()
      await context.capture("card")
    },
  }),
  defineScenario({
    // Settings → Peek at Widgets on: the pointer at the window's right edge
    // slides the closed column over the chat.
    name: "widgets-edge-peek",
    route: "/settings/general",
    ...desktop,
    regions: regions("widgets"),
    covers: { commands: ["settings.writeAppSettingsPatch"] },
    async run(context) {
      const { page } = context
      await quickClick(context, page.getByRole("switch", { name: "Peek at Widgets" }))
      await quickClick(context, page.locator("[data-sidebar=open] [data-chat-id=demo-chat-units]"))
      await page.mouse.move(1439, 450)
      await page.waitForTimeout(1000)
      await context.settle()
      await context.capture("peeking")
    },
  }),
  defineScenario({
    // The README chat has background work: a finished subagent and a running monitor.
    name: "widgets-tasks",
    route: CHATS.readme,
    ...desktop,
    regions: regions("widgets"),
    async run(context) {
      await openWidgets(context)
      await context.capture("open")
    },
  }),
  defineScenario({
    name: "widgets-task-hover-card",
    route: CHATS.readme,
    ...desktop,
    regions: regions("popover"),
    async run(context) {
      await openWidgets(context)
      await column(context.page).getByText("bun run dev").first().hover()
      await context.page.waitForTimeout(800)
      await context.settle()
      await context.capture("card")
    },
  }),
  defineScenario({
    // The rate-limit chat's agent set up a check every six hours: the Schedules card.
    name: "widgets-schedules",
    route: CHATS.rateLimit,
    ...desktop,
    regions: regions("widgets"),
    async run(context) {
      await openWidgets(context)
      await context.capture("open")
    },
  }),
  defineScenario({
    // A schedule's card: its message, where it goes, its runs, and Edit.
    name: "widgets-schedule-hover-card",
    route: CHATS.rateLimit,
    ...desktop,
    regions: regions("popover"),
    async run(context) {
      await openWidgets(context)
      await column(context.page).getByText("Watch the charge limiter", { exact: true }).hover()
      await context.page.waitForTimeout(800)
      await context.settle()
      await context.capture("card")
    },
  }),
  defineScenario({
    // Edit Schedule… starts the sentence that changes it in the composer.
    name: "widgets-schedule-edit",
    route: CHATS.rateLimit,
    ...desktop,
    regions: regions("composer"),
    async run(context) {
      const { page } = context
      await openWidgets(context)
      await quickClick(context, column(page).getByRole("button", { name: "Schedule actions" }))
      await quickClick(context, page.getByRole("menuitem", { name: "Edit Schedule…" }))
      await context.capture("prefilled")
    },
  }),
  defineScenario({
    // A saved quick action runs in a new terminal under the chat. The column
    // is closed before the capture, which stops its polls, so waiting out the
    // row's one-second check mark doesn't race them.
    name: "widgets-run-quick-action",
    route: CHATS.units,
    ...desktop,
    regions: regions("terminal"),
    covers: { commands: ["project.writeQuickActions", "terminal.create", "terminal.input"] },
    async run(context) {
      const { page } = context
      await openWidgets(context)
      await quickClick(context, column(page).getByRole("button", { name: "Add quick action" }))
      await column(page).getByRole("textbox", { name: "Command" }).fill("bun test")
      await quickClick(context, column(page).getByRole("button", { name: "Save quick action" }))
      await quickClick(context, column(page).getByRole("button", { name: /^bun test/ }).first())
      await quickClick(context, page.locator(REGIONS.navbar).getByRole("button", { name: "Hide widgets" }))
      await parkPointer(context)
      await context.capture("ran")
    },
  }),
  defineScenario({
    // A quick action's menu deletes it.
    name: "widgets-delete-quick-action",
    route: CHATS.units,
    ...desktop,
    regions: regions("menu"),
    covers: { commands: ["project.writeQuickActions"] },
    async run(context) {
      const { page } = context
      await openWidgets(context)
      await quickClick(context, column(page).getByRole("button", { name: "Add quick action" }))
      await column(page).getByRole("textbox", { name: "Command" }).fill("bun run lint")
      await quickClick(context, column(page).getByRole("button", { name: "Save quick action" }))
      await quickClick(context, column(page).getByRole("button", { name: "Quick action options" }))
      await context.capture("menu")
      await quickClick(context, page.getByRole("menuitem", { name: "Delete" }))
      await context.capture("deleted")
    },
  }),
  defineScenario({
    // A running task stops on its own, leaving the turn running.
    name: "widgets-stop-task",
    route: CHATS.readme,
    ...desktop,
    regions: regions("widgets", "menu"),
    covers: { commands: ["chat.stopTask"] },
    async run(context) {
      const { page } = context
      await openWidgets(context)
      await quickClick(context, column(page).getByRole("button", { name: "Monitor actions" }))
      await context.capture("menu")
      await quickClick(context, page.getByRole("menuitem", { name: /^Stop/ }))
      await context.capture("stopped")
    },
  }),
]
