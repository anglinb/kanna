import { defineScenario, type Scenario } from "../scenario"
import { click, parkPointer, press, regions } from "./_lib/helpers"

// The shared-link dialog (src/foldkit/chat/shareDialog.ts against
// StandaloneShareDialog, which App.tsx renders at layout level), on a
// gallery page: the app's Share sends chat.exportStandalone with
// window.location.origin, which differs between the two apps' ports (see
// chat-navbar.ts). Open on a link, the copy button, closing by Escape and
// the X, and Open, which closes it.
export const scenarios: Scenario[] = [
  defineScenario({
    name: "chat-share-dialog",
    route: "/__gallery/chat-share-dialog",
    viewports: ["desktop", "mobile"],
    regions: regions("dialog"),
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("button", { name: "Share" }))
      await context.capture("open")
      await click(context, page.getByRole("button", { name: "Copy link" }))
      await context.capture("copied")
      await press(context, "Escape")
      await parkPointer(context)
      await context.capture("escape")
      await click(context, page.getByRole("button", { name: "Share" }))
      await click(context, page.getByRole("button", { name: "Close" }))
      await parkPointer(context)
      await context.capture("closed-by-x")
      await click(context, page.getByRole("button", { name: "Share" }))
      await click(context, page.getByRole("button", { name: "Open", exact: true }))
      await parkPointer(context)
      await context.capture("opened")
    },
  }),
]
