import { defineScenario, type Scenario } from "../scenario"
import { CHATS, regions } from "./_lib/helpers"

// One per route in App.tsx, opened and left alone. Interactions live in the
// area files (sidebar.ts, composer.ts, …).

export const scenarios: Scenario[] = [
  defineScenario({
    name: "home",
    route: "/home",
    regions: regions("sidebar"),
    covers: { routes: ["/home"], commands: ["github.listRecentRepos", "update.check", "settings.readAppSettings", "settings.readLlmProvider", "chat.setDraftProtection"] },
  }),
  defineScenario({
    // Desktop shows the projects page at `/` too; on a phone the sidebar fills the screen there.
    name: "root",
    route: "/",
    regions: regions("sidebar"),
    covers: { routes: ["/"] },
  }),
  defineScenario({
    name: "chat-featured",
    route: CHATS.units,
    regions: regions("sidebar", "navbar", "transcript", "composer"),
    covers: { routes: ["/chat/:chatId"], commands: ["project.readQuickActions", "chat.refreshDiffs"] },
  }),
  defineScenario({
    // A chat id the server doesn't know: the page falls back to `/`.
    name: "chat-missing",
    route: "/chat/no-such-chat",
    viewports: ["desktop"],
    covers: { routes: ["/chat/:chatId"] },
  }),
  defineScenario({
    name: "settings-general",
    route: "/settings/general",
    regions: regions("sidebar", "settings"),
    covers: { routes: ["/settings/:sectionId"] },
  }),
  defineScenario({
    // Redirects to /settings/general.
    name: "settings-index",
    route: "/settings",
    viewports: ["desktop"],
    regions: regions("settings"),
    covers: { routes: ["/settings"] },
  }),
  defineScenario({
    // The sidebar focused on one project; beside it on desktop, what `/` shows.
    name: "project-page",
    route: "/project/demo-project-tidepool",
    regions: regions("sidebar"),
    covers: { routes: ["/project/:projectId"] },
  }),
  defineScenario({
    // The full-screen terminal page exists only on a dev box; the demo isn't
    // one, so this is the redirect to `/`.
    name: "terminal-page-redirect",
    route: "/terminal",
    viewports: ["desktop"],
    covers: { routes: ["/terminal"] },
  }),
  defineScenario({
    // Every state of the Tasks and Workflow widgets, on made-up data.
    name: "workflows-gallery",
    route: "/workflows",
    viewports: ["desktop"],
    covers: { routes: ["/workflows"] },
  }),
  defineScenario({
    // Opened bare, without the code OpenRouter would add: the error state.
    name: "openrouter-callback",
    route: "/oauth/openrouter/callback",
    viewports: ["desktop"],
    covers: { routes: ["/oauth/openrouter/callback"] },
  }),
]
