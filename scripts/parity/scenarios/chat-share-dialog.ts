import { defineScenario, type Scenario } from "../scenario"

// The shared-link dialog (src/foldkit/chat/shareDialog.ts against
// StandaloneShareDialog, which App.tsx renders at layout level): open on a
// link, the copy button, closing by Escape and the X, and Open, which
// closes it.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "chat-share-dialog",
    route: "/__gallery/chat-share-dialog",
    viewports: ["desktop", "mobile"],
    async run({ page, capture }) {
      await page.getByRole("button", { name: "Share" }).click()
      await capture("open")
      await page.getByRole("button", { name: "Copy link" }).click()
      await capture("copied")
      await page.keyboard.press("Escape")
      await capture("escape")
      await page.getByRole("button", { name: "Share" }).click()
      await page.getByRole("button", { name: "Close" }).click()
      await capture("closed-by-x")
      await page.getByRole("button", { name: "Share" }).click()
      await page.getByRole("button", { name: "Open", exact: true }).click()
      await capture("opened")
    },
  }),
]
