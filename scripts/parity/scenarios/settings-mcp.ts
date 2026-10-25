import { defineScenario, type Scenario } from "../scenario"
import { click, parkPointer, regions, rest } from "./_lib/helpers"

// Settings → MCP Servers: the list (one connected remote server, one local
// command), adding, editing, testing, signing out, removing, importing.

const route = "/settings/mcp"
const desktop = { viewports: ["desktop" as const] }

export const scenarios: Scenario[] = [
  defineScenario({
    name: "settings-mcp",
    route,
    regions: regions("settings"),
    covers: { routes: [route], commands: ["mcp.read"] },
  }),
  defineScenario({
    name: "settings-mcp-add-server",
    route,
    ...desktop,
    regions: regions("settings", "listbox"),
    covers: { routes: [route], commands: ["mcp.save"] },
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("button", { name: "Add server" }))
      await context.capture("form")
      await page.getByRole("textbox", { name: "Server name" }).fill("sentry")
      await click(context, page.getByRole("combobox", { name: "Connection type" }))
      await context.capture("connection-types")
      await click(context, page.getByRole("option", { name: "Local command" }))
      await page.getByRole("textbox", { name: "Server command" }).fill("npx")
      await rest(context)
      await context.capture("filled")
      await click(context, page.getByRole("button", { name: "Save server" }))
      await parkPointer(context)
      await context.capture("saved")
    },
  }),
  defineScenario({
    // Bad JSON in the advanced field is refused before anything is sent.
    name: "settings-mcp-add-server-invalid-json",
    route,
    ...desktop,
    regions: regions("settings"),
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("button", { name: "Add server" }))
      await page.getByRole("textbox", { name: "Server name" }).fill("broken")
      await page.getByRole("textbox", { name: "Server URL" }).fill("https://example.com/mcp")
      await page.getByLabel("Arguments and authentication").fill("{not json")
      await click(context, page.getByRole("button", { name: "Save server" }))
      await parkPointer(context)
      await context.capture("refused")
    },
  }),
  defineScenario({
    name: "settings-mcp-server-actions",
    route,
    ...desktop,
    regions: regions("settings"),
    covers: { routes: [route], commands: ["mcp.connect", "mcp.read", "mcp.disconnect", "mcp.save", "mcp.remove"] },
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("button", { name: "Test connection" }))
      await parkPointer(context)
      await context.capture("tested")
      await click(context, page.getByRole("switch", { name: "Use github in Cursor" }))
      await parkPointer(context)
      await context.capture("cursor-off")
      await click(context, page.getByRole("button", { name: "Sign out" }).first())
      await parkPointer(context)
      await context.capture("signed-out")
      await click(context, page.getByRole("button", { name: "Remove playwright" }))
      await parkPointer(context)
      await context.capture("removed")
    },
  }),
  defineScenario({
    name: "settings-mcp-edit-server",
    route,
    ...desktop,
    regions: regions("settings"),
    covers: { routes: [route], commands: ["mcp.save"] },
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("button", { name: "Edit" }).first())
      await context.capture("editing")
      await page.getByRole("textbox", { name: "Server name" }).fill("github-copilot")
      await click(context, page.getByRole("button", { name: "Save server" }))
      await parkPointer(context)
      await context.capture("saved")
    },
  }),
  defineScenario({
    name: "settings-mcp-import",
    route,
    ...desktop,
    regions: regions("settings"),
    covers: { routes: [route], commands: ["mcp.importProvider", "mcp.importConfig"] },
    async run(context) {
      const { page } = context
      await click(context, page.getByRole("button", { name: "Import configuration" }))
      await context.capture("open")
      await click(context, page.getByRole("button", { name: "Import from Claude" }))
      await parkPointer(context)
      await context.capture("imported-from-claude")
      await click(context, page.getByRole("button", { name: "Import configuration" }))
      await page.getByLabel("Or paste JSON / TOML configuration").fill('{"mcpServers": {"linear": {"url": "https://mcp.linear.app/mcp"}}}')
      await click(context, page.getByRole("button", { name: "Import servers" }))
      await parkPointer(context)
      await context.capture("imported-pasted")
    },
  }),
]
