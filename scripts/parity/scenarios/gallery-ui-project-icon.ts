import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/project-icon.ts against <ProjectIcon>: monograms for each
// way a name splits, an icon, and an icon that fails and falls back.
export const scenarios: Scenario[] = [
  defineScenario({ name: "gallery-ui-project-icon", route: "/__gallery/ui-project-icon", viewports: ["desktop"] }),
]
