import { describe, expect, test } from "bun:test"
import type { LocalProjectSummary } from "../../shared/types"
import { filterProjects, groupByRecency, groupProjectsByRecency } from "./project-groups"

const DAY_MS = 24 * 60 * 60 * 1_000
const NOW_MS = Date.parse("2026-07-17T12:00:00.000Z")

function project(name: string, ageInDays?: number): LocalProjectSummary {
  return {
    localPath: `/projects/${name}`,
    title: name,
    source: "discovered",
    ...(ageInDays === undefined ? {} : { folderModifiedAt: NOW_MS - ageInDays * DAY_MS }),
    chatCount: 0,
  }
}

describe("local project recency groups", () => {
  test("searches project titles and paths case-insensitively", () => {
    const projects = [
      project("Kanna", 1),
      { ...project("website", 1), localPath: "/projects/Superwall/website" },
    ]

    expect(filterProjects(projects, "kANNa").map((entry) => entry.title)).toEqual(["Kanna"])
    expect(filterProjects(projects, "superwall").map((entry) => entry.title)).toEqual(["website"])
    expect(filterProjects(projects, "  ")).toBe(projects)
  })

  test("buckets projects by folder modification time", () => {
    const groups = groupProjectsByRecency([
      project("recent", 2),
      project("this-month", 12),
      project("this-quarter", 45),
      project("old", 120),
      project("unknown"),
    ], NOW_MS)

    expect(groups.map((group) => [
      group.title,
      group.projects.map((entry) => entry.title),
    ])).toEqual([
      ["Recent", ["recent"]],
      ["Last 30 days", ["this-month"]],
      ["Last 90 days", ["this-quarter"]],
      ["Older", ["old", "unknown"]],
    ])
  })

  test("sorts recent groups temporally and older groups alphabetically", () => {
    const groups = groupProjectsByRecency([
      project("Alpha-recent", 5),
      project("Zulu-recent", 1),
      project("Zulu-quarter", 40),
      project("alpha-quarter", 60),
    ], NOW_MS)

    expect(groups[0]?.projects.map((entry) => entry.title)).toEqual([
      "Zulu-recent",
      "Alpha-recent",
    ])
    expect(groups[1]?.projects.map((entry) => entry.title)).toEqual([
      "alpha-quarter",
      "Zulu-quarter",
    ])
  })

  test("generic grouping mirrors the project buckets for repo-shaped items", () => {
    const repo = (name: string, ageInDays?: number) => ({
      nameWithOwner: `acme/${name}`,
      pushedAt: ageInDays === undefined ? null : new Date(NOW_MS - ageInDays * DAY_MS).toISOString(),
    })

    const groups = groupByRecency(
      [repo("zulu", 1), repo("alpha", 5), repo("stale-z", 45), repo("stale-a", 60), repo("unknown")],
      (item) => (item.pushedAt ? Date.parse(item.pushedAt) : undefined),
      (a, b) => a.nameWithOwner.localeCompare(b.nameWithOwner, undefined, { sensitivity: "base" }),
      NOW_MS
    )

    expect(groups.map((group) => [
      group.title,
      group.items.map((entry) => entry.nameWithOwner),
    ])).toEqual([
      ["Recent", ["acme/zulu", "acme/alpha"]],
      ["Last 90 days", ["acme/stale-a", "acme/stale-z"]],
      ["Older", ["acme/unknown"]],
    ])
  })
})
