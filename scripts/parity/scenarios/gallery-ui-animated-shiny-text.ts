import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/animated-shiny-text.ts against <AnimatedShinyText>: animated,
// still, and truncating with markup inside.
export const scenarios: Scenario[] = [
  defineScenario({ name: "gallery-ui-animated-shiny-text", route: "/__gallery/ui-animated-shiny-text", viewports: ["desktop"] }),
]
