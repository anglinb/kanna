import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/skeleton.ts against <Skeleton>.
export const scenarios: Scenario[] = [
  defineScenario({ name: "gallery-ui-skeleton", route: "/__gallery/ui-skeleton", viewports: ["desktop"] }),
]
