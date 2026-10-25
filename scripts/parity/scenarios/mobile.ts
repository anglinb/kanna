import { defineScenario, type Scenario } from "../scenario"
import { CHATS, click, composer, contextClick, countUuids, parkPointer, quickClick, REGIONS, regions, rest, sidebarChatRow, switchSidebarView } from "./_lib/helpers"

// The phone layout (390×844, touch): the sidebar is the page at `/`, a chat
// fills the screen with Back, the widgets slide over it, Enter makes a new
// line (the send button sends). Routes opened on a phone are in routes.ts
// (they run on both viewports); these are the interactions.

const mobile = { viewports: ["mobile" as const] }

export const scenarios: Scenario[] = [
  defineScenario({
    name: "mobile-back-to-sidebar",
    route: CHATS.units,
    ...mobile,
    regions: regions("sidebar"),
    covers: { routes: ["/"] },
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Back" }))
      await context.capture("sidebar")
    },
  }),
  defineScenario({
    name: "mobile-open-chat",
    route: "/",
    ...mobile,
    regions: regions("transcript", "composer"),
    covers: { routes: ["/chat/:chatId"] },
    async run(context) {
      await click(context, context.page.locator("[data-chat-id=demo-chat-deploy]").first())
      await context.capture("chat")
    },
  }),
  defineScenario({
    name: "mobile-new-chat",
    route: "/",
    ...mobile,
    regions: regions("composer"),
    covers: { commands: ["chat.create"] },
    async run(context) {
      await countUuids(context)
      await click(context, context.page.getByRole("button", { name: "New Chat" }))
      await context.capture("new-chat")
    },
  }),
  defineScenario({
    name: "mobile-sidebar-views",
    route: "/",
    ...mobile,
    regions: regions("sidebar"),
    async run(context) {
      await switchSidebarView(context, "Channels")
      await context.capture("channels")
      await countUuids(context)
      await click(context, context.page.locator(REGIONS.sidebar).getByRole("button", { name: /^tidepool/ }).first())
      await context.capture("channel-page")
    },
  }),
  defineScenario({
    name: "mobile-row-menu",
    route: "/",
    ...mobile,
    regions: regions("menu"),
    async run(context) {
      await contextClick(context, sidebarChatRow(context.page, "demo-chat-units").first())
      await context.capture("menu")
    },
  }),
  defineScenario({
    // Over the chat, with a close button. The open column polls: captured at once.
    name: "mobile-widgets-overlay",
    route: CHATS.units,
    ...mobile,
    regions: regions("widgets"),
    async run(context) {
      await quickClick(context, context.page.getByRole("button", { name: "Show widgets" }))
      await context.capture("open")
      // On a phone Escape closes the overlay (ChatPage), and its close button sits under the navbar.
      await context.page.keyboard.press("Escape")
      await context.settle()
      await context.capture("closed")
    },
  }),
  defineScenario({
    name: "mobile-more-actions",
    route: CHATS.units,
    ...mobile,
    regions: regions("menu"),
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "More actions" }))
      await context.capture("menu")
    },
  }),
  defineScenario({
    name: "mobile-search",
    route: CHATS.units,
    ...mobile,
    regions: regions("dialog"),
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Search", exact: true }))
      await context.capture("palette")
    },
  }),
  defineScenario({
    // On a touch screen Enter is a new line; the send button sends.
    name: "mobile-send",
    route: CHATS.units,
    ...mobile,
    regions: regions("transcript", "composer"),
    covers: { commands: ["chat.send"] },
    async run(context) {
      const box = composer(context.page)
      await box.click()
      await box.pressSequentially("Show the swell direction")
      await box.press("Enter")
      await box.pressSequentially("as an arrow")
      await rest(context)
      await context.capture("two-lines")
      await click(context, context.page.getByRole("button", { name: "Send message" }))
      await context.capture("sent")
      await context.advance(30_000)
      await parkPointer(context)
      await context.capture("finished")
    },
  }),
  defineScenario({
    name: "mobile-settings-sections",
    route: "/settings/general",
    ...mobile,
    regions: regions("settings"),
    covers: { routes: ["/settings/:sectionId"] },
    async run(context) {
      await context.page.goto(context.page.url().replace("/settings/general", "/settings/providers"))
      await context.settle()
      await context.capture("providers")
      await context.page.goto(context.page.url().replace("/settings/providers", "/settings/usage"))
      await context.settle()
      await context.capture("usage")
    },
  }),
  defineScenario({
    name: "mobile-composer-picker",
    route: CHATS.units,
    ...mobile,
    regions: regions("popover"),
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Opus", exact: true }))
      await context.capture("models")
    },
  }),
  defineScenario({
    // A phone has its own Attach button in the composer's controls row.
    name: "mobile-attach",
    route: CHATS.units,
    ...mobile,
    regions: regions("composer"),
    async run(context) {
      await context.page.getByLabel("Add attachment").last().setInputFiles([
        { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Low tide at 06:12, swell 1.4 m from the WSW.\n") },
      ])
      await rest(context)
      await parkPointer(context)
      await context.capture("attached")
    },
  }),
]
