import { describe, expect, test } from "bun:test"
import { formatProjectSidebarLabel } from "./project-label"

describe("formatProjectSidebarLabel", () => {
  test("uses the folder name when the project is not in a repo", () => {
    expect(formatProjectSidebarLabel({ title: "notes" })).toBe("notes")
  })

  test("uses repo/branch when the project is in a repo", () => {
    expect(formatProjectSidebarLabel({ title: "kanna", repoName: "kanna", branchName: "main" }))
      .toBe("kanna/main")
  })

  test("prefers the repo root over the project's own folder name", () => {
    // A project opened at <repo>/packages/ui: the repo is what identifies it.
    expect(formatProjectSidebarLabel({ title: "ui", repoName: "kanna", branchName: "main" }))
      .toBe("kanna/main")
  })

  test("a rename wins over the repo", () => {
    expect(formatProjectSidebarLabel({
      title: "Work",
      sidebarTitle: "Work",
      repoName: "kanna",
      branchName: "main",
    })).toBe("Work")
  })

  test("falls back to the repo alone on a detached HEAD", () => {
    expect(formatProjectSidebarLabel({ title: "kanna", repoName: "kanna" })).toBe("kanna")
  })

  test("never renders empty while the repo is still being resolved", () => {
    expect(formatProjectSidebarLabel({ title: "kanna", branchName: "main" })).toBe("kanna")
  })
})
