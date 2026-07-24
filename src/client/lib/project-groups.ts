import type { LocalProjectSummary } from "../../shared/types"
import { getPathBasename } from "./formatters"

/**
 * Recency grouping/filtering for local projects — shared by the Local
 * Projects page and the command palette's Add Project page so both render
 * the exact same buckets. The generic `groupByRecency` core is also used by
 * the home page's GitHub repos section so it mirrors the same buckets.
 */

const DAY_MS = 24 * 60 * 60 * 1_000

export type RecencyGroupKey = "recent" | "last-30-days" | "last-90-days" | "older"

export interface RecencyGroup<T> {
  key: RecencyGroupKey
  title: string
  items: T[]
}

export interface ProjectRecencyGroup {
  key: RecencyGroupKey
  title: string
  projects: LocalProjectSummary[]
}

function compareProjectsAlphabetically(a: LocalProjectSummary, b: LocalProjectSummary) {
  return getPathBasename(a.localPath).localeCompare(getPathBasename(b.localPath), undefined, {
    sensitivity: "base",
  })
}

export function filterProjects(projects: LocalProjectSummary[], search: string) {
  const query = search.trim().toLocaleLowerCase()
  if (!query) return projects

  return projects.filter((project) => (
    project.title.toLocaleLowerCase().includes(query)
    || project.localPath.toLocaleLowerCase().includes(query)
  ))
}

/**
 * Bucket items into Recent (< 7d) / Last 30 days / Last 90 days / Older.
 * The two fresh buckets sort temporally (newest first); the two stale ones
 * alphabetically. Items with no timestamp land in "Older".
 */
export function groupByRecency<T>(
  items: T[],
  getModifiedAt: (item: T) => number | undefined,
  compareAlphabetically: (a: T, b: T) => number,
  nowMs: number = Date.now()
): RecencyGroup<T>[] {
  const groups: RecencyGroup<T>[] = [
    { key: "recent", title: "Recent", items: [] },
    { key: "last-30-days", title: "Last 30 days", items: [] },
    { key: "last-90-days", title: "Last 90 days", items: [] },
    { key: "older", title: "Older", items: [] },
  ]

  for (const item of items) {
    const modifiedAt = getModifiedAt(item)
    const ageMs = modifiedAt === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, nowMs - modifiedAt)

    if (ageMs < 7 * DAY_MS) {
      groups[0].items.push(item)
    } else if (ageMs < 30 * DAY_MS) {
      groups[1].items.push(item)
    } else if (ageMs < 90 * DAY_MS) {
      groups[2].items.push(item)
    } else {
      groups[3].items.push(item)
    }
  }

  const compareByModifiedAt = (a: T, b: T) => (getModifiedAt(b) ?? 0) - (getModifiedAt(a) ?? 0)
  groups[0].items.sort(compareByModifiedAt)
  groups[1].items.sort(compareByModifiedAt)
  groups[2].items.sort(compareAlphabetically)
  groups[3].items.sort(compareAlphabetically)

  return groups.filter((group) => group.items.length > 0)
}

export function groupProjectsByRecency(
  projects: LocalProjectSummary[],
  nowMs: number = Date.now()
): ProjectRecencyGroup[] {
  return groupByRecency(
    projects,
    (project) => project.folderModifiedAt,
    compareProjectsAlphabetically,
    nowMs
  ).map(({ key, title, items }) => ({ key, title, projects: items }))
}
