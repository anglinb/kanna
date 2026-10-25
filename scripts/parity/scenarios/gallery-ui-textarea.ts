import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/textarea.ts against <Textarea>: placeholder, disabled, then typing.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-ui-textarea",
    route: "/__gallery/ui-textarea",
    viewports: ["desktop"],
    async run({ page, capture }) {
      await capture("states")
      await page.getByRole("textbox", { name: "Commit message" }).fill("Port the shared UI primitives")
      await capture("typed")
    },
  }),
]
