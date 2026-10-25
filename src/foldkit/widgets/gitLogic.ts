import type {
  ChatAttachment,
  ChatBranchListEntry,
  ChatBranchListResult,
  ChatBranchPullRequest,
  ChatCheckRun,
  ChatCheckRunState,
  ChatCommitChecks,
  ChatDiffSnapshot,
  DiffCommitMode,
} from "../../shared/types"
import type { PickerSection } from "./model"

// The pure parts of the git widgets, copied from the React files they sit
// in (GitWidgets.tsx, git/shared.tsx, git/DiffFileRow.tsx,
// git/BranchPicker.tsx, git/MergeBranchModal.tsx, git/BranchHoverCard.tsx,
// git/CheckRunsSection.tsx, git/DiffFileHoverCard.tsx,
// git/BranchPullRequestRow.tsx), with their comments.

export type DiffFile = ChatDiffSnapshot["files"][number]

export const EMPTY_DIFF_SNAPSHOT: ChatDiffSnapshot = { status: "unknown", files: [] }

// GITWIDGETS.TSX

/**
 * The Changes search: every word of the query in the file's path, in any
 * order, ignoring case. Keeps the list's order.
 */
export function filterFilesByQuery<T extends { path: string }>(files: readonly T[], query: string): readonly T[] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean)
  if (words.length === 0) return files
  return files.filter((file) => {
    const path = file.path.toLowerCase()
    return words.every((word) => path.includes(word))
  })
}

export const INITIAL_VISIBLE_DIFF_FILE_COUNT = 5
export const VISIBLE_DIFF_FILE_INCREMENT = 200
// History opens on the latest few commits; "Show more" reveals the rest of
// what the server sends, which is 25.
export const INITIAL_VISIBLE_HISTORY_COUNT = 5

/**
 * The Changes header: what the commit button will commit. With every file
 * checked that is simply the change set; once some are unchecked it says
 * "3 of 5" and the totals count only the checked files.
 */
export function summarizeChanges(
  files: ReadonlyArray<{ path: string; additions?: number; deletions?: number }>,
  selectedPaths: ReadonlySet<string>,
) {
  const partial = files.some((file) => !selectedPaths.has(file.path))
  const counted = partial ? files.filter((file) => selectedPaths.has(file.path)) : files
  const noun = files.length === 1 ? "file" : "files"
  return {
    title: partial ? `${counted.length} of ${files.length} ${noun} changed` : `${files.length} ${noun} changed`,
    additions: counted.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: counted.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  }
}

/** The commits History lists, and how many a "Show more" would add. */
export function visibleHistoryEntries<T>(entries: readonly T[], showAll: boolean) {
  const shown = showAll ? entries : entries.slice(0, INITIAL_VISIBLE_HISTORY_COUNT)
  return { shown, hiddenCount: entries.length - shown.length }
}

export function getPrimaryCommitActionPrefix(args: {
  hasSummary: boolean
  isGenerating: boolean
  isCommitting: boolean
  isGeneratedCommitInFlight: boolean
  commitModeInFlight: DiffCommitMode | null
  primaryCommitMode: DiffCommitMode
}) {
  if (args.hasSummary) {
    if (args.isCommitting) {
      if (args.isGeneratedCommitInFlight) {
        return args.commitModeInFlight === "commit_only" ? "Committing…" : "Pushing…"
      }
      return args.commitModeInFlight === "commit_only" ? "Committing…" : "Committing & Pushing…"
    }
    return args.primaryCommitMode === "commit_only" ? "Commit to" : "Commit & push to"
  }
  if (args.isGenerating) return "Generating…"
  return args.primaryCommitMode === "commit_only" ? "Generate & commit to" : "Generate & push to"
}

// GIT/SHARED.TSX

/**
 * The letter git would print, in the column's status colors. An untracked
 * file is a new one as far as a commit is concerned, so it reads "A" too.
 */
export function diffStatus(file: DiffFile): { letter: string; label: string; className: string } {
  if (file.isUntracked || file.changeType === "added") return { letter: "A", label: "Added", className: "text-success" }
  if (file.changeType === "deleted") return { letter: "D", label: "Deleted", className: "text-destructive" }
  if (file.changeType === "renamed") return { letter: "R", label: "Renamed", className: "text-info" }
  return { letter: "M", label: "Modified", className: "text-muted-foreground" }
}

