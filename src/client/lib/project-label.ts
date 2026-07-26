import type { SidebarProjectGroup } from "../../shared/types"

/**
 * How the New Sidebar names a project — the trailing label on Chats-tab rows
 * and the Projects-tab section header, kept in one place so the two can't drift.
 *
 * Precedence is "most specific thing the user asked for" first:
 *
 * 1. A rename wins outright. If you named it, that's the name.
 * 2. Otherwise a repo shows as `repo/branch` — the branch is the thing that
 *    actually changes under you, and the repo root's name is not always the
 *    project's folder name (a project can be a subdirectory of its repo).
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
  // Detached HEAD has no branch to name — the bare repo is still truer than
  // the folder name, so don't fall back.
  return group.branchName ? `${group.repoName}/${group.branchName}` : group.repoName
}
