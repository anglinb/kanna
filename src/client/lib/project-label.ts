import type { SidebarProjectGroup } from "../../shared/types"

/**
 * Branches that carry no information by being shown. Being on `main` is the
 * assumption, so naming it is noise in a slot this narrow — the branch is worth
 * the room exactly when it's a surprise. Note this is a *name* check, not a
 * default-branch lookup: a repo whose default is `develop` will still show it.
 */
const UNREMARKABLE_BRANCHES = new Set(["main", "master"])

/**
 * How a project is named in the sidebar, split into the parts the surfaces
 * actually render rather than one pre-joined string.
 *
 * The split exists because being off `main` is shown two ways at once: inline
 * it's a branch *glyph* next to the repo (the name stays readable at sidebar
 * width, which `repo/some-long-branch` did not), and on hover it's the branch
 * spelled out with `owner/repo` under it. Both need the pieces, so nobody
 * re-derives them from `text`.
 */
export interface ProjectSidebarLabel {
  /** What renders inline: the rename, the repo, or the folder name. */
  name: string
  /**
   * Set only when the branch is worth flagging — off `main`/`master`, and not
   * overridden by a rename. Its presence *is* the "show the branch glyph"
   * signal, so surfaces don't repeat the unremarkable-branch rule.
   */
  branchName?: string
  /**
   * `owner/repo` for the tooltip's second line, falling back to the bare repo
   * when the origin owner isn't known (no remote, or not yet probed). Absent
   * entirely when the project isn't in a repo.
   */
  repoPath?: string
  /**
   * Flat `repo/branch` form. Kept for text-only consumers — command-palette
   * search scoring, which matches what a row *says* including its branch.
   */
  text: string
}

/**
 * How the New Sidebar names a project — the trailing label on Chats-tab rows
 * and the Projects-tab section header, kept in one place so the two can't drift.
 *
 * Precedence is "most specific thing the user asked for" first:
 *
 * 1. A rename wins outright. If you named it, that's the name — and no branch
 *    is flagged on it, since the name you chose is the whole label.
 * 2. Otherwise the repo name, flagged with its branch when the branch is a
 *    surprise. The repo root's name is not always the project's folder name (a
 *    project can be a subdirectory of its repo).
 * 3. Otherwise the plain folder name.
 *
 * `repoName` is best-effort (see `WorktreeProbe`): a project whose repo hasn't
 * been resolved yet falls back to (3) and upgrades on the next snapshot, so
 * this must never render an empty string while it waits.
 */
export function getProjectSidebarLabel(
  group: Pick<SidebarProjectGroup, "title" | "sidebarTitle" | "repoName" | "branchName" | "repoOwner">
): ProjectSidebarLabel {
  if (group.sidebarTitle) return { name: group.sidebarTitle, text: group.sidebarTitle }
  if (!group.repoName) return { name: group.title, text: group.title }

  const repoPath = group.repoOwner ? `${group.repoOwner}/${group.repoName}` : group.repoName
  // No branch at all on a detached HEAD — the bare repo is still truer than the
  // folder name, so that lands in the same place as being on `main`.
  const branchName = group.branchName
  if (!branchName || UNREMARKABLE_BRANCHES.has(branchName)) {
    return { name: group.repoName, repoPath, text: group.repoName }
  }
  return {
    name: group.repoName,
    branchName,
    repoPath,
    text: `${group.repoName}/${branchName}`,
  }
}

/** The flat `repo/branch` string — see `ProjectSidebarLabel.text`. */
export function formatProjectSidebarLabel(
  group: Pick<SidebarProjectGroup, "title" | "sidebarTitle" | "repoName" | "branchName" | "repoOwner">
): string {
  return getProjectSidebarLabel(group).text
}