const GENERATED_FILE_NAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "deno.lock",
  "Cargo.lock", "Gemfile.lock", "composer.lock", "poetry.lock", "Pipfile.lock", "uv.lock", "go.sum", "go.work.sum",
  "Podfile.lock", "Package.resolved", "flake.lock", "pubspec.lock", "mix.lock", "gradle.lockfile", "project.pbxproj",
])
const GENERATED_FILE_PATTERN = /(?:[.-]min\.(?:js|mjs|css)|\.(?:js|mjs|css)\.map|\.pb\.(?:go|swift|cc|h)|_pb2(?:_grpc)?\.pyi?|\.xcworkspacedata)$/iu

export function isGeneratedPath(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1)
  return GENERATED_FILE_NAMES.has(name) || GENERATED_FILE_PATTERN.test(name)
}

/** Changed lines past which a diff waits for a click. */
export const LARGE_DIFF_LINES = 1_000

/** Why a file's diff isn't drawn straight away, GitHub's precautions. Null when it's drawn as usual. */
export function diffHold(file: DiffFile): { message: string; loadable: boolean } | null {
  const lines = file.additions + file.deletions
  if (file.binary) return { message: "Binary file not shown.", loadable: false }
  if (file.changeType === "renamed" && lines === 0) return { message: "File renamed without changes.", loadable: false }
  if (file.changeType !== "deleted" && file.size === 0) return { message: "Empty file.", loadable: false }
  if (file.changeType === "deleted") return { message: "This file was deleted.", loadable: true }
  if (isGeneratedPath(file.path)) return { message: "Generated files are not rendered by default.", loadable: true }
  if (lines > LARGE_DIFF_LINES) return { message: "Large diffs are not rendered by default.", loadable: true }
  return null
}

const PATH_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/** Tree order, as GitHub's and VS Code's file lists. */
export function compareFilePaths(left: string, right: string) {
  const leftParts = left.split("/")
  const rightParts = right.split("/")
  const shared = Math.min(leftParts.length, rightParts.length)
  for (let index = 0; index < shared; index += 1) {
    const leftPart = leftParts[index]!
    const rightPart = rightParts[index]!
    if (leftPart === rightPart) continue
    const leftIsFolder = index < leftParts.length - 1
    const rightIsFolder = index < rightParts.length - 1
    if (leftIsFolder !== rightIsFolder) return leftIsFolder ? -1 : 1
    return PATH_COLLATOR.compare(leftPart, rightPart) || (leftPart < rightPart ? -1 : 1)
  }
  return leftParts.length - rightParts.length
}

export function sortByPath<T extends { path: string }>(files: readonly T[]): T[] {
  return [...files].sort((left, right) => compareFilePaths(left.path, right.path))
}

/** "src/app/Page.tsx" → name "Page.tsx", folder "src/app". */
export function splitDiffPath(path: string) {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? { name: path, folder: "" } : { name: path.slice(slash + 1), folder: path.slice(0, slash) }
}

/** An image or PDF shows as itself rather than as a binary diff. */
export function getDiffPreviewAttachment(projectId: string | null, file: DiffFile): ChatAttachment | null {
  if (!projectId || !file.mimeType || typeof file.size !== "number" || file.changeType === "deleted") return null
  if (!file.mimeType.startsWith("image/") && file.mimeType !== "application/pdf") return null
  return {
    id: `diff:${file.path}`,
    kind: file.mimeType.startsWith("image/") ? "image" : "file",
    displayName: file.path.split("/").pop() ?? file.path,
    absolutePath: file.path,
    relativePath: file.path,
    contentUrl: `/api/projects/${projectId}/files/${encodeURIComponent(file.path)}/content`,
    mimeType: file.mimeType,
    size: file.size,
  }
}

/** A tag or label inside a hover card's small-print row. */
export const CARD_PILL_CLASS = "shrink-0 rounded-full border border-border px-1.5 text-[11px] leading-[14px]"

// GIT/DIFFFILEROW.TSX

