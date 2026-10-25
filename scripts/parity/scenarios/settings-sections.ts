import { defineScenario, type Scenario } from "../scenario"

// The settings page, one scenario per section, opened and left alone.
// `settings` is the page itself (its own section list, the section and the
// footer), without the app sidebar beside it. While the app sidebar is
// React-only the page is narrower beside it on desktop, so `content` (the
// section, a fixed max-w-4xl column) and `nav` (the section list) are
// compared on their own there. MCP Servers has no scenario: the demo backend
// answers no `mcp.*` command.

export const SETTINGS_REGIONS = {
  settings: "[data-settings-page]",
  content: "[data-settings-page] .\\@container",
  nav: "[data-settings-page] aside",
}
const regions = SETTINGS_REGIONS

export const scenarios: Scenario[] = [
  defineScenario({
    name: "settings-page-general",
    route: "/settings/general",
    regions,
    covers: { routes: ["/settings/:sectionId"] },
  }),
  defineScenario({
    name: "settings-page-providers",
    route: "/settings/providers",
    regions,
    covers: { routes: ["/settings/:sectionId"], commands: ["settings.readLlmProvider"] },
  }),
  defineScenario({
    name: "settings-page-skills",
    route: "/settings/skills",
    regions,
    covers: { routes: ["/settings/:sectionId"], commands: ["skills.listGlobal"] },
  }),
  defineScenario({
    name: "settings-page-keybindings",
    route: "/settings/keybindings",
    regions,
    covers: { routes: ["/settings/:sectionId"] },
  }),
  defineScenario({
    name: "settings-page-usage",
    route: "/settings/usage",
    regions,
    covers: { routes: ["/settings/:sectionId"], commands: ["usage.refresh"] },
  }),
  defineScenario({
    name: "settings-page-labs",
    route: "/settings/labs",
    regions,
    covers: { routes: ["/settings/:sectionId"] },
  }),
  defineScenario({
    name: "settings-page-changelog",
    route: "/settings/changelog",
    regions,
    covers: { routes: ["/settings/:sectionId"] },
  }),
  defineScenario({
    name: "settings-page-unknown-section",
    route: "/settings/nope",
    regions,
    covers: { routes: ["/settings/:sectionId"] },
  }),
]
