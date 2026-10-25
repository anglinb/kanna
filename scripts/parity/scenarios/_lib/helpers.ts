import type { Locator, Page } from "playwright"
import type { ScenarioContext } from "../../scenario"

// Shared by the scenario files beside this folder. Not a scenario file
// itself: index.ts only loads the `.ts` files directly in scenarios/.

/**
 * Named parts of the page that scenarios compare on their own. Each is a
 * selector that already exists in the React DOM: a landmark or role where
 * there is one, else a data attribute the client sets for its own use, else
 * (noted) a class the Foldkit port copies verbatim from the JSX.
 */
export const REGIONS = {
  /** The left sidebar, open. */
  sidebar: "[data-sidebar=open]",
  /** The chat's title bar (ChatNavbar's CardHeader). Class: no role or data attribute is unique to it. */
  navbar: "[class~='group/navbar']",
  /** The transcript scroller (the message-scroller viewport, a labelled region). */
  transcript: "[role=region][aria-label=Messages]",
  /** The composer dock: the box around the chat input and its controls. Class + data attribute: the dock has no role. */
  composer: ".pointer-events-auto:has(textarea[data-chat-input])",
  /** The widget column on the right of a chat. */
  widgets: "[data-widgets-column]",
  /** The settings page (nav and content). */
  settings: "[data-settings-page]",
  /** The open settings section's content, beside the settings nav. */
  settingsNav: "[data-settings-page] aside",
  /** A Radix menu (dropdown or context menu) that is open. */
  menu: "[role=menu]",
  /** A popover or hover card that is open. */
  popover: "[role=dialog]:not([aria-modal=true])",
  /** A modal dialog that is open (dialogs, the command palette). */
  dialog: "[role=dialog][aria-modal=true], [role=alertdialog]",
  /** A select's or combobox's option list that is open. */
  listbox: "[role=listbox]",
  /**
   * A tooltip that is up: the box holding the `role=tooltip` text. (The
   * role sits on a visually hidden copy of the text inside the box, 1px
   * square, so the role alone would compare a single pixel.)
   */
  tooltip: ":has(> [role=tooltip])",
  /** The embedded terminal workspace under a chat. */
  terminal: "[data-terminal-visual]",
  /** The file / diff / attachment viewer pane. */
  viewer: "[data-viewer-surface]",
} as const

export type RegionName = keyof typeof REGIONS

/** Picks regions by name: `regions("sidebar", "menu")`. */
export function regions(...names: RegionName[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, REGIONS[name]]))
}

/** The three chats the demo opens with that matter most: done, waiting on the user, streaming. */
export const CHATS = {
  /** Finished, tidepool, Claude Code, edits in the diff panel. The demo's featured chat. */
  units: "/chat/demo-chat-units",
  /** Waiting on an AskUserQuestion (Cloudflare Pages / Vercel / Netlify). */
  deploy: "/chat/demo-chat-deploy",
  /** Mid-turn: the rest of its steps play as the clock advances. */
  readme: "/chat/demo-chat-readme",
  /** Finished, unread, Codex. */
  safari: "/chat/demo-chat-safari",
  /** Finished, ledger-api, Codex, committed. */
  rateLimit: "/chat/demo-chat-rate-limit",
  /** Finished, portfolio, Cursor, a day old. */
  hero: "/chat/demo-chat-hero",
} as const

/**
 * Longer than any hover or tooltip delay in the client (Radix's 700ms
 * default is the longest), so whatever a pointer resting somewhere opens has
 * opened before the next capture, in both apps.
 */
const REST_MS = 1000

/** Waits out hover and tooltip delays, then settles. */
export async function rest(context: ScenarioContext) {
  await context.page.waitForTimeout(REST_MS)
  await context.settle()
}

/**
 * Parks the pointer on the window's bottom-right corner pixel, where nothing
 * reacts to it, and waits out hover delays, so a hover style or card left by
 * the last click doesn't decide the capture.
 */
export async function parkPointer(context: ScenarioContext) {
  const size = context.page.viewportSize()
  await context.page.mouse.move(size ? size.width - 1 : 0, size ? size.height - 1 : 0)
  await rest(context)
}

/** Clicks, then waits for the page to be still (hover delays included). */
export async function click(context: ScenarioContext, locator: Locator, options?: Parameters<Locator["click"]>[0]) {
  await locator.click(options)
  await rest(context)
}

/**
 * Right-clicks after resting on the target first. A row's hover card opens
 * on the pointer's arrival and races the menu a right-click opens; resting
 * first lets the card win every time, in both apps.
 */
export async function contextClick(context: ScenarioContext, locator: Locator) {
  await locator.hover()
  await rest(context)
  await locator.click({ button: "right" })
  await rest(context)
}

/**
 * Clicks and settles without waiting out hover delays. For the widget
 * column: once it is open it polls on wall-clock intervals
 * (chat.refreshDiffs every 5s, browser.listLocalHttpServers every 7s), and
 * a capture taken after the first poll would hold a command the other run
 * may not have sent yet. A widget scenario opens the column, does one
 * thing and captures, well inside those 5 seconds.
 */
export async function quickClick(context: ScenarioContext, locator: Locator) {
  await locator.click()
  await context.settle()
}

/** Opens the widget column from the navbar. */
export async function openWidgets(context: ScenarioContext) {
  await quickClick(context, context.page.locator(REGIONS.navbar).getByRole("button", { name: "Show widgets" }))
}

/** Hovers, then waits for whatever opens on hover. */
export async function hover(context: ScenarioContext, locator: Locator) {
  await locator.hover()
  await rest(context)
}

/** Presses a key (or chord, e.g. "Meta+k"), then settles. */
export async function press(context: ScenarioContext, key: string) {
  await context.page.keyboard.press(key)
  await rest(context)
}

/** The composer's text box. */
export function composer(page: Page) {
  return page.getByRole("textbox").and(page.locator("textarea[data-chat-input]"))
}

/** Types into the composer the way a person does, key by key. */
export async function typeIntoComposer(context: ScenarioContext, text: string) {
  const box = composer(context.page)
  await box.click()
  await box.pressSequentially(text)
  await rest(context)
}

/** Sidebar row of a chat (desktop sidebar). CSS: rows carry `data-chat-id`, no role of their own. */
export function sidebarChatRow(page: Page, chatId: string) {
  return page.locator(`${REGIONS.sidebar} [data-chat-id="${chatId}"]`)
}

/** Opens the sidebar's view switcher (the unlabelled popover button above the list) and picks a view. */
export async function switchSidebarView(context: ScenarioContext, view: "Chats" | "Projects" | "Channels" | "Archived") {
  // CSS: the switcher's trigger is an icon button with no accessible name.
  await context.page.locator(`${REGIONS.sidebar} button[aria-haspopup=dialog]`).first().click()
  await context.page.getByRole("dialog").getByRole("button", { name: view, exact: true }).click()
  await parkPointer(context)
}

/** Opens the command palette with its keybinding (cmd+k). */
export async function openPalette(context: ScenarioContext) {
  await context.page.keyboard.press("Meta+k")
  await rest(context)
}