export function canIgnoreDiffFile(file: DiffFile) {
  // New files are ignorable whether they are untracked or already staged.
  // Tracked files stay disabled: .gitignore has no effect on tracked files.
  return file.isUntracked || file.changeType === "added"
}

export function canIgnoreDiffFolder(file: DiffFile) {
  if (!canIgnoreDiffFile(file)) return false
  return file.path.includes("/")
}

// GIT/BRANCHPICKER.TSX

/** Unsearched, Local and Remote show only this many, newest commit first. */
export const UNSEARCHED_BRANCH_LIMIT = 5

export function mostRecentBranches(entries: ChatBranchListEntry[], limit = UNSEARCHED_BRANCH_LIMIT) {
  if (entries.length <= limit) return entries
  return [...entries]
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
    .slice(0, limit)
}

export interface BranchCreateOption {
  name: string
  baseBranchName?: string
}

/**
 * What "Create branch" offers for a search: nothing while the search is empty
 * or names a branch that already exists, otherwise the name off the default
 * branch and, when HEAD is elsewhere, off the current one too.
 */
export function branchCreateOptions(
  query: string,
  branchList: ChatBranchListResult | null,
  currentBranchName?: string,
): BranchCreateOption[] {
  const name = query.trim().replace(/\s+/g, "-")
  if (!name || !branchList) return []
  const existing = [...branchList.recent, ...branchList.local, ...branchList.remote, ...branchList.pullRequests]
  if (name === currentBranchName || existing.some((entry) => entry.name === name || entry.displayName === name)) return []
  const bases = [...new Set([branchList.defaultBranchName, currentBranchName].filter((base): base is string => Boolean(base)))]
  return bases.length === 0 ? [{ name }] : bases.map((baseBranchName) => ({ name, baseBranchName }))
}

/** The picker's sections for a search. One search covers all of them. */
export function branchPickerSections(args: {
  branchList: ChatBranchListResult | null
  query: string
  currentBranchName?: string
  showAllLocal: boolean
  showAllRemote: boolean
  showAllPullRequests: boolean
}) {
  const { branchList, currentBranchName, showAllLocal, showAllRemote, showAllPullRequests } = args
  const normalizedQuery = args.query.trim().toLowerCase()
  const matches = (entry: ChatBranchListEntry) => entry.name !== currentBranchName && (
    !normalizedQuery
    || [entry.displayName, entry.name, entry.description, entry.prTitle, entry.headLabel, entry.prNumber ? `#${entry.prNumber}` : undefined]
      .some((value) => value?.toLowerCase().includes(normalizedQuery))
  )
  const pullRequestHeadNames = new Set((branchList?.pullRequests ?? []).map((entry) => entry.headRefName ?? entry.name))
  const allLocal = (branchList?.local ?? []).filter(matches)
  // A remote branch with an open PR shows once, as the PR.
  const allRemote = (branchList?.remote ?? []).filter((entry) => matches(entry) && !pullRequestHeadNames.has(entry.name))
  const allPullRequests = (branchList?.pullRequests ?? []).filter(matches)
  return {
    recent: (branchList?.recent ?? []).filter(matches),
    pullRequests: normalizedQuery || showAllPullRequests ? allPullRequests : mostRecentBranches(allPullRequests),
    local: normalizedQuery || showAllLocal ? allLocal : mostRecentBranches(allLocal),
    remote: normalizedQuery || showAllRemote ? allRemote : mostRecentBranches(allRemote),
    allPullRequestCount: allPullRequests.length,
    allLocalCount: allLocal.length,
    allRemoteCount: allRemote.length,
  }
}

/** PRs whose state the picker reads before any hover. */
export const PREFETCHED_PULL_REQUEST_LIMIT = 10

export type PickerOption =
  | { id: string; kind: "branch"; entry: ChatBranchListEntry }
  | { id: string; kind: "create"; option: BranchCreateOption }

/** The picker's list id (React's useId). */
export const PICKER_LIST_ID = "widgets-branch-picker"
export const pickerOptionId = (entry: ChatBranchListEntry) => `${PICKER_LIST_ID}-${entry.id}`
export const pickerCreateId = (option: BranchCreateOption) => `${PICKER_LIST_ID}-create-${option.baseBranchName ?? ""}`

