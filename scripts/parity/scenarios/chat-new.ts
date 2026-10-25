import { defineScenario, type Scenario } from "../scenario"

// A chat made from the sidebar's New Chat: the chat page as it opens on a
// chat started from this window, before and after its snapshot comes (the
// new chat page, then the chat). The demo names a new chat "New chat", so
// once its snapshot is in it reads as a chat, not the new chat page.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "chat-new",
    route: "/chat/demo-chat-units",
    viewports: ["desktop"],
    regions: { navbar: '[class*="group/navbar"]' },
    covers: { commands: ["chat.create"] },
    async run({ page, capture }) {
      await page.getByRole("button", { name: "New Chat" }).first().click()
      await page.waitForURL(/\/chat\/(?!demo-chat-units)/)
      await capture("opened")
    },
  }),
]
