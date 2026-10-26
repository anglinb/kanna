import { defineScenario, type Scenario } from "../scenario"

// Proves the gallery mechanism (src/parity/gallery.ts): one trivial page, the
// same in both apps.
export const scenarios: Scenario[] = [
  defineScenario({ name: "gallery-smoke", route: "/__gallery/smoke", viewports: ["desktop"] }),
]
