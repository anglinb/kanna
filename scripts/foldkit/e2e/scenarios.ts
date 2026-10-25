import { appendFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Browser, BrowserContext, Locator, Page } from "playwright"

// The end-to-end scenarios (run.ts runs them in this order against one
// server). Each one acts as a person would and checks what they would see.
// Later ones build on what earlier ones left (a chat with a turn in it), so
// `needs` names what has to have run, and run.ts keeps those in a filtered
// run.

export interface E2EContext {
  app: "react" | "foldkit"
  /** Every page a scenario opened, for run.ts to screenshot when it fails. */
  pages: Page[]
  browser: Browser
  origin: string
  /** Project name → its directory: `alpha`, `beta`. */
  projects: Record<string, string>
  withAgent: boolean
  command: (command: Record<string, unknown>) => Promise<unknown>
  /** What scenarios hand on to later ones. */
  state: {
    chatPath?: string
    chatTitle?: string
    /** The project the chat was started in (New Chat picks the most recent one). */
    chatProject?: string
    deletedTitle?: string
  }
}

export interface E2EScenario {
  name: string
  /** Runs a real agent turn (skipped with --no-agent). */
  agent?: boolean
  /** Runs in every filtered run too: later scenarios depend on it. */
  always?: boolean
  run: (context: E2EContext) => Promise<void>
}

const TURN_TIMEOUT_MS = 180_000
const UI_TIMEOUT_MS = 15_000

// HELPERS

interface Opened {
  page: Page
  browserContext: BrowserContext
  errors: string[]
  close: () => Promise<void>
}

/** A fresh browser context on `path`, logging every error the page shows. */
async function open(context: E2EContext, at: string, viewport = { width: 1440, height: 900 }): Promise<Opened> {
  const browserContext = await context.browser.newContext({ viewport })
  const page = await browserContext.newPage()
  context.pages.push(page)
  const errors: string[] = []
  // Feature detection the kanna.sh proxy alone answers (connectionStore).
  const expected = (url: string) => url.endsWith("/__cloud/machines")
  // The server's own title generation failing (a provider not signed in
  // here) is logged to the console by design; nothing the client did.
  const expectedText = (text: string) => text.includes("[title-generation]")
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`))
  page.on("console", (message) => {
    if (message.type() === "error" && !expected(message.location().url) && !expectedText(message.text())) errors.push(`console: ${message.text()}`)
  })
  page.on("response", (response) => {
    if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`)
  })
  await page.goto(`${context.origin}${at}`)
  return { page, browserContext, errors, close: () => browserContext.close() }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function noErrors(opened: Opened) {
  assert(opened.errors.length === 0, `errors on the page:\n${opened.errors.slice(0, 8).join("\n")}`)
}

async function visible(locator: Locator, what: string, timeout = UI_TIMEOUT_MS) {
  try {
    await locator.first().waitFor({ state: "visible", timeout })
  } catch {
    throw new Error(`not visible within ${timeout}ms: ${what}`)
  }
}

async function gone(locator: Locator, what: string, timeout = UI_TIMEOUT_MS) {
  try {
    await locator.first().waitFor({ state: "hidden", timeout })
  } catch {
    throw new Error(`still visible after ${timeout}ms: ${what}`)
  }
}

async function until(check: () => Promise<boolean>, what: string, timeout = UI_TIMEOUT_MS) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`timed out after ${timeout}ms waiting for: ${what}`)
}

const sidebar = (page: Page) => page.locator("[data-sidebar=open]")
const composer = (page: Page) => page.locator("textarea[data-chat-input]")
const transcript = (page: Page) => page.locator("[role=region][aria-label=Messages]")
const chatRow = (page: Page, title: string) => sidebar(page).getByText(title, { exact: true })

async function chooseRowMenuItem(page: Page, title: string, item: string) {
  await chatRow(page, title).first().click({ button: "right" })
  const menu = page.getByRole("menu")
  await visible(menu, `the menu of "${title}"`)
  await menu.getByRole("menuitem", { name: item }).click()
}

/**
 * A new chat in `project` from the sidebar's New Chat button. With no
 * project to start it in, the button opens the palette's project picker.
 */
