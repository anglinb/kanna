import { defineScenario, type Scenario } from "../scenario"

// The scenario list. Seeded with one per main route for the harness
// selfcheck; the full list (every route, dialog, menu, keybinding and
// ClientCommand) is written before any porting starts.

export const scenarios: Scenario[] = [
  defineScenario({
    name: "home",
    route: "/home",
    covers: { routes: ["/home"] },
  }),
  defineScenario({
    name: "chat-featured",
    route: "/chat/demo-chat-units",
    covers: { routes: ["/chat/:chatId"] },
  }),
  defineScenario({
    name: "settings-general",
    route: "/settings/general",
    covers: { routes: ["/settings/:sectionId"] },
  }),
]
