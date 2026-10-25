import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/input.ts against <Input>: value, placeholder, disabled,
// password; then typing into the controlled one.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-ui-input",
    route: "/__gallery/ui-input",
    viewports: ["desktop"],
    async run({ page, capture }) {
      await capture("states")
      await page.getByRole("textbox", { name: "Name" }).fill("kanna foldkit")
      await capture("typed")
    },
  }),
]
