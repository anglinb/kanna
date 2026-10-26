import type { Page } from "playwright"
import { defineScenario, type Scenario, type ScenarioContext } from "../scenario"
import { CHATS, click, parkPointer, press, REGIONS, regions, rest } from "./_lib/helpers"

// The embedded terminal under a chat: opening it (button and ⌘J), the
// simulated shell answering a command, a split pane (button and ⌘/),
// clearing, hiding, and the row separator.
//
// A new pane subscribes to its terminal, then sends terminal.create. The
// demo answers the subscription with a null snapshot (no shell yet), and a
// pane that hears "no shell" after its create went out sends a second
// create: a race between the fake socket's round trip and the pane's frames,
// so React against React sent one create or two from run to run. As in
// terminal-page.ts, those null snapshots are addressed to no subscription
// (the frames only; the backend is untouched), which leaves one create per
// pane, every run. Every scenario here starts with `withoutNoShellReplies`.

const desktop = { viewports: ["desktop" as const] }

/** Reloads the chat with the demo's "no shell yet" terminal snapshots dropped (see above). */
async function withoutNoShellReplies(context: ScenarioContext) {
  await context.page.addInitScript(() => {
    const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")!
    Object.defineProperty(MessageEvent.prototype, "data", {
      configurable: true,
      get(this: MessageEvent) {
        const value = data.get!.call(this) as unknown
        if (typeof value !== "string") return value
        return value.includes("\"snapshot\":{\"type\":\"terminal\",\"data\":null}") ? value.replace("\"id\":\"", "\"id\":\"parity-dropped-") : value
      },
    })
  })
  await context.page.reload()
  await context.settle()
}

function terminalPane(page: Page) {
  return page.locator(REGIONS.terminal)
}

/** The navbar's terminal button. CSS: an icon button with no accessible name; its icon is lucide's terminal. */
async function openTerminalFromNavbar(context: ScenarioContext) {
  await click(context, context.page.locator(REGIONS.navbar).locator("button:has(svg.lucide-terminal)").first())
  await parkPointer(context)
}

export const scenarios: Scenario[] = [
  defineScenario({
    name: "terminal-open-from-navbar",
    route: CHATS.units,
    ...desktop,
    regions: regions("terminal"),
    covers: { commands: ["terminal.create", "terminal.tail"] },
    async run(context) {
      await withoutNoShellReplies(context)
      await openTerminalFromNavbar(context)
      await context.capture("open")
    },
  }),
  defineScenario({
    name: "terminal-toggle-keybinding",
    route: CHATS.units,
    ...desktop,
    regions: regions("terminal"),
    covers: { keybindings: ["toggleEmbeddedTerminal"], commands: ["terminal.create"] },
    async run(context) {
      await withoutNoShellReplies(context)
      await press(context, "Meta+j")
      await parkPointer(context)
      await context.capture("open")
      await press(context, "Meta+j")
      await parkPointer(context)
      await context.capture("closed")
    },
  }),
  defineScenario({
    // The simulated shell answers ls and git status from the demo project.
    name: "terminal-run-commands",
    route: CHATS.units,
    ...desktop,
    regions: regions("terminal"),
    covers: { commands: ["terminal.input"] },
    async run(context) {
      await withoutNoShellReplies(context)
      const { page } = context
      await openTerminalFromNavbar(context)
      const input = page.getByRole("textbox", { name: "Terminal input" })
      await input.focus()
      await page.keyboard.type("ls")
      await press(context, "Enter")
      await page.keyboard.type("git status")
      await press(context, "Enter")
      await context.capture("output")
    },
  }),
  defineScenario({
    name: "terminal-split-and-close",
    route: CHATS.units,
    ...desktop,
    regions: regions("terminal"),
    covers: { commands: ["terminal.create", "terminal.close"] },
    async run(context) {
      await withoutNoShellReplies(context)
      const { page } = context
      await openTerminalFromNavbar(context)
      await click(context, terminalPane(page).getByRole("button", { name: "Add terminal to the right" }).first())
      await parkPointer(context)
      await context.capture("split")
      await click(context, terminalPane(page).getByRole("button", { name: "Close terminal" }).last())
      await parkPointer(context)
      await context.capture("one-left")
    },
  }),
  defineScenario({
    name: "terminal-split-keybinding",
    route: CHATS.units,
    ...desktop,
    regions: regions("terminal"),
    covers: { keybindings: ["addSplitTerminal"], commands: ["terminal.create"] },
    async run(context) {
      await withoutNoShellReplies(context)
      await press(context, "Meta+/")
      await parkPointer(context)
      await context.capture("opened-with-split")
    },
  }),
  defineScenario({
    name: "terminal-clear",
    route: CHATS.units,
    ...desktop,
    regions: regions("terminal"),
    covers: { commands: ["terminal.input"] },
    async run(context) {
      await withoutNoShellReplies(context)
      const { page } = context
      await openTerminalFromNavbar(context)
      await page.getByRole("textbox", { name: "Terminal input" }).focus()
      await page.keyboard.type("pwd")
      await press(context, "Enter")
      await click(context, terminalPane(page).getByRole("button", { name: "Clear terminal" }).first())
      await parkPointer(context)
      await context.capture("cleared")
    },
  }),
  defineScenario({
    // The separator between chat and terminal takes the keyboard.
    name: "terminal-resize-rows",
    route: CHATS.units,
    ...desktop,
    regions: regions("terminal"),
    covers: { commands: ["terminal.resize"] },
    async run(context) {
      await withoutNoShellReplies(context)
      const { page } = context
      await openTerminalFromNavbar(context)
      // The separator's name is sr-only text inside it, which a separator's accessible name doesn't take.
      const separator = page.getByRole("separator").filter({ hasText: "Resize rows" })
      const box = (await separator.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 6 })
      await page.mouse.up()
      await parkPointer(context)
      await rest(context)
      await context.capture("taller")
    },
  }),
]
