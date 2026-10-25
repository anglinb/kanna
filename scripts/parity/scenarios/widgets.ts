import type { Page } from "playwright"
import { defineScenario, type Scenario } from "../scenario"
import { CHATS, openWidgets, quickClick, REGIONS, regions } from "./_lib/helpers"

// The widget column beside a chat: Changes (files, staging, commit, the
// branch picker, fetch, merge), Commits, Quick Actions, Usage. Every
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
    regions: regions("widgets"),
    covers: { commands: ["chat.ignoreDiffFile"] },
    async run(context) {
      const { page } = context
      await openWidgets(context)
      await quickClick(context, column(page).getByRole("button", { name: "Actions for src/lib/units.test.ts", exact: true }))
      await quickClick(context, page.getByRole("menuitem", { name: "Ignore File" }))
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
]
