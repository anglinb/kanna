import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/kbd.ts against <Kbd> and <KbdGroup>.
export const scenarios: Scenario[] = [
  defineScenario({ name: "gallery-ui-kbd", route: "/__gallery/ui-kbd", viewports: ["desktop"] }),
]
