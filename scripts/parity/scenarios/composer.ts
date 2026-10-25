import { PNG } from "pngjs"
import { defineScenario, type Scenario } from "../scenario"
import { CHATS, click, composer, openPalette, parkPointer, press, REGIONS, regions, rest, typeIntoComposer } from "./_lib/helpers"

// The chat composer: typing, sending (the optimistic prompt, then the
// scripted turn as the clock advances), the harness / model / effort /
// speed pickers, modes (Shift+Tab), the "/" and "@" menus, queueing while a
// turn runs, stopping it, attachments (the demo's fetch shim keeps uploads
// in memory, src/demo/environment.ts).
//
// Not here: recording a voice message past the microphone prompt (the
// browser under the runner has no microphone).

/** A 48×32 swatch, sea to sand, so the image preview has something to show. */
function swellPng() {
  const png = new PNG({ width: 48, height: 32 })
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const index = (y * png.width + x) * 4
      png.data[index] = 30 + x * 4
      png.data[index + 1] = 110 + y * 3
      png.data[index + 2] = 190 - x * 2
      png.data[index + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

const ATTACHMENTS = [
  { name: "swell.png", mimeType: "image/png", buffer: swellPng() },
  { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Low tide at 06:12, swell 1.4 m from the WSW.\n") },
]

const desktop = { viewports: ["desktop" as const] }

export const scenarios: Scenario[] = [
  defineScenario({
    name: "composer-typing",
    route: CHATS.units,
    regions: regions("composer"),
    covers: { commands: ["chat.setDraftProtection"] },
    async run(context) {
      await typeIntoComposer(context, "Show the swell direction as an arrow")
      await context.capture("typed")
      await press(context, "Shift+Enter")
      await context.page.keyboard.type("and keep the degrees in a tooltip")
      await rest(context)
      await context.capture("multiline")
    },
  }),
  defineScenario({
    // Send, see the prompt land before the server has it, then play the
    // scripted reply: streaming text, tools spinning, the finished turn.
    name: "composer-send-and-stream",
    route: CHATS.units,
    regions: regions("transcript", "composer", "sidebar"),
    covers: { commands: ["chat.send"] },
    async run(context) {
      await typeIntoComposer(context, "Show the swell direction as an arrow")
      await composer(context.page).press("Enter")
      await rest(context)
      await context.capture("sent")
      await context.advance(1_000)
      await context.capture("first-reply")
      await context.advance(2_000)
      await context.capture("tools-running")
      await context.advance(30_000)
      await parkPointer(context)
      await context.capture("finished")
    },
  }),
  defineScenario({
    // Arrow Up in an empty composer brings back the last prompt.
    name: "composer-recall-previous-prompt",
    route: CHATS.units,
    ...desktop,
    regions: regions("composer"),
    async run(context) {
      await composer(context.page).click()
      await press(context, "ArrowUp")
      await context.capture("recalled")
    },
  }),
  defineScenario({
    name: "composer-harness-picker",
    route: CHATS.units,
    regions: regions("composer", "popover"),
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Claude", exact: true }))
      await context.capture("open")
      await click(context, context.page.getByRole("dialog").getByRole("button", { name: "Codex" }))
      await parkPointer(context)
      await context.capture("switched-to-codex")
    },
  }),
  defineScenario({
    name: "composer-model-picker",
    route: CHATS.units,
    ...desktop,
    regions: regions("composer", "popover"),
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Opus", exact: true }))
      await context.capture("open")
      await click(context, context.page.getByRole("dialog").getByRole("button", { name: "Sonnet" }))
      await parkPointer(context)
      await context.capture("sonnet")
    },
  }),
  defineScenario({
    name: "composer-effort-picker",
    route: CHATS.units,
    ...desktop,
    regions: regions("composer", "popover"),
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "High", exact: true }))
      await context.capture("open")
      await click(context, context.page.getByRole("dialog").getByRole("button", { name: "Max" }))
      await parkPointer(context)
      await context.capture("max")
    },
  }),
  defineScenario({
    name: "composer-speed-picker",
    route: CHATS.units,
    ...desktop,
    regions: regions("composer", "popover"),
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Standard", exact: true }))
      await context.capture("open")
      await click(context, context.page.getByRole("dialog").getByRole("button", { name: "Fast Mode" }))
      await parkPointer(context)
      await context.capture("fast")
    },
  }),
  defineScenario({
    // The Codex chat's own pickers: its models and efforts differ.
    name: "composer-codex-pickers",
    route: CHATS.safari,
    ...desktop,
    regions: regions("composer", "popover"),
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "GPT-5.6 Sol", exact: true }))
      await context.capture("models")
    },
  }),
  defineScenario({
    // Shift+Tab walks the modes: Full Access → Plan Mode → Auto Plan → back.
    name: "composer-mode-cycle",
    route: CHATS.units,
    regions: regions("composer"),
    async run(context) {
      await composer(context.page).click()
      await press(context, "Shift+Tab")
      await context.capture("plan-mode")
      await press(context, "Shift+Tab")
      await context.capture("auto-plan")
      await press(context, "Shift+Tab")
      await context.capture("full-access")
    },
  }),
  defineScenario({
    name: "composer-mode-picker",
    route: CHATS.units,
    ...desktop,
    regions: regions("composer", "popover"),
    async run(context) {
      await composer(context.page).click()
      await press(context, "Shift+Tab")
      await click(context, context.page.getByRole("button", { name: "Plan Mode", exact: true }))
      await context.capture("open")
    },
  }),
  defineScenario({
    // "/" lists the harness's commands and skills; Enter takes the best match.
    name: "composer-slash-menu",
    route: CHATS.units,
    ...desktop,
    regions: regions("composer", "listbox"),
    covers: { commands: ["chat.listSkills"] },
    async run(context) {
      await typeIntoComposer(context, "/")
      await context.capture("open")
      await press(context, "ArrowUp")
      await context.capture("moved")
      await typeIntoComposer(context, "rev")
      await context.capture("filtered")
      await press(context, "Enter")
      await context.capture("accepted")
    },
  }),
  defineScenario({
    name: "composer-slash-menu-escape",
    route: CHATS.units,
    ...desktop,
    regions: regions("composer"),
    covers: { commands: ["chat.listSkills"] },
    async run(context) {
      await typeIntoComposer(context, "/")
      await press(context, "Escape")
      await context.capture("dismissed")
    },
  }),
  defineScenario({
    // "@" mentions another project.
    name: "composer-project-mention",
    route: CHATS.readme,
    ...desktop,
    regions: regions("composer", "listbox"),
    async run(context) {
      await typeIntoComposer(context, "Compare with @")
      await context.capture("open")
      await typeIntoComposer(context, "por")
      await context.capture("filtered")
      await press(context, "Enter")
      await context.capture("accepted")
    },
  }),
  defineScenario({
    // A prompt sent while a turn runs is queued under it, then sent now or removed.
    name: "composer-queue-while-running",
    route: CHATS.readme,
    regions: regions("transcript", "composer"),
    covers: { commands: ["message.enqueue", "message.steer"] },
    async run(context) {
      await typeIntoComposer(context, "Also add a table of contents")
      await composer(context.page).press("Enter")
      await parkPointer(context)
      await context.capture("queued")
      await click(context, context.page.getByRole("button", { name: "Send now" }))
      await parkPointer(context)
      await context.capture("steered")
      await context.advance(30_000)
      await context.capture("finished")
    },
  }),
  defineScenario({
    name: "composer-queue-remove",
    route: CHATS.readme,
    ...desktop,
    regions: regions("transcript"),
    covers: { commands: ["message.enqueue", "message.dequeue"] },
    async run(context) {
      await typeIntoComposer(context, "Also add a table of contents")
      await composer(context.page).press("Enter")
      await rest(context)
      await click(context, context.page.getByRole("button", { name: "Remove from queue" }))
      await parkPointer(context)
      await context.capture("removed")
    },
  }),
  defineScenario({
    // The queued prompt goes out on its own once the running turn ends.
    name: "composer-queue-drains",
    route: CHATS.readme,
    ...desktop,
    regions: regions("transcript"),
    covers: { commands: ["message.enqueue"] },
    async run(context) {
      await typeIntoComposer(context, "Also add a table of contents")
      await composer(context.page).press("Enter")
      await rest(context)
      await context.advance(10_000)
      await parkPointer(context)
      await context.capture("next-turn-started")
      await context.advance(30_000)
      await context.capture("both-done")
    },
  }),
  defineScenario({
    // ⌘Enter while running does the other thing from Enter: interrupts and sends now.
    name: "composer-steer-with-modifier",
    route: CHATS.readme,
    ...desktop,
    regions: regions("transcript"),
    covers: { commands: ["message.enqueue"] },
    async run(context) {
      await typeIntoComposer(context, "Skip the endpoints table")
      await composer(context.page).press("Meta+Enter")
      await parkPointer(context)
      await context.capture("steered")
    },
  }),
  defineScenario({
    name: "composer-stop",
    route: CHATS.readme,
    regions: regions("transcript", "composer"),
    covers: { commands: ["chat.cancel"] },
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Stop" }))
      await parkPointer(context)
      await context.capture("stopped")
    },
  }),
  defineScenario({
    // Plan mode: the reply proposes a plan and waits; approving it runs the rest.
    name: "composer-plan-mode-approve",
    route: CHATS.units,
    regions: regions("transcript", "composer"),
    covers: { commands: ["chat.send", "chat.respondTool"] },
    async run(context) {
      await composer(context.page).click()
      await press(context, "Shift+Tab")
      await typeIntoComposer(context, "Show the swell direction as an arrow")
      await composer(context.page).press("Enter")
      await rest(context)
      await context.advance(10_000)
      await parkPointer(context)
      await context.capture("plan-proposed")
      await click(context, context.page.getByRole("button", { name: "Approve", exact: true }))
      await parkPointer(context)
      await context.capture("approved")
      await context.advance(30_000)
      await context.capture("finished")
    },
  }),
  defineScenario({
    name: "composer-plan-mode-reject",
    route: CHATS.units,
    ...desktop,
    regions: regions("transcript"),
    covers: { commands: ["chat.send", "chat.respondTool"] },
    async run(context) {
      await composer(context.page).click()
      await press(context, "Shift+Tab")
      await typeIntoComposer(context, "Show the swell direction as an arrow")
      await composer(context.page).press("Enter")
      await rest(context)
      await context.advance(10_000)
      await click(context, context.page.getByRole("button", { name: "Suggest Edits" }))
      await context.page.getByPlaceholder("Describe what you'd like to change...").fill("Use an SVG arrow, not a font glyph")
      await rest(context)
      await context.capture("editing")
      await click(context, context.page.getByRole("button", { name: "Adjust Plan" }))
      await context.advance(10_000)
      await parkPointer(context)
      await context.capture("adjusted")
    },
  }),
  defineScenario({
    name: "composer-plan-mode-approve-and-clear",
    route: CHATS.units,
    ...desktop,
    regions: regions("transcript"),
    covers: { commands: ["chat.send", "chat.respondTool"] },
    async run(context) {
      await composer(context.page).click()
      await press(context, "Shift+Tab")
      await typeIntoComposer(context, "Show the swell direction as an arrow")
      await composer(context.page).press("Enter")
      await rest(context)
      await context.advance(10_000)
      await click(context, context.page.getByRole("button", { name: "Approve & Clear" }))
      await context.advance(30_000)
      await parkPointer(context)
      await context.capture("approved-and-cleared")
    },
  }),
  defineScenario({
    // The browser under the runner grants no microphone: the composer says what it needs.
    name: "composer-voice-no-microphone",
    route: CHATS.units,
    ...desktop,
    regions: regions("composer"),
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Record voice message" }))
      await parkPointer(context)
      await context.capture("needs-microphone")
    },
  }),
  defineScenario({
    // The palette's Attach Files opens the picker; an image and a text file
    // upload, then go out with the prompt and show in the transcript.
    name: "composer-attach-files",
    route: CHATS.units,
    ...desktop,
    regions: regions("composer", "transcript"),
    covers: { commands: ["chat.send"] },
    async run(context) {
      const { page } = context
      await openPalette(context)
      const chooser = page.waitForEvent("filechooser")
      await page.getByRole("dialog", { name: "Command Palette" }).getByRole("option", { name: /^Attach Files/ }).first().click()
      await (await chooser).setFiles(ATTACHMENTS)
      await rest(context)
      await context.capture("attached")
      await typeIntoComposer(context, "The swell chart from this morning, and my notes")
      await composer(page).press("Enter")
      await rest(context)
      await context.advance(30_000)
      await parkPointer(context)
      await context.capture("sent")
    },
  }),
  defineScenario({
    // An attachment comes off before sending.
    name: "composer-attachment-remove",
    route: CHATS.units,
    ...desktop,
    regions: regions("composer"),
    async run(context) {
      const { page } = context
      await openPalette(context)
      const chooser = page.waitForEvent("filechooser")
      await page.getByRole("dialog", { name: "Command Palette" }).getByRole("option", { name: /^Attach Files/ }).first().click()
      await (await chooser).setFiles(ATTACHMENTS)
      await rest(context)
      await click(context, page.getByRole("button", { name: "Remove swell.png" }))
      await parkPointer(context)
      await context.capture("removed")
    },
  }),
  defineScenario({
    // A sent image opens in the viewer from the transcript.
    name: "composer-attachment-open",
    route: CHATS.units,
    ...desktop,
    regions: regions("viewer"),
    covers: { commands: ["chat.send"] },
    async run(context) {
      const { page } = context
      await openPalette(context)
      const chooser = page.waitForEvent("filechooser")
      await page.getByRole("dialog", { name: "Command Palette" }).getByRole("option", { name: /^Attach Files/ }).first().click()
      await (await chooser).setFiles(ATTACHMENTS.slice(0, 1))
      await rest(context)
      await typeIntoComposer(context, "Here's the chart")
      await composer(page).press("Enter")
      await rest(context)
      await context.advance(30_000)
      await click(context, page.locator(REGIONS.transcript).getByRole("button", { name: /swell\.png/ }).first())
      await parkPointer(context)
      await context.capture("viewer")
    },
  }),
]