async function newChat(page: Page, project = "alpha") {
  await sidebar(page).getByRole("button", { name: "New Chat" }).first().click()
  const picker = page.getByRole("dialog")
  await until(async () => /\/chat\/[^/]+$/.test(page.url()) || await picker.isVisible(), "a new chat or the project picker")
  if (!/\/chat\/[^/]+$/.test(page.url())) {
    await page.keyboard.type(project)
    await visible(picker.getByText(project, { exact: true }), `${project} in the picker`)
    await page.keyboard.press("Enter")
    await until(async () => /\/chat\/[^/]+$/.test(page.url()), "the URL to name the new chat")
  }
  await visible(composer(page), "the composer")
}

// SCENARIOS

export const scenarios: E2EScenario[] = [
  {
    // A machine that never ran Kanna opens on the setup wizard; "Set up
    // later" is remembered by the server, so no later page opens it again.
    name: "setup-later",
    always: true,
    async run(context) {
      const opened = await open(context, "/")
      const { page } = opened
      await visible(page.getByText("Connect your agents", { exact: true }), "the setup wizard on a fresh machine")
      await page.getByRole("button", { name: "Set up later" }).click()
      await gone(page.getByText("Connect your agents", { exact: true }), "the setup wizard")
      await visible(sidebar(page), "the sidebar")
      noErrors(opened)
      await opened.close()
      const again = await open(context, "/")
      await visible(sidebar(again.page), "the sidebar on the next load")
      await again.page.waitForTimeout(2_000)
      assert(!(await again.page.getByText("Connect your agents", { exact: true }).isVisible()), "the wizard opened again after Set up later")
      noErrors(again)
      await again.close()
    },
  },
  {
    name: "boot",
    always: true,
    async run(context) {
      const opened = await open(context, "/")
      const { page } = opened
      await visible(sidebar(page), "the sidebar")
      // A project without chats is on the projects page, not in the sidebar.
      await visible(page.getByText("alpha", { exact: true }), "the alpha project on the projects page")
      await visible(page.getByText("beta", { exact: true }), "the beta project on the projects page")
      assert((await page.title()).includes("Kanna"), `title is ${await page.title()}`)
      noErrors(opened)
      await opened.close()
    },
  },
  {
    name: "draft-survives",
    async run(context) {
      const opened = await open(context, "/")
      const { page } = opened
      await visible(sidebar(page), "the sidebar")
      await newChat(page)
      const chatUrl = page.url()
      await composer(page).fill("A draft that should outlive a reload")
      await page.goto(`${context.origin}/settings/general`)
      await visible(page.locator("[data-settings-page]"), "settings")
      await page.goBack()
      await until(async () => (await composer(page).inputValue()) === "A draft that should outlive a reload", "the draft back after leaving and returning")
        .catch(async (error) => {
          const value = await composer(page).inputValue().catch(() => "(no composer)")
          const stored = await page.evaluate(() => localStorage.getItem("chat-input-drafts")).catch(() => null)
          throw new Error(`${(error as Error).message}\ncomposer: ${JSON.stringify(value)} at ${page.url()} (was ${chatUrl})\nstored: ${stored?.slice(0, 300)}`)
        })
      await page.reload()
      await until(async () => (await composer(page).inputValue()) === "A draft that should outlive a reload", "the draft back after a reload")
      assert(page.url() === chatUrl, `still on the chat (${page.url()})`)
      await composer(page).fill("")
      noErrors(opened)
      await opened.close()
    },
  },
  {
    name: "send-prompt",
    agent: true,
    always: true,
    async run(context) {
      const opened = await open(context, "/")
      const { page } = opened
      await visible(sidebar(page), "the sidebar")
      await newChat(page)
      await composer(page).fill("Reply with exactly the word pong in lowercase, and nothing else. Do not use any tools.")
      await composer(page).press("Enter")
      await visible(transcript(page).getByText("Reply with exactly the word pong", { exact: false }), "the prompt in the transcript")
      await visible(page.getByRole("button", { name: "Stop" }), "the Stop button while the turn runs", 30_000)
      await visible(transcript(page).getByText(/^\s*pong\.?\s*$/i), "the agent's reply", TURN_TIMEOUT_MS)
      await gone(page.getByRole("button", { name: "Stop" }), "the Stop button once the turn ends", TURN_TIMEOUT_MS)
      await until(async () => (await composer(page).inputValue()) === "", "the composer cleared")
      context.state.chatPath = new URL(page.url()).pathname
      // The chat is in the sidebar under its project, once its title is
      // generated: the document title ends with it ("Kanna : alpha : <title>").
      let title = ""
      await until(async () => {
        title = (await page.title()).split(" : ").slice(2).join(" : ").trim()
        return title.length > 0 && title !== "New Chat"
      }, "a generated title for the chat", 60_000)
      context.state.chatTitle = title
      context.state.chatProject = (await page.title()).split(" : ")[1]?.trim()
      await visible(chatRow(page, title), `the chat "${title}" in the sidebar`)
      noErrors(opened)
      await opened.close()
    },
  },
  {
    name: "reload-transcript",
    agent: true,
    async run(context) {
      assert(context.state.chatPath, "send-prompt left no chat")
      const opened = await open(context, context.state.chatPath)
      const { page } = opened
      await visible(transcript(page).getByText("Reply with exactly the word pong", { exact: false }), "the prompt after a reload")
      await visible(transcript(page).getByText(/^\s*pong\.?\s*$/i), "the reply after a reload")
      noErrors(opened)
      await opened.close()
    },
  },
  {
    name: "rename-live-in-second-tab",
    agent: true,
    async run(context) {
      assert(context.state.chatPath && context.state.chatTitle, "send-prompt left no chat")
      const first = await open(context, context.state.chatPath)
      const second = await open(context, "/")
      await visible(chatRow(second.page, context.state.chatTitle), "the chat in the second tab")
      await chooseRowMenuItem(first.page, context.state.chatTitle, "Rename")
      const dialog = first.page.getByRole("dialog")
      await visible(dialog, "the rename dialog")
      await dialog.locator("input").fill("Pong check")
      await dialog.getByRole("button", { name: "Rename" }).click()
      await visible(chatRow(first.page, "Pong check"), "the new title in this tab")
      await visible(chatRow(second.page, "Pong check"), "the new title in the other tab")
      context.state.chatTitle = "Pong check"
      noErrors(first)
      noErrors(second)
      await first.close()
      await second.close()
    },
  },
  {
    name: "pin-and-unpin",
    agent: true,
    async run(context) {
      assert(context.state.chatTitle, "no chat")
      const opened = await open(context, "/")
      const { page } = opened
      await chooseRowMenuItem(page, context.state.chatTitle, "Pin")
      await until(async () => {
        await chatRow(page, context.state.chatTitle!).first().click({ button: "right" })
        const unpin = await page.getByRole("menuitem", { name: "Unpin" }).isVisible()
        await page.keyboard.press("Escape")
        return unpin
      }, "the menu to offer Unpin")
      await chooseRowMenuItem(page, context.state.chatTitle, "Unpin")
      noErrors(opened)
      await opened.close()
    },
  },
  {
    name: "archive-and-restore",
    agent: true,
    async run(context) {
      assert(context.state.chatTitle, "no chat")
      const opened = await open(context, "/")
      const { page } = opened
      await chooseRowMenuItem(page, context.state.chatTitle, "Archive Chat")
      await gone(chatRow(page, context.state.chatTitle), "the archived chat in the sidebar's list")
      // The Archived section, collapsed at first: open it, and restore the
      // chat from its menu.
      const archivedRow = chatRow(page, context.state.chatTitle)
      if (!(await archivedRow.first().isVisible())) await sidebar(page).getByText("Archived", { exact: true }).first().click()
      await visible(archivedRow, "the chat in the Archived section")
      await chooseRowMenuItem(page, context.state.chatTitle, "Restore")
      await page.goto(`${context.origin}/`)
      await visible(chatRow(page, context.state.chatTitle), "the restored chat back in the list")
      noErrors(opened)
      await opened.close()
    },
  },
  {
    name: "palette-opens-chat",
    agent: true,
    async run(context) {
      assert(context.state.chatTitle && context.state.chatPath, "no chat")
      const opened = await open(context, "/settings/general")
      const { page } = opened
      await visible(page.locator("[data-settings-page]"), "settings")
      await page.getByTitle("Search").filter({ visible: true }).first().click()
      const dialog = page.getByRole("dialog")
      await visible(dialog, "the command palette")
      await page.keyboard.type(context.state.chatTitle)
      await visible(dialog.getByText(context.state.chatTitle, { exact: true }), "the chat among the palette's results")
      await page.keyboard.press("Enter")
      await until(async () => new URL(page.url()).pathname === context.state.chatPath, `the palette to open ${context.state.chatPath}`)
      noErrors(opened)
      await opened.close()
    },
  },
  {
    name: "terminal-runs-a-command",
    async run(context) {
      const opened = await open(context, "/")
      const { page } = opened
      await visible(sidebar(page), "the sidebar")
      await newChat(page)
      // The navbar's terminal button has no label; its shortcut (default keybindings) does the same.
      await page.keyboard.press("Control+Backquote")
      const terminal = page.locator("[data-terminal-visual]")
      await visible(terminal, "the terminal pane")
      await visible(terminal.locator(".xterm"), "xterm in the pane")
      await terminal.locator(".xterm").click()
      await page.keyboard.type("echo e2e-$((40+2))")
      await page.keyboard.press("Enter")
      await until(async () => (await terminal.innerText()).includes("e2e-42"), "the command's output in the terminal", 20_000)
      noErrors(opened)
      await opened.close()
    },
  },
  {
    name: "git-change-in-widgets",
    agent: true,
    async run(context) {
      assert(context.state.chatPath && context.state.chatProject, "no chat")
      const project = context.projects[context.state.chatProject]
      assert(project, `no project named ${context.state.chatProject}`)
      appendFileSync(path.join(project, "README.md"), "\nA line the e2e run added.\n")
      writeFileSync(path.join(project, "src", "added.ts"), "export const added = true\n")
      const opened = await open(context, context.state.chatPath)
      const { page } = opened
      const widgets = page.locator("[data-right-sidebar-visual]")
      if (!(await widgets.first().isVisible().catch(() => false))) {
        await page.getByRole("button", { name: "Show widgets" }).first().click()
      }
      await visible(widgets, "the widgets column")
      await visible(widgets.getByText("README.md", { exact: false }), "the changed README in the widgets", 30_000)
      noErrors(opened)
      await opened.close()
    },
  },
  {
    name: "settings-theme-persists",
    async run(context) {
      const opened = await open(context, "/settings/general")
      const { page } = opened
      const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"))
      await visible(page.locator("[data-settings-page]"), "settings")
      const themeRow = page.locator("[data-settings-page]").getByText("Theme", { exact: true }).first()
      await visible(themeRow, "the Theme row")
      const pick = async (choice: "Light" | "Dark") => {
        await page.getByRole("combobox").filter({ hasText: /^(Light|Dark|System)$/ }).first().click()
        await page.getByRole("option", { name: choice, exact: true }).click()
      }
      await pick("Light")
      await until(async () => !(await isDark()), "the page to turn light")
      await page.reload()
      await visible(page.locator("[data-settings-page]"), "settings after a reload")
      await until(async () => !(await isDark()), "light after a reload")
      await pick("Dark")
      await until(isDark, "the page to turn dark")
      noErrors(opened)
      await opened.close()
    },
  },
  {
    name: "settings-sections",
    async run(context) {
      const opened = await open(context, "/settings")
      const { page } = opened
      await until(async () => new URL(page.url()).pathname === "/settings/general", "/settings to land on General")
      for (const section of ["Providers", "Keybindings", "Usage", "General"]) {
        await page.locator("[data-settings-page]").getByText(section, { exact: true }).first().click()
        await until(async () => new URL(page.url()).pathname === `/settings/${section.toLowerCase()}`, `the ${section} section`)
      }
      noErrors(opened)
      await opened.close()
    },
  },
  {
    name: "mobile-sidebar-and-back",
    agent: true,
    async run(context) {
      assert(context.state.chatTitle, "no chat")
      const opened = await open(context, "/", { width: 390, height: 844 })
      const { page } = opened
      await visible(sidebar(page), "the sidebar filling the phone screen")
      await chatRow(page, context.state.chatTitle).first().click()
      await visible(composer(page), "the chat on the phone")
      await page.getByRole("button", { name: "Back" }).first().click()
      await visible(chatRow(page, context.state.chatTitle), "back on the sidebar")
      assert(new URL(page.url()).pathname === "/", `back at / (${page.url()})`)
      noErrors(opened)
      await opened.close()
    },
  },
  {
    name: "delete-chat",
    agent: true,
    async run(context) {
      assert(context.state.chatTitle, "no chat")
      const opened = await open(context, "/")
      const { page } = opened
      await chooseRowMenuItem(page, context.state.chatTitle, "Delete Chat")
      const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"))
      await visible(dialog, "the delete confirmation")
      await dialog.getByRole("button", { name: "Delete" }).click()
      await gone(chatRow(page, context.state.chatTitle), "the deleted chat")
      context.state.deletedTitle = context.state.chatTitle
      noErrors(opened)
      await opened.close()
    },
  },
]
