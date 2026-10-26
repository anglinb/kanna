import { defineScenario, type Scenario } from "../scenario"

// src/foldkit/ui/app-dialog.ts against the React app dialog: a destructive
// confirm answered by Enter, a prompt with its text selected, edited, reset
// and submitted, a cancelled prompt, an alert with its hidden Cancel.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-ui-app-dialog",
    route: "/__gallery/ui-app-dialog",
    viewports: ["desktop"],
    async run({ page, capture }) {
      await page.getByRole("button", { name: "Delete project" }).click()
      await capture("confirm")
      await page.keyboard.press("Enter")
      await capture("confirmed")
      await page.getByRole("button", { name: "Rename" }).click()
      await capture("prompt")
      await page.keyboard.press("Backspace")
      await capture("prompt-emptied")
      await page.getByRole("button", { name: "Use generated title" }).click()
      await capture("prompt-reset")
      await page.getByRole("textbox").press("Enter")
      await capture("prompted")
      await page.getByRole("button", { name: "Rename" }).click()
      // A key pressed before the dialog is on screen goes nowhere: Foldkit
      // renders on the next frame, React within the click.
      await page.getByRole("dialog").waitFor()
      await page.keyboard.press("Escape")
      await capture("prompt-cancelled")
      await page.getByRole("button", { name: "About" }).click()
      await capture("alert")
      await page.getByRole("button", { name: "OK" }).click()
      await capture("alerted")
    },
  }),
]
