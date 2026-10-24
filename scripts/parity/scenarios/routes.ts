import { defineScenario, type Scenario } from "../scenario"

// One per main route, opened and left alone.

export const scenarios: Scenario[] = [
  defineScenario({
    name: "home",
    route: "/home",
    regions: { sidebar: "[data-sidebar=open]" },
    covers: { routes: ["/home"] },
  }),
  defineScenario({
    name: "chat-featured",
    route: "/chat/demo-chat-units",
    regions: { sidebar: "[data-sidebar=open]" },
    covers: { routes: ["/chat/:chatId"] },
  }),
  defineScenario({
    name: "settings-general",
    route: "/settings/general",
    regions: { sidebar: "[data-sidebar=open]" },
    covers: { routes: ["/settings/:sectionId"] },
  }),
]