/** What the picker shows, worked out once for the view and the keys. */
export function pickerState(picker: {
  query: string
  branchList: ChatBranchListResult | null
  showAllLocal: boolean
  showAllRemote: boolean
  showAllPullRequests: boolean
  collapsedSections: ReadonlyArray<PickerSection>
  keyboardActiveId: string | null
}, currentBranchName: string | undefined) {
  const currentName = picker.branchList?.currentBranchName ?? currentBranchName
  const sections = branchPickerSections({ ...picker, currentBranchName: currentName })
  const createOptions = branchCreateOptions(picker.query, picker.branchList, currentName)
  const searching = picker.query.trim().length > 0
  const isExpanded = (section: PickerSection) => searching || !picker.collapsedSections.includes(section)
  const options: PickerOption[] = [
    ...(["recent", "pullRequests", "local", "remote"] as const)
      .flatMap((section) => (isExpanded(section) ? sections[section] : []))
      .map((entry): PickerOption => ({ id: pickerOptionId(entry), kind: "branch", entry })),
    ...createOptions.map((option): PickerOption => ({ id: pickerCreateId(option), kind: "create", option })),
  ]
  // Enter's target: the keyboard cursor when there is one; while searching,
  // otherwise, the best match. With no search and no cursor, nothing.
  const resolvedActiveId = picker.keyboardActiveId && options.some((option) => option.id === picker.keyboardActiveId)
    ? picker.keyboardActiveId
    : searching ? options[0]?.id ?? null : null
  return { currentName, sections, createOptions, searching, isExpanded, options, resolvedActiveId }
}

// GIT/MERGEBRANCHMODAL.TSX

function getBranchCandidatePriority(entry: ChatBranchListEntry) {
  switch (entry.kind) {
    case "local":
      return 0
    case "pull_request":
      return 1
    case "remote":
    default:
      return 2
  }
}

function dedupeBranchEntries(entries: ChatBranchListEntry[]) {
  const selectedByName = new Map<string, ChatBranchListEntry>()
  for (const entry of entries) {
    const existing = selectedByName.get(entry.name)
    if (!existing || getBranchCandidatePriority(entry) < getBranchCandidatePriority(existing)) {
      selectedByName.set(entry.name, entry)
    }
  }
  return selectedByName
}

export function getMergeBranchGroups(branchList: ChatBranchListResult | null, currentBranchName?: string) {
  if (!branchList) return { defaultBranch: undefined, recent: [] as ChatBranchListEntry[], other: [] as ChatBranchListEntry[] }
  const uniqueEntriesByName = dedupeBranchEntries([...branchList.local, ...branchList.pullRequests, ...branchList.remote])
  if (currentBranchName) uniqueEntriesByName.delete(currentBranchName)
  const usedNames = new Set<string>()
  const defaultBranch = branchList.defaultBranchName ? uniqueEntriesByName.get(branchList.defaultBranchName) : undefined
  if (defaultBranch) usedNames.add(defaultBranch.name)
  const recent = branchList.recent
    .map((entry) => uniqueEntriesByName.get(entry.name) ?? entry)
    .filter((entry): entry is ChatBranchListEntry => Boolean(entry) && !usedNames.has(entry.name))
  for (const entry of recent) usedNames.add(entry.name)
  const other = [...uniqueEntriesByName.values()]
    .filter((entry) => !usedNames.has(entry.name))
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
  return { defaultBranch, recent, other }
}

export function mergeMatches(entry: ChatBranchListEntry, query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  return [entry.displayName, entry.name, entry.description, entry.prTitle, entry.headLabel]
    .some((value) => value?.toLowerCase().includes(normalizedQuery))
}

// GIT/BRANCHPULLREQUESTROW.TSX

/** The branch's PR as a branch picker entry. Keyed by its last update. */
export function branchPullRequestEntry(branchName: string, pr: ChatBranchPullRequest): ChatBranchListEntry {
  return {
    id: `pr:${pr.number}`,
    kind: "pull_request",
    name: branchName,
    displayName: pr.title,
    prNumber: pr.number,
    prTitle: pr.title,
    headRefName: branchName,
    updatedAt: pr.updatedAt,
  }
}

