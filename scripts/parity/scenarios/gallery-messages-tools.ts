import { defineScenario, type Scenario } from "../scenario"
import { captureScrolled, centerInGallery } from "./gallery-messages-text"

// The rows whose first button opens them, by section, in page order.
const EXPANDABLE = {
  files: ["bash-1", "bash-2", "read-1", "read-2", "write-1", "edit-1", "edit-2", "delete-1"],
  searches: ["grep-1", "grep-2", "glob-1", "glob-2", "web-1", "skill-1", "mcp-1", "unknown-1", "pending-1"],
  agents: ["agent-1", "agent-2"],
}

// src/foldkit/transcript/messages against the React rows on every tool kind
// the row special-cases (closed, hovered, open), chat and schedule cards,
// an Agent with what it did and its result, and folded runs (open, and
// closed again from the Collapse at the foot of a long one).
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-messages-tools",
    route: "/__gallery/messages-tools",
    async run(context) {
      const { page, capture } = context
      await captureScrolled(context, "closed")

      await page.locator("[data-transcript-row-id='bash-1'] button").first().hover()
      await capture("row-hover")

      for (const ids of Object.values(EXPANDABLE)) {
        for (const id of ids) await page.locator(`[data-transcript-row-id='${id}'] button`).first().click()
      }
      // The Agent's result toggle, under its own transcript.
      await page.locator("[data-transcript-row-id='agent-1']").getByRole("button", { name: "Result" }).click()
      await captureScrolled(context, "open")

      // A code block's copy button shows on hover.
      await centerInGallery(page, "[data-transcript-row-id='bash-1']")
      await page.locator("[data-transcript-row-id='bash-1'] pre").first().hover()
      await capture("code-hover")

      const runs = page.getByRole("region", { name: "Folded runs" })
      await runs.getByRole("button", { name: /3 reads|2 reads/ }).click()
      await runs.getByRole("button", { name: /edits/ }).first().click()
      await centerInGallery(page, "[aria-label='Folded runs']")
      await captureScrolled(context, "runs-open")
      await runs.getByRole("button", { name: "Collapse" }).click()
      await capture("runs-collapsed")
    },
  }),
]
