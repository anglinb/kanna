import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/icons.ts against lucide-react, every icon the client uses.
export const scenarios: Scenario[] = [
  defineScenario({ name: "gallery-icons", route: "/__gallery/icons", viewports: ["desktop"] }),
]
