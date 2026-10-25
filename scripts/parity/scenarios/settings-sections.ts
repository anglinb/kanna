import { defineScenario, type Scenario } from "../scenario"
import { regions as pick } from "./_lib/helpers"

// The settings page, one scenario per section, opened and left alone, in
// every variant: the page itself (its own section list, the section and the
// footer), and the whole window beside it. The unknown section shows General
// and replaces its URL.

const regions = pick("settings")

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
