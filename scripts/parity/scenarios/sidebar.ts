import { defineScenario, type Scenario } from "../scenario"
import { CHATS, click, contextClick, countUuids, hover, parkPointer, press, REGIONS, regions, rest, sidebarChatRow, switchSidebarView } from "./_lib/helpers"

// The desktop sidebar: its views (Chats, Projects, Channels, Archived), its
// sections, chat rows and their buttons, and the row and project menus.
// Menus and hover cards opened from the sidebar are compared as their own
// regions too. Phones get their own file (mobile.ts).

const desktop = { viewports: ["desktop" as const] }

export const scenarios: Scenario[] = [
  defineScenario({
    name: "sidebar-collapse-expand",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar", "navbar"),
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("button", { name: "Collapse sidebar" }))
      await parkPointer(context)
      await context.capture("collapsed")
      await click(context, page.getByRole("button", { name: "Expand sidebar" }))
      await parkPointer(context)
      await context.capture("expanded")
    },
  }),
  defineScenario({
    // The separator takes the keyboard: arrows step 16px, Home/End go to the
    // limits, Enter resets. On the settings page: a chat page hands focus
    // back to its composer (useStickyChatFocus), which would race the keys.
    name: "sidebar-resize-keyboard",
    route: "/settings/general",
    ...desktop,
    regions: regions("sidebar"),
    async run(context) {
      const handle = context.page.getByRole("separator", { name: "Resize sidebar" })
      await handle.focus()
      await press(context, "ArrowRight")
      await press(context, "ArrowRight")
      await context.capture("wider")
      await press(context, "Home")
      await context.capture("narrowest")
      await press(context, "End")
      await context.capture("widest")
      await press(context, "Enter")
      await context.capture("reset")
    },
  }),
  defineScenario({
    name: "sidebar-resize-drag",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar"),
    async run(context) {
      const { page } = context
      const box = (await page.getByRole("separator", { name: "Resize sidebar" }).boundingBox())!
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 40, y, { steps: 4 })
      await page.mouse.move(x + 80, y, { steps: 4 })
      await page.mouse.up()
      await parkPointer(context)
      await context.capture("dragged")
      await page.getByRole("separator", { name: "Resize sidebar" }).dblclick()
      await parkPointer(context)
      await context.capture("double-click-reset")
    },
  }),
  defineScenario({
    // Relevant, Today and Yesterday fold on a click of their label; In
    // Progress doesn't fold.
    name: "sidebar-sections-fold",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar"),
    async run(context) {
      const sidebar = context.page.locator(REGIONS.sidebar)
      await click(context, sidebar.getByText("Today", { exact: true }))
      await click(context, sidebar.getByText("Yesterday", { exact: true }))
      await parkPointer(context)
      await context.capture("dates-folded")
      await click(context, sidebar.getByText("Relevant", { exact: true }))
      await parkPointer(context)
      await context.capture("relevant-folded")
      await click(context, sidebar.getByText("Relevant", { exact: true }))
      await parkPointer(context)
      await context.capture("relevant-unfolded")
    },
  }),
  defineScenario({
    // A section's right-click menu: Archive All.
    name: "sidebar-section-menu-archive-all",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar", "menu"),
    covers: { commands: ["chat.archive"] },
    async run(context) {
      const sidebar = context.page.locator(REGIONS.sidebar)
      await contextClick(context, sidebar.getByText("Today", { exact: true }))
      await context.capture("menu")
      await click(context, context.page.getByRole("menuitem", { name: "Archive All" }))
      await parkPointer(context)
      await context.capture("archived")
    },
  }),
  defineScenario({
    name: "sidebar-view-switcher",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar", "popover"),
    async run(context) {
      // CSS: the switcher's trigger is an icon button with no accessible name.
      await click(context, context.page.locator(`${REGIONS.sidebar} button[aria-haspopup=dialog]`).first())
      await context.capture("open")
    },
  }),
  defineScenario({
    name: "sidebar-view-projects",
    // `/`: on a phone the sidebar is the page there.
    route: "/",
    regions: regions("sidebar"),
    async run(context) {
      await switchSidebarView(context, "Projects")
      await context.capture("projects")
    },
  }),
  defineScenario({
    name: "sidebar-view-channels",
    route: "/",
    regions: regions("sidebar"),
    async run(context) {
      await switchSidebarView(context, "Channels")
      await context.capture("channels")
    },
  }),
  defineScenario({
    name: "sidebar-view-archived-empty",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar"),
    async run(context) {
      await switchSidebarView(context, "Archived")
      await context.capture("archived")
    },
  }),
  defineScenario({
    // Archive from the row's button, find it under Archived, restore it.
    name: "sidebar-archive-and-restore",
    route: CHATS.deploy,
    ...desktop,
    regions: regions("sidebar", "menu"),
    covers: { commands: ["chat.archive", "chat.unarchive"] },
    async run(context) {
      const { page } = context
      const row = sidebarChatRow(page, "demo-chat-units")
      await row.hover()
      await click(context, row.getByRole("button", { name: "Archive chat" }))
      await parkPointer(context)
      await context.capture("archived")
      await switchSidebarView(context, "Archived")
      await context.capture("archived-view")
      await contextClick(context, sidebarChatRow(page, "demo-chat-units"))
      await context.capture("archived-row-menu")
      await click(context, page.getByRole("menuitem", { name: "Restore" }))
      await parkPointer(context)
      await context.capture("restored")
    },
  }),
  defineScenario({
    // The row's fork button: the fork opens beside the original.
    name: "sidebar-fork-button",
    route: CHATS.deploy,
    ...desktop,
    regions: regions("sidebar"),
    covers: { commands: ["chat.fork"] },
    async run(context) {
      const row = sidebarChatRow(context.page, "demo-chat-units")
      await row.hover()
      await click(context, row.getByRole("button", { name: "Fork chat" }))
      await parkPointer(context)
      await context.capture("forked")
    },
  }),
  defineScenario({
    name: "sidebar-open-chat",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar", "transcript"),
    covers: { commands: ["chat.markRead"] },
    async run(context) {
      // The Safari chat is unread: opening it marks it read.
      await click(context, sidebarChatRow(context.page, "demo-chat-safari"))
      await parkPointer(context)
      await context.capture("opened-unread")
      await click(context, sidebarChatRow(context.page, "demo-chat-readme"))
      await parkPointer(context)
      await context.capture("opened-running")
    },
  }),
  defineScenario({
    name: "sidebar-chat-row-menu",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar", "menu"),
    async run(context) {
      await contextClick(context, sidebarChatRow(context.page, "demo-chat-units"))
      await context.capture("featured")
    },
  }),
  defineScenario({
    // The row menu of a chat that isn't the open one, and isn't forkable yet.
    name: "sidebar-chat-row-menu-running",
    route: CHATS.units,
    ...desktop,
    regions: regions("menu"),
    async run(context) {
      await contextClick(context, sidebarChatRow(context.page, "demo-chat-readme"))
      await context.capture("running")
    },
  }),
  defineScenario({
    name: "sidebar-chat-pin",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar"),
    covers: { commands: ["chat.setPinned"] },
    async run(context) {
      const { page } = context
      await contextClick(context, sidebarChatRow(page, "demo-chat-rate-limit"))
      await click(context, page.getByRole("menuitem", { name: "Pin" }))
      await parkPointer(context)
      await context.capture("pinned")
      await contextClick(context, sidebarChatRow(page, "demo-chat-rate-limit"))
      await click(context, page.getByRole("menuitem", { name: "Unpin" }))
      await parkPointer(context)
      await context.capture("unpinned")
    },
  }),
  defineScenario({
    name: "sidebar-chat-rename",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar", "dialog"),
    covers: { commands: ["chat.rename"] },
    async run(context) {
      const { page } = context
      await contextClick(context, sidebarChatRow(page, "demo-chat-deploy"))
      await click(context, page.getByRole("menuitem", { name: "Rename" }))
      await context.capture("dialog")
      const field = page.getByRole("dialog", { name: "Rename Chat" }).getByRole("textbox")
      await field.fill("Deploy tidepool on every push")
      await rest(context)
      await context.capture("edited")
      await click(context, page.getByRole("dialog", { name: "Rename Chat" }).getByRole("button", { name: "Rename" }))
      await parkPointer(context)
      await context.capture("renamed")
    },
  }),
  defineScenario({
    name: "sidebar-chat-rename-cancel",
    route: CHATS.units,
    ...desktop,
    regions: regions("dialog"),
    async run(context) {
      const { page } = context
      await contextClick(context, sidebarChatRow(page, "demo-chat-deploy"))
      await click(context, page.getByRole("menuitem", { name: "Rename" }))
      await click(context, page.getByRole("dialog", { name: "Rename Chat" }).getByRole("button", { name: "Cancel" }))
      await parkPointer(context)
      await context.capture("cancelled")
    },
  }),
  defineScenario({
    name: "sidebar-chat-delete",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar", "dialog"),
    covers: { commands: ["chat.delete"] },
    async run(context) {
      const { page } = context
      await contextClick(context, sidebarChatRow(page, "demo-chat-rate-limit"))
      await click(context, page.getByRole("menuitem", { name: "Delete Chat" }))
      await context.capture("confirm")
      await click(context, page.getByRole("dialog", { name: "Delete Chat" }).getByRole("button", { name: "Delete" }))
      await parkPointer(context)
      await context.capture("deleted")
    },
  }),
  defineScenario({
    // Deleting the open chat leaves its page.
    name: "sidebar-chat-delete-open",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar"),
    covers: { commands: ["chat.delete"] },
    async run(context) {
      const { page } = context
      await contextClick(context, sidebarChatRow(page, "demo-chat-units"))
      await click(context, page.getByRole("menuitem", { name: "Delete Chat" }))
      await click(context, page.getByRole("dialog", { name: "Delete Chat" }).getByRole("button", { name: "Delete" }))
      await parkPointer(context)
      await context.capture("deleted")
    },
  }),
  defineScenario({
    name: "sidebar-chat-archive-from-menu",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar"),
    covers: { commands: ["chat.archive"] },
    async run(context) {
      const { page } = context
      await contextClick(context, sidebarChatRow(page, "demo-chat-safari"))
      await click(context, page.getByRole("menuitem", { name: "Archive Chat" }))
      await parkPointer(context)
      await context.capture("archived")
    },
  }),
  defineScenario({
    name: "sidebar-chat-fork-from-menu",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar"),
    covers: { commands: ["chat.fork"] },
    async run(context) {
      const { page } = context
      await contextClick(context, sidebarChatRow(page, "demo-chat-rate-limit"))
      await click(context, page.getByRole("menuitem", { name: "Fork" }))
      await parkPointer(context)
      await context.capture("forked")
    },
  }),
  defineScenario({
    // The Projects view: a project's header menu.
    name: "sidebar-project-menu",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar", "menu"),
    async run(context) {
      await switchSidebarView(context, "Projects")
      await contextClick(context, context.page.locator(REGIONS.sidebar).getByText("tidepool", { exact: true }).first())
      await context.capture("menu")
    },
  }),
  defineScenario({
    // Hovering a project's name shows its path.
    name: "sidebar-project-path-tooltip",
    route: CHATS.units,
    ...desktop,
    regions: regions("tooltip"),
    async run(context) {
      await switchSidebarView(context, "Projects")
      await hover(context, context.page.locator(REGIONS.sidebar).getByText("portfolio", { exact: true }).first())
      await context.capture("tooltip")
    },
  }),
  defineScenario({
    name: "sidebar-channel-menu",
    route: "/",
    ...desktop,
    regions: regions("sidebar", "menu"),
    async run(context) {
      await switchSidebarView(context, "Channels")
      await contextClick(context, context.page.locator(REGIONS.sidebar).getByRole("button", { name: "portfolio" }))
      await context.capture("menu")
    },
  }),
  defineScenario({
    name: "sidebar-settings-button",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar"),
    covers: { routes: ["/settings/:sectionId"] },
    async run(context) {
      await click(context, context.page.locator(REGIONS.sidebar).getByRole("button", { name: "Settings Connected" }))
      await parkPointer(context)
      await context.capture("settings")
    },
  }),
  defineScenario({
    // New Chat starts an empty chat in the open chat's project.
    name: "sidebar-new-chat",
    route: CHATS.units,
    regions: regions("sidebar", "composer"),
    covers: { commands: ["chat.create"] },
    async run(context) {
      await countUuids(context)
      await click(context, context.page.locator(REGIONS.sidebar).getByRole("button", { name: "New Chat" }))
      await parkPointer(context)
      await context.capture("new-chat")
    },
  }),
  defineScenario({
    // A new chat, then its first prompt: the chat takes its title from it.
    name: "sidebar-new-chat-first-prompt",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar", "transcript"),
    covers: { commands: ["chat.create", "chat.send"] },
    async run(context) {
      const { page } = context
      await countUuids(context)
      await click(context, page.locator(REGIONS.sidebar).getByRole("button", { name: "New Chat" }))
      const composer = page.locator("textarea[data-chat-input]")
      await composer.click()
      await composer.pressSequentially("Add a dark mode to the forecast page")
      await composer.press("Enter")
      await rest(context)
      await context.capture("sent")
      await context.advance(30_000)
      await parkPointer(context)
      await context.capture("finished")
    },
  }),
  defineScenario({
    // In the Channels view a channel opens a new chat in its project.
    name: "sidebar-channel-open",
    route: "/",
    ...desktop,
    regions: regions("sidebar"),
    covers: { commands: ["chat.create"] },
    async run(context) {
      await switchSidebarView(context, "Channels")
      await countUuids(context)
      await click(context, context.page.locator(REGIONS.sidebar).getByRole("button", { name: "portfolio" }))
      await parkPointer(context)
      await context.capture("opened")
    },
  }),
  defineScenario({
    name: "sidebar-channel-hover-card",
    route: "/",
    ...desktop,
    regions: regions("popover"),
    async run(context) {
      await switchSidebarView(context, "Channels")
      await hover(context, context.page.locator(REGIONS.sidebar).getByRole("button", { name: "tidepool 2" }))
      await context.capture("card")
    },
  }),
  defineScenario({
    name: "sidebar-channel-pin",
    route: "/",
    ...desktop,
    regions: regions("sidebar"),
    covers: { commands: ["project.setPinned"] },
    async run(context) {
      const { page } = context
      await switchSidebarView(context, "Channels")
      await contextClick(context, page.locator(REGIONS.sidebar).getByRole("button", { name: "portfolio" }))
      await click(context, page.getByRole("menuitem", { name: "Pin" }))
      await parkPointer(context)
      await context.capture("pinned")
    },
  }),
  defineScenario({
    // Search opens the command palette.
    name: "sidebar-search-button",
    route: CHATS.units,
    ...desktop,
    regions: regions("dialog"),
    async run(context) {
      await click(context, context.page.locator(REGIONS.sidebar).getByRole("button", { name: "Search" }))
      await context.capture("palette")
    },
  }),
  defineScenario({
    // Add project opens the palette on its Add Project page.
    name: "sidebar-add-project-button",
    route: CHATS.units,
    ...desktop,
    regions: regions("dialog"),
    async run(context) {
      await click(context, context.page.locator(REGIONS.sidebar).getByRole("button", { name: "Add project" }))
      await context.capture("palette")
    },
  }),
  defineScenario({
    // The Kanna title goes to the projects page.
    name: "sidebar-title-button",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar"),
    covers: { routes: ["/"] },
    async run(context) {
      await click(context, context.page.locator(REGIONS.sidebar).getByRole("button", { name: "Kanna" }).first())
      await parkPointer(context)
      await context.capture("projects")
    },
  }),
  defineScenario({
    // The Projects view: a project's new-chat and collapse buttons, with their tooltips.
    name: "sidebar-project-header-buttons",
    route: "/",
    ...desktop,
    regions: regions("sidebar", "tooltip", "menu"),
    async run(context) {
      const { page } = context
      await switchSidebarView(context, "Projects")
      const sidebar = page.locator(REGIONS.sidebar)
      // (Not via the project's name: its path tooltip would cover the buttons.)
      // CSS: the header's icon buttons have no accessible name, only a
      // tooltip; they are told apart by their lucide icons.
      const more = sidebar.locator("button:has(svg.lucide-ellipsis)").first()
      await hover(context, more)
      await context.capture("more-tooltip")
      await click(context, more)
      await context.capture("more-menu")
    },
  }),
  defineScenario({
    // The header's pen button starts a chat in that project.
    name: "sidebar-project-header-new-chat",
    route: "/",
    ...desktop,
    regions: regions("sidebar", "composer"),
    covers: { commands: ["chat.create"] },
    async run(context) {
      await switchSidebarView(context, "Projects")
      await countUuids(context)
      // CSS: the first pen is the sidebar's own New Chat; the next is the first project's.
      await click(context, context.page.locator(REGIONS.sidebar).locator("button:has(svg.lucide-square-pen)").nth(1))
      await parkPointer(context)
      await context.capture("new-chat")
    },
  }),
]
