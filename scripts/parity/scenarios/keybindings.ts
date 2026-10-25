import { defineScenario, type Scenario } from "../scenario"
import { CHATS, countUuids, parkPointer, press, REGIONS, regions, rest } from "./_lib/helpers"

// Every default keybinding (src/shared/types.ts DEFAULT_KEYBINDINGS) that
// isn't already pressed by its own area's scenarios: ⌘K is in
// command-palette.ts, ⌘J and ⌘/ in terminal.ts. "cmd" is the Meta key.

const desktop = { viewports: ["desktop" as const] }

export const scenarios: Scenario[] = [
  defineScenario({
    // ⌘B opens the widget column and closes it again. The open column
    // polls, so the open state is captured at once (see quickClick).
    name: "keybinding-toggle-widgets",
    route: CHATS.units,
    ...desktop,
    regions: regions("widgets", "navbar"),
    covers: { keybindings: ["toggleRightSidebar"] },
    async run(context) {
      await context.page.keyboard.press("Meta+b")
      await context.settle()
      await context.capture("open")
      await context.page.keyboard.press("Meta+b")
      await context.settle()
      await context.capture("closed")
    },
  }),
  defineScenario({
    name: "keybinding-open-in-finder",
    route: CHATS.units,
    ...desktop,
    regions: regions("transcript"),
    covers: { keybindings: ["openInFinder"], commands: ["system.openExternal"] },
    async run(context) {
      await press(context, "Meta+Alt+f")
      await parkPointer(context)
      await context.capture("needs-machine")
    },
  }),
  defineScenario({
    name: "keybinding-open-in-editor",
    route: CHATS.units,
    ...desktop,
    regions: regions("transcript"),
    covers: { keybindings: ["openInEditor"], commands: ["system.openExternal"] },
    async run(context) {
      await press(context, "Meta+Shift+o")
      await parkPointer(context)
      await context.capture("needs-machine")
    },
  }),
  defineScenario({
    // Holding ⌘⌥ numbers the sidebar's chats; a digit opens that one.
    name: "keybinding-jump-to-sidebar-chat",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar"),
    covers: { keybindings: ["jumpToSidebarChat"] },
    async run(context) {
      const { keyboard } = context.page
      await keyboard.down("Meta")
      await keyboard.down("Alt")
      await rest(context)
      await context.capture("hints")
      await keyboard.press("Digit3")
      await keyboard.up("Alt")
      await keyboard.up("Meta")
      await parkPointer(context)
      await context.capture("jumped")
    },
  }),
  defineScenario({
    name: "keybinding-new-chat-in-project",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar", "composer"),
    covers: { keybindings: ["createChatInCurrentProject"], commands: ["chat.create"] },
    async run(context) {
      await countUuids(context)
      await press(context, "Meta+Alt+n")
      await parkPointer(context)
      await context.capture("new-chat")
    },
  }),
  defineScenario({
    name: "keybinding-add-project",
    route: CHATS.units,
    ...desktop,
    regions: regions("dialog"),
    covers: { keybindings: ["openAddProject"] },
    async run(context) {
      await press(context, "Meta+Alt+o")
      await context.capture("palette")
    },
  }),
  defineScenario({
    // Focus mode narrows the sidebar to the open chat's project; again leaves it.
    name: "keybinding-focus-mode",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar"),
    covers: { keybindings: ["toggleFocusMode"] },
    async run(context) {
      await press(context, "Meta+Shift+f")
      await parkPointer(context)
      await context.capture("focused")
      await press(context, "Meta+Shift+f")
      await parkPointer(context)
      await context.capture("unfocused")
    },
  }),
  defineScenario({
    // The pill focus mode puts in the sidebar leaves it too.
    name: "keybinding-focus-mode-exit-pill",
    route: CHATS.units,
    ...desktop,
    regions: regions("sidebar"),
    covers: { keybindings: ["toggleFocusMode"] },
    async run(context) {
      await press(context, "Meta+Shift+f")
      await context.page.locator(REGIONS.sidebar).getByRole("button", { name: /^Exit focus mode/ }).click()
      await parkPointer(context)
      await context.capture("exited")
    },
  }),
  defineScenario({
    // Second bindings: ctrl+b and ctrl+k do what ⌘B and ⌘K do.
    name: "keybinding-ctrl-alternates",
    route: CHATS.units,
    ...desktop,
    regions: regions("dialog"),
    covers: { keybindings: ["openCommandPalette"] },
    async run(context) {
      await press(context, "Control+k")
      await context.capture("palette")
    },
  }),
  defineScenario({
    // A binding changed in Settings → Keybindings is the one that works.
    name: "keybinding-rebound",
    route: "/settings/keybindings",
    ...desktop,
    regions: regions("dialog"),
    covers: { keybindings: ["openCommandPalette"], commands: ["settings.writeKeybindings"] },
    async run(context) {
      const { page } = context
      // The command palette's field: the ninth binding (KEYBINDING_ACTION_LABELS order).
      const field = page.locator("[data-settings-page]").getByRole("textbox").nth(8)
      await field.fill("cmd+shift+p")
      await field.press("Tab")
      await rest(context)
      await press(context, "Meta+Shift+p")
      await context.capture("palette")
    },
  }),
]
