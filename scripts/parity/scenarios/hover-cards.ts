import { defineScenario, type Scenario } from "../scenario"
import { CHATS, click, hover, parkPointer, regions, sidebarChatRow } from "./_lib/helpers"

// The sidebar chat rows' hover cards, one per kind of chat: finished with
// uncommitted files, finished and committed, running, waiting on a
// question; and the card's Jump to this prompt. (Widget cards are in
// widgets.ts, the channel card in sidebar.ts.)

const desktop = { viewports: ["desktop" as const] }
const covers = { commands: ["chat.getPreview", "chat.touchedFiles"] }

export const scenarios: Scenario[] = [
  defineScenario({
    name: "hover-card-chat-with-files",
    route: CHATS.deploy,
    ...desktop,
    regions: regions("popover"),
    covers,
    async run(context) {
      await hover(context, sidebarChatRow(context.page, "demo-chat-units"))
      await context.capture("card")
    },
  }),
  defineScenario({
    name: "hover-card-chat-committed",
    route: CHATS.units,
    ...desktop,
    regions: regions("popover"),
    covers,
    async run(context) {
      await hover(context, sidebarChatRow(context.page, "demo-chat-safari"))
      await context.capture("card")
    },
  }),
  defineScenario({
    name: "hover-card-chat-running",
    route: CHATS.units,
    ...desktop,
    regions: regions("popover"),
    covers,
    async run(context) {
      await hover(context, sidebarChatRow(context.page, "demo-chat-readme"))
      await context.capture("card")
    },
  }),
  defineScenario({
    name: "hover-card-chat-waiting",
    route: CHATS.units,
    ...desktop,
    regions: regions("popover"),
    covers,
    async run(context) {
      await hover(context, sidebarChatRow(context.page, "demo-chat-deploy"))
      await context.capture("card")
    },
  }),
  defineScenario({
    // Moving from one row to the next moves the card with it.
    name: "hover-card-chat-moves-between-rows",
    route: CHATS.units,
    ...desktop,
    regions: regions("popover", "sidebar"),
    covers,
    async run(context) {
      await hover(context, sidebarChatRow(context.page, "demo-chat-deploy"))
      await hover(context, sidebarChatRow(context.page, "demo-chat-safari"))
      await context.capture("second-row")
      await parkPointer(context)
      await context.capture("gone")
    },
  }),
  defineScenario({
    name: "hover-card-jump-to-prompt",
    route: CHATS.units,
    ...desktop,
    regions: regions("transcript", "sidebar"),
    covers,
    async run(context) {
      await hover(context, sidebarChatRow(context.page, "demo-chat-safari"))
      await click(context, context.page.getByRole("button", { name: "Jump to this prompt" }))
      await parkPointer(context)
      await context.capture("jumped")
    },
  }),
  defineScenario({
    // A changed file in the card opens it in the editor, which needs the real machine.
    name: "hover-card-open-file",
    route: CHATS.deploy,
    ...desktop,
    regions: regions("transcript"),
    covers: { commands: ["chat.getPreview", "chat.touchedFiles", "system.openExternal"] },
    async run(context) {
      await hover(context, sidebarChatRow(context.page, "demo-chat-units"))
      await click(context, context.page.getByRole("button", { name: "Open src/lib/units.ts" }))
      await parkPointer(context)
      await context.capture("needs-machine")
    },
  }),
]
