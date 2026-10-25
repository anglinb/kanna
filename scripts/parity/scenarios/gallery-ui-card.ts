import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/card.ts against the React card blocks.
export const scenarios: Scenario[] = [
  defineScenario({ name: "gallery-ui-card", route: "/__gallery/ui-card", viewports: ["desktop"] }),
]