// GIT/BRANCHHOVERCARD.TSX

/** Keyed by the row and its tip time, so a branch that moved reads again. */
export function branchDetailsKey(entry: ChatBranchListEntry) {
  return `${entry.id}\u0000${entry.updatedAt ?? ""}`
}

/** A PR body as a preview: without the template's scaffolding, runs of blank lines collapsed. */
export function previewPullRequestBody(body: string) {
  return body
    .replace(/<!--[\s\S]*?-->/gu, "")
    .split("\n")
    .filter((line) => !/^\s{0,3}#{1,6}\s/u.test(line))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
}

// GIT/COMMITHOVERCARD.TSX

/** A commit never changes but its checks do, so the key carries the row's rollup. */
export function commitDetailsKey(entry: { sha: string; checks?: ChatCommitChecks }) {
  const checks = entry.checks
  return checks ? `${entry.sha}\u0000${checks.state}:${checks.passed}/${checks.total}` : entry.sha
}

// GIT/DIFFFILEHOVERCARD.TSX

/** Lines the peek shows: enough to recognise the change, not to review it. */
const PEEK_LINE_LIMIT = 12

export interface PatchPeek {
  header: string
  lines: Array<{ kind: "add" | "remove" | "context"; text: string }>
  moreChanges: number
}

/** The first hunk of a unified patch, cut to a few lines, plus how many changed lines the rest holds. */
export function peekPatch(patch: string, limit = PEEK_LINE_LIMIT): PatchPeek | null {
  const lines = patch.split("\n")
  const start = lines.findIndex((line) => line.startsWith("@@"))
  if (start === -1) return null
  const peek: PatchPeek = { header: lines[start]!, lines: [], moreChanges: 0 }
  for (const line of lines.slice(start + 1)) {
    const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : line.startsWith(" ") ? "context" : null
    if (!kind) continue
    if (peek.lines.length < limit) {
      peek.lines.push({ kind, text: line.slice(1) })
    } else if (kind !== "context") {
      peek.moreChanges += 1
    }
  }
  return peek
}

/** Keyed by path and patch digest: an edit to the file reads it again. */
export function patchKey(file: DiffFile) {
  return `${file.path}\u0000${file.patchDigest}`
}

// GIT/CHECKRUNSSECTION.TSX

/** Enough to show every failing job on most repos without the card running off the screen. */
export const VISIBLE_CHECK_RUN_COUNT = 8

const STATE_RANK: Record<ChatCheckRunState, number> = { failure: 0, pending: 1, success: 2, neutral: 3, skipped: 4 }

/** Failing first, then running; GitHub's order within each. */
export function sortCheckRuns(runs: readonly ChatCheckRun[]): ChatCheckRun[] {
  return [...runs].sort((left, right) => STATE_RANK[left.state] - STATE_RANK[right.state])
}

export function rollupFromRuns(runs: readonly ChatCheckRun[]): ChatCommitChecks {
  const passed = runs.filter((run) => run.state === "success").length
  const state = runs.some((run) => run.state === "failure")
    ? "failure"
    : runs.some((run) => run.state === "pending") ? "pending" : "success"
  return { state, passed, total: runs.length }
}

export function countCheckRuns(runs: readonly ChatCheckRun[]): Record<ChatCheckRunState, number> {
  const counts: Record<ChatCheckRunState, number> = { success: 0, failure: 0, pending: 0, skipped: 0, neutral: 0 }
  for (const run of runs) counts[run.state] += 1
  return counts
}

/** How long CI took, start to finish on the wall clock. */
export function checksWallClock(runs: readonly ChatCheckRun[], now = Date.now()): { ms: number; running: boolean } | null {
  const starts = runs.map((run) => Date.parse(run.startedAt ?? "")).filter(Number.isFinite)
  if (starts.length === 0) return null
  const running = runs.some((run) => run.state === "pending")
  const ends = runs.map((run) => Date.parse(run.completedAt ?? "")).filter(Number.isFinite)
  const end = running ? now : Math.max(...ends)
  const ms = end - Math.min(...starts)
  return Number.isFinite(ms) && ms >= 0 ? { ms, running } : null
}
