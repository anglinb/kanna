import { defineScenario, type Scenario } from "../scenario"
import { CHATS, click, composer, parkPointer, reduceMotion, REGIONS, regions, rest, sidebarChatRow, typeIntoComposer } from "./_lib/helpers"

// The transcript: each seeded chat as it opens (finished, waiting on a
// question, streaming, another harness), tool groups and single tools
// expanded, the system-init card, the AskUserQuestion card answered, a
// running turn played to its end, an interrupted one, and Load More.

const desktop = { viewports: ["desktop" as const] }

function transcript(context: { page: import("playwright").Page }) {
  return context.page.locator(REGIONS.transcript)
}

export const scenarios: Scenario[] = [
  defineScenario({
    name: "transcript-waiting-on-question",
    route: CHATS.deploy,
    regions: regions("transcript", "composer"),
  }),
  defineScenario({
    name: "transcript-streaming",
    route: CHATS.readme,
    regions: regions("transcript", "composer", "sidebar"),
    async run(context) {
      await context.capture("mid-turn")
      await context.advance(1_500)
      await context.capture("next-step")
      await context.advance(60_000)
      await parkPointer(context)
      await context.capture("finished")
    },
  }),
  defineScenario({
    name: "transcript-codex-chat",
    route: CHATS.safari,
    regions: regions("transcript", "composer"),
  }),
  defineScenario({
    name: "transcript-cursor-chat",
    route: CHATS.hero,
    regions: regions("transcript", "composer"),
  }),
  defineScenario({
    name: "transcript-ledger-codex-chat",
    route: CHATS.rateLimit,
    ...desktop,
    regions: regions("transcript"),
  }),
  defineScenario({
    // A tool group opens to its tools; a tool opens to its body, fetched on demand.
    name: "transcript-tool-group-expand",
    route: CHATS.units,
    regions: regions("transcript"),
    covers: { commands: ["chat.getToolEntries", "chat.setReadAnchor"] },
    async run(context) {
      await click(context, transcript(context).getByRole("button", { name: "1 search, 2 reads, 4 edits, 2 writes, 1 command" }))
      await parkPointer(context)
      await context.capture("group-open")
      await click(context, transcript(context).getByRole("button", { name: "Read src/lib/units.ts" }))
      await parkPointer(context)
      await context.capture("read-open")
    },
  }),
  defineScenario({
    name: "transcript-tool-edit-and-bash",
    route: CHATS.units,
    ...desktop,
    regions: regions("transcript"),
    covers: { commands: ["chat.getToolEntries"] },
    async run(context) {
      await click(context, transcript(context).getByRole("button", { name: "1 search, 2 reads, 4 edits, 2 writes, 1 command" }))
      await click(context, transcript(context).getByRole("button", { name: "Edit src/lib/units.ts" }))
      await parkPointer(context)
      await context.capture("edit-open")
      await click(context, transcript(context).getByRole("button", { name: "Run the units tests" }))
      await parkPointer(context)
      await context.capture("bash-open")
      await click(context, transcript(context).getByRole("button", { name: "Write src/hooks/useHeightUnit.ts" }))
      await parkPointer(context)
      await context.capture("write-open")
    },
  }),
  defineScenario({
    name: "transcript-tool-search-and-collapse",
    route: CHATS.units,
    ...desktop,
    regions: regions("transcript"),
    covers: { commands: ["chat.getToolEntries"] },
    async run(context) {
      await click(context, transcript(context).getByRole("button", { name: "1 search, 2 reads, 4 edits, 2 writes, 1 command" }))
      await click(context, transcript(context).getByRole("button", { name: "Find `formatFeet` in text" }))
      await parkPointer(context)
      await context.capture("grep-open")
      await click(context, transcript(context).getByRole("button", { name: "Collapse" }))
      await parkPointer(context)
      await context.capture("collapsed")
    },
  }),
  defineScenario({
    // The provider card at the top of a turn: model, tools, the raw message.
    name: "transcript-system-init",
    route: CHATS.units,
    ...desktop,
    regions: regions("transcript"),
    covers: { commands: ["chat.getEntryDebugRaw"] },
    async run(context) {
      await click(context, transcript(context).getByRole("button", { name: "Claude CodeOpus" }))
      await parkPointer(context)
      await context.capture("open")
      await click(context, transcript(context).getByRole("button", { name: "Tools 10" }))
      await parkPointer(context)
      await context.capture("tools")
      await click(context, transcript(context).getByRole("button", { name: "Raw Message" }))
      await parkPointer(context)
      await context.capture("raw")
    },
  }),
  defineScenario({
    // Pick an option, submit: the turn carries on with that host.
    name: "transcript-ask-user-question-answer",
    route: CHATS.deploy,
    regions: regions("transcript", "composer", "sidebar"),
    covers: { commands: ["chat.respondTool", "chat.setReadAnchor"] },
    async run(context) {
      const card = transcript(context)
      await click(context, card.getByRole("button", { name: /^Vercel/ }))
      await parkPointer(context)
      await context.capture("picked")
      await click(context, card.getByRole("button", { name: "Submit" }))
      await parkPointer(context)
      await context.capture("submitted")
      await context.advance(30_000)
      await context.capture("finished")
    },
  }),
  defineScenario({
    // "Other...": a typed answer instead of an option.
    name: "transcript-ask-user-question-other",
    route: CHATS.deploy,
    ...desktop,
    regions: regions("transcript"),
    covers: { commands: ["chat.respondTool"] },
    async run(context) {
      const field = transcript(context).getByRole("textbox", { name: "Where should tidepool deploy?" })
      await field.click()
      await field.pressSequentially("GitHub Pages")
      await rest(context)
      await context.capture("typed")
      await click(context, transcript(context).getByRole("button", { name: "Submit" }))
      await context.advance(30_000)
      await parkPointer(context)
      await context.capture("finished")
    },
  }),
  defineScenario({
    // Stopping a running turn leaves an Interrupted row.
    name: "transcript-interrupted",
    route: CHATS.readme,
    ...desktop,
    regions: regions("transcript"),
    covers: { commands: ["chat.cancel"] },
    async run(context) {
      await click(context, context.page.getByRole("button", { name: "Stop" }))
      await context.advance(5_000)
      await parkPointer(context)
      await context.capture("interrupted")
    },
  }),
  defineScenario({
    // A transcript window of 5 assistant messages, a chat with more: the
    // top shows Load More, and the older slice lands in front.
    name: "transcript-load-older",
    route: CHATS.units,
    ...desktop,
    regions: regions("transcript"),
    covers: { commands: ["chat.loadOlder", "settings.writeAppSettingsPatch", "chat.send"] },
    async run(context) {
      const { page } = context
      for (const prompt of ["Show the swell direction as an arrow", "Add a sunrise time under the tide chart"]) {
        await typeIntoComposer(context, prompt)
        await composer(page).press("Enter")
        await rest(context)
        await context.advance(30_000)
      }
      await click(context, page.locator(REGIONS.sidebar).getByRole("button", { name: "Settings Connected" }))
      const windowField = page.getByRole("spinbutton").first()
      await windowField.fill("5")
      await windowField.press("Tab")
      await rest(context)
      await click(context, sidebarChatRow(page, "demo-chat-units"))
      await parkPointer(context)
      await context.capture("windowed")
      await click(context, transcript(context).getByRole("button", { name: "Load More" }))
      await parkPointer(context)
      await context.capture("loaded-older")
    },
  }),
  defineScenario({
    // A local file link in a reply opens the file beside the transcript
    // (reduced motion: see reduceMotion in _lib/helpers.ts).
    name: "transcript-file-link-click",
    route: CHATS.rateLimit,
    ...desktop,
    regions: regions("transcript", "viewer"),
    async run(context) {
      await reduceMotion(context)
      await click(context, transcript(context).getByRole("link", { name: "src/middleware/rateLimit.ts" }))
      await parkPointer(context)
      await context.capture("opened")
    },
  }),
]
