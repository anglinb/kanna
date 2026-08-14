import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ChatBranchHistoryEntry } from "../../../../shared/types"
import { CommitHistoryRow } from "./CommitHistoryRow"

const BASE_ENTRY: ChatBranchHistoryEntry = {
  sha: "477b7490000000000000000000000000000000aa",
  summary: "Slide the pane tab underline to the selected tab",
  description: "",
  authorName: "jakemor",
  authoredAt: new Date(Date.now() - 60_000).toISOString(),
  tags: [],
  githubUrl: "https://github.com/acme/repo/commit/477b749",
}

function render(entry: ChatBranchHistoryEntry) {
  return renderToStaticMarkup(createElement(CommitHistoryRow, { entry }))
}

describe("CommitHistoryRow", () => {
  test("shows the check count and links the Actions run", () => {
    const markup = render({
      ...BASE_ENTRY,
      checks: {
        state: "success",
        passed: 3,
        total: 4,
        url: "https://github.com/acme/repo/actions/runs/31806888047",
      },
    })

    expect(markup).toContain("3 of 4 checks passed")
    expect(markup).toContain("3 / 4")
  })

  test("marks a running rollup as pending", () => {
    const markup = render({
      ...BASE_ENTRY,
      checks: { state: "pending", passed: 1, total: 3 },
    })

    expect(markup).toContain("Checks running")
    expect(markup).toContain("1 / 3")
  })

  test("omits the badge when the commit has no checks", () => {
    expect(render(BASE_ENTRY)).not.toContain("checks passed")
  })
})
