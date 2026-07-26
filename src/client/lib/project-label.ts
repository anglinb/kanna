import type { SidebarProjectGroup } from "../../shared/types"

/**
 * Branches that carry no information by being shown. Being on `main` is the
 * assumption, so naming it is noise in a slot this narrow — the branch is worth
 * the room exactly when it's a surprise. Note this is a *name* check, not a
 * default-branch lookup: a repo whose default is `develop` will still show it.
 */
const UNREMARKABLE_BRANCHES = new Set(["main", "master"])

/**
 * How the New Sidebar names a project — the trailing label on Chats-tab rows
 * and the Projects-tab section header, kept in one place so the two can't drift.
 *
 * Precedence is "most specific thing the user asked for" first:
 *
 * 1. A rename wins outright. If you named it, that's the name.
 * 2. Otherwise a repo shows as `repo/branch`, dropping to just `repo` when the
 *    branch is unremarkable. The repo root's name is not always the project's
 *    folder name (a project can be a subdirectory of its repo).
 * 3. Otherwise the plain folder name.
 *
 * `repoName` is best-effort (see `WorktreeProbe`): a project whose repo hasn't
 * been resolved yet falls back to (3) and upgrades on the next snapshot, so
 * this must never render an empty string while it waits.
 */
export function formatProjectSidebarLabel(
  group: Pick<SidebarProjectGroup, "title" | "sidebarTitle" | "repoName" | "branchName">
): string {
  if (group.sidebarTitle) return group.sidebarTitle
  if (!group.repoName) return group.title
  // No branch at all on a detached HEAD — the bare repo is still truer than the
  // folder name, so that lands in the same place as being on `main`.
  const branchName = group.branchName
  if (!branchName || UNREMARKABLE_BRANCHES.has(branchName)) return group.repoName
  return `${group.repoName}/${branchName}`
}
