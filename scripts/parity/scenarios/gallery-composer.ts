import { defineScenario, type Scenario } from "../scenario"
import { click, composer, hover, parkPointer, press, rest, typeIntoComposer } from "./_lib/helpers"

// The chat composer on its own (src/foldkit/composer against ChatInput), on
// a gallery page docked at the foot of the window, in the states
// src/parity/react/gallery/support/composer-states.ts names: what it shows
// with nothing, a draft, staged files, a turn running, no project, a
// context meter, signed-out harnesses, two accounts, a delegator; and the
// "/" and "@" menus, the pickers, Arrow Up, Escape held. Away from the chat
// page, nothing under the dock differs between the apps.

const at = (state: string) => `/__gallery/composer?state=${state}`
const desktop = { viewports: ["desktop" as const] }

export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-composer-states",
    route: at("empty"),
    async run(context) {
      await rest(context)
      await context.capture("empty")
    },
  }),
  defineScenario({
    name: "gallery-composer-draft",
    route: at("draft"),
    async run(context) {
      await rest(context)
      await context.capture("draft")
    },
  }),
  defineScenario({
    name: "gallery-composer-multiline",
    route: at("multiline"),
    async run(context) {
      await rest(context)
      await context.capture("multiline")
    },
  }),
  defineScenario({
    name: "gallery-composer-attachments",
    route: at("attachments"),
    async run(context) {
      await rest(context)
      await context.capture("attachments")
      await click(context, context.page.getByRole("button", { name: "Remove tide-notes.txt" }))
      await parkPointer(context)
      await context.capture("removed")
    },
  }),
  defineScenario({
    // A turn running: the round button is Stop, and the mic stays.
    name: "gallery-composer-processing",
    route: at("processing"),
    async run(context) {
      await rest(context)
      await context.capture("stop")
    },
  }),
  defineScenario({
    // Something to send while a turn runs: Send, and no mic.
    name: "gallery-composer-processing-draft",
    route: at("processing-draft"),
    async run(context) {
      await rest(context)
      await context.capture("send")
    },
  }),
  defineScenario({
    // Escape held to the end stops the turn: the ring closes round Stop.
    name: "gallery-composer-hold-to-stop",
    route: at("processing"),
    ...desktop,
    async run(context) {
      const { page } = context
      await composer(page).click()
      await page.keyboard.down("Escape")
      await page.waitForTimeout(800)
      await page.keyboard.up("Escape")
      await context.capture("held")
    },
  }),
  defineScenario({
    name: "gallery-composer-disabled",
    route: at("disabled"),
    async run(context) {
      await rest(context)
      await context.capture("disabled")
    },
  }),
  defineScenario({
    // Outside a project a file can't be attached, and the composer says so.
    name: "gallery-composer-no-project",
    route: at("no-project"),
    ...desktop,
    async run(context) {
      const { page } = context
      await rest(context)
      await context.capture("placeholder")
      await page.locator("input[type=file][aria-label='Add attachment']").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Low tide at 06:12.\n") })
      await rest(context)
      await context.capture("needs-project")
    },
  }),
  defineScenario({
    name: "gallery-composer-meter",
    route: at("meter"),
    async run(context) {
      await rest(context)
      await context.capture("meter")
    },
  }),
  defineScenario({
    name: "gallery-composer-meter-tooltip",
    route: at("meter"),
    ...desktop,
    async run(context) {
      await hover(context, context.page.getByRole("button", { name: /^Context window/ }).last())
      await context.capture("tooltip")
    },
  }),
  defineScenario({
    // Signed-out harnesses sink to the bottom of the picker, marked Sign In.
    name: "gallery-composer-unauthenticated",
    route: at("unauthenticated"),
    ...desktop,
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Claude", exact: true }))
      await context.capture("picker")
    },
  }),
  defineScenario({
    name: "gallery-composer-accounts",
    route: at("accounts"),
    ...desktop,
    async run(context) {
      await rest(context)
      await context.capture("account-pill")
      await click(context, context.page.getByRole("button", { name: "Personal", exact: true }))
      await context.capture("open")
      await click(context, context.page.getByRole("dialog").getByRole("button", { name: /^Work/ }))
      await parkPointer(context)
      await context.capture("work")
    },
  }),
  defineScenario({
    // The new chat page with delegators: the message goes to one of them.
    name: "gallery-composer-delegate",
    route: at("delegate"),
    async run(context) {
      await rest(context)
      await context.capture("delegating")
      await click(context, context.page.getByRole("button", { name: "Release captain", exact: true }))
      await context.capture("open")
      await click(context, context.page.getByRole("dialog").getByRole("button", { name: /^Don't Delegate/ }))
      await parkPointer(context)
      await context.capture("not-delegating")
    },
  }),
  defineScenario({
    name: "gallery-composer-slash-menu",
    route: at("empty"),
    ...desktop,
    async run(context) {
      await typeIntoComposer(context, "/")
      await context.capture("open")
      await press(context, "ArrowUp")
      await press(context, "ArrowUp")
      await context.capture("moved")
      await hover(context, context.page.getByRole("option", { name: /^\/init/ }))
      await context.capture("hovered")
      await typeIntoComposer(context, "re")
      await context.capture("filtered")
      await press(context, "Enter")
      await context.capture("accepted")
    },
  }),
  defineScenario({
    name: "gallery-composer-mention-menu",
    route: at("empty"),
    ...desktop,
    async run(context) {
      await typeIntoComposer(context, "Compare with @")
      await context.capture("open")
      await press(context, "ArrowUp")
      await context.capture("moved")
      await typeIntoComposer(context, "por")
      await context.capture("filtered")
      await press(context, "Escape")
      await context.capture("dismissed")
      await typeIntoComposer(context, "t")
      await press(context, "Tab")
      await context.capture("accepted")
    },
  }),
  defineScenario({
    name: "gallery-composer-recall",
    route: at("recall"),
    ...desktop,
    async run(context) {
      await composer(context.page).click()
      await press(context, "ArrowUp")
      await context.capture("recalled")
      await press(context, "Enter")
      await context.capture("sent")
    },
  }),
  defineScenario({
    name: "gallery-composer-pickers",
    route: at("empty"),
    ...desktop,
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("button", { name: "Opus", exact: true }))
      await context.capture("model")
      await press(context, "Escape")
      await click(context, page.getByRole("button", { name: "High", exact: true }))
      await context.capture("effort")
      await click(context, page.getByRole("dialog").getByRole("button", { name: /^Low/ }))
      await click(context, page.getByRole("button", { name: "Standard", exact: true }))
      await context.capture("speed")
      await press(context, "Escape")
      await composer(page).click()
      await press(context, "Shift+Tab")
      await click(context, page.getByRole("button", { name: "Plan Mode", exact: true }))
      await context.capture("mode")
      await click(context, page.getByRole("dialog").getByRole("button", { name: /^Auto Plan/ }))
      await parkPointer(context)
      await context.capture("auto-plan")
    },
  }),
]
