import { defineScenario, type Scenario } from "../scenario"

// The left sidebar (src/client/app/KannaSidebar.tsx, ported to
// src/foldkit/sidebar): collapsing it, its sections, the chat hover card,
// the right-click menus and the dialogs they open, the view switcher and
// its views, the keyboard's number jump, and the phone layout.
//
// Driven from /settings/general: the sidebar is the same there as anywhere,
// and the page beside it sends no commands of its own to tell apart.

const SIDEBAR = "[data-sidebar=open]"
const REGIONS = {
  sidebar: SIDEBAR,
  menu: "[role=menu]",
  card: "[data-list-hover-card]",
  dialog: "[role=dialog]:not([data-list-hover-card])",
}

export const scenarios: Scenario[] = [
  defineScenario({
    name: "sidebar-collapse",
    route: "/settings/general",
    viewports: ["desktop"],
    regions: {
      sidebar: SIDEBAR,
      expand: "div:has(> div > button[title='Expand sidebar'])",
    },
    covers: { routes: ["/settings/:sectionId"] },
    async run({ page, capture, settle }) {
      await page.getByRole("button", { name: "Collapse sidebar" }).click()
      await settle()
      await capture("collapsed")
      await page.getByRole("button", { name: "Expand sidebar" }).click()
      await settle()
      await capture("expanded")
    },
  }),
  defineScenario({
    name: "sidebar-sections",
    route: "/settings/general",
    viewports: ["desktop"],
    regions: { sidebar: SIDEBAR },
    async run({ page, capture, settle }) {
      const sidebar = page.locator(SIDEBAR)
      await sidebar.getByText("Yesterday", { exact: true }).click()
      await settle()
      await capture("yesterday-open")
      await sidebar.getByText("Relevant", { exact: true }).click()
      await settle()
      await capture("relevant-folded")
    },
  }),
  defineScenario({
    name: "sidebar-hover-card",
    route: "/settings/general",
    viewports: ["desktop"],
    regions: REGIONS,
    covers: { commands: ["chat.getPreview", "chat.touchedFiles"] },
    async run({ page, capture, settle }) {
      const sidebar = page.locator(SIDEBAR)
      await sidebar.getByText("Set up deploys on push").hover()
      await settle()
      await capture("card")
      await sidebar.getByText("Fix blank tide chart", { exact: false }).hover()
      await settle()
      await capture("next-row")
      await page.mouse.move(900, 450)
      await settle()
      await capture("left")
    },
  }),
  defineScenario({
    name: "sidebar-chat-menu",
    route: "/settings/general",
    viewports: ["desktop"],
    regions: REGIONS,
    async run({ page, capture, settle }) {
      const row = page.locator(SIDEBAR).getByText("Set up deploys on push")
      await row.click({ button: "right" })
      await settle()
      await capture("open")
      await page.keyboard.press("Escape")
      await settle()
      await capture("closed")
      await row.click({ button: "right" })
      await page.getByRole("menuitem", { name: "Rename" }).click()
      await settle()
      await capture("rename-dialog")
      await page.keyboard.press("Escape")
      await settle()
      await row.click({ button: "right" })
      await page.getByRole("menuitem", { name: "Delete Chat" }).click()
      await settle()
      await capture("delete-dialog")
    },
  }),
  defineScenario({
    name: "sidebar-section-menu",
    route: "/settings/general",
    viewports: ["desktop"],
    regions: REGIONS,
    async run({ page, capture, settle }) {
      await page.locator(SIDEBAR).getByText("Today", { exact: true }).click({ button: "right" })
      await settle()
      await capture("open")
    },
  }),
  defineScenario({
    name: "sidebar-views",
    route: "/settings/general",
    viewports: ["desktop"],
    regions: REGIONS,
    async run({ page, capture, settle }) {
      const switcher = page.locator(SIDEBAR).locator("button[aria-haspopup=dialog]").first()
      await switcher.click()
      await settle()
      await capture("switcher")
      await page.getByRole("button", { name: "Projects" }).last().click()
      await settle()
      await capture("projects")
      await switcher.click()
      await page.getByRole("button", { name: "Channels" }).click()
      await settle()
      await capture("channels")
      await switcher.click()
      await page.getByRole("button", { name: "Archived" }).click()
      await settle()
      await capture("archived")
    },
  }),
  defineScenario({
    name: "sidebar-projects-view",
    covers: { keybindings: ["jumpToSidebarChat"] },
    route: "/settings/general",
    viewports: ["desktop"],
    regions: REGIONS,
    async run({ page, capture, settle }) {
      const sidebar = page.locator(SIDEBAR)
      await sidebar.locator("button[aria-haspopup=dialog]").first().click()
      await page.getByRole("button", { name: "Projects" }).last().click()
      await settle()
      // Holding the number-jump modifier swaps each row's age for its keycap.
      await page.keyboard.down("Meta")
      await page.keyboard.down("Alt")
      await settle()
      await capture("number-hints")
      await page.keyboard.up("Alt")
      await page.keyboard.up("Meta")
      await settle()
      const header = sidebar.getByText("tidepool", { exact: true }).first()
      await header.click()
      await settle()
      await capture("folded")
      await header.click({ button: "right" })
      await settle()
      await capture("project-menu")
      await page.getByRole("menuitem", { name: "Show Archived" }).click()
      await settle()
      await capture("archived-dialog")
    },
  }),
  defineScenario({
    name: "sidebar-channels",
    route: "/settings/general",
    viewports: ["desktop"],
    regions: REGIONS,
    async run({ page, capture, settle }) {
      const sidebar = page.locator(SIDEBAR)
      await sidebar.locator("button[aria-haspopup=dialog]").first().click()
      await page.getByRole("button", { name: "Channels" }).click()
      await settle()
      await sidebar.locator("[data-channel-id]").first().hover()
      await settle()
      await capture("channel-card")
      await sidebar.locator("[data-channel-id]").first().click({ button: "right" })
      await settle()
      await capture("channel-menu")
    },
  }),
  defineScenario({
    name: "sidebar-mobile",
    route: "/",
    viewports: ["mobile"],
    regions: { sidebar: SIDEBAR },
    async run({ page, capture, settle }) {
      await capture("root")
      await page.locator(SIDEBAR).getByText("Yesterday", { exact: true }).click()
      await settle()
      await capture("yesterday-open")
    },
  }),
]
