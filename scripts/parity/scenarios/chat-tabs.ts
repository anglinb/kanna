import type { Page } from "playwright"
import { defineScenario, type Scenario, type ScenarioContext } from "../scenario"
import { click, contextClick, parkPointer, REGIONS, regions, sidebarChatRow } from "./_lib/helpers"

// Chat tabs (Settings → General → Chat Tabs): the open chats as tabs in the
// title bar, switched, closed one by one or from a tab's menu.

const desktop = { viewports: ["desktop" as const] }

function tabs(page: Page) {
  return page.getByRole("tablist", { name: "Open chats" })
}

/** Turns tabs on and opens three chats. */
async function openThreeTabs(context: ScenarioContext) {
  const { page } = context
  await click(context, page.getByRole("switch", { name: "Chat Tabs" }))
  for (const chatId of ["demo-chat-units", "demo-chat-deploy", "demo-chat-safari"]) {
    await click(context, sidebarChatRow(page, chatId))
  }
  await parkPointer(context)
}

export const scenarios: Scenario[] = [
  defineScenario({
    name: "chat-tabs-switch",
    route: "/settings/general",
    ...desktop,
    regions: regions("navbar"),
    covers: { commands: ["settings.writeAppSettingsPatch"] },
    async run(context) {
      await openThreeTabs(context)
      await context.capture("three-tabs")
      await click(context, tabs(context.page).getByRole("tab").first())
      await parkPointer(context)
      await context.capture("first-tab")
    },
  }),
  defineScenario({
    name: "chat-tabs-close",
    route: "/settings/general",
    ...desktop,
    regions: regions("navbar"),
    async run(context) {
      await openThreeTabs(context)
      await click(context, tabs(context.page).getByRole("button", { name: "Close Set up deploys on push" }))
      await parkPointer(context)
      await context.capture("closed-middle")
    },
  }),
  defineScenario({
    name: "chat-tabs-menu",
    route: "/settings/general",
    ...desktop,
    regions: regions("navbar", "menu"),
    async run(context) {
      await openThreeTabs(context)
      await contextClick(context, tabs(context.page).getByRole("tab").first())
      await context.capture("menu")
      await click(context, context.page.getByRole("menuitem", { name: /Close Others/ }))
      await parkPointer(context)
      await context.capture("closed-others")
    },
  }),
  defineScenario({
    name: "chat-tabs-active-actions",
    route: "/settings/general",
    ...desktop,
    regions: regions("menu"),
    async run(context) {
      await openThreeTabs(context)
      await click(context, context.page.locator(REGIONS.navbar).getByRole("button", { name: "Chat actions" }).first())
      await context.capture("menu")
    },
  }),
]
