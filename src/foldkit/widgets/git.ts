import { Option } from "effect"
import type { Html } from "foldkit/html"
import { formatRelativeTime } from "../../client/lib/formatters"
import { cn } from "../../client/lib/utils"
import type { ChatBranchHistoryEntry, ChatBranchListEntry, DiffCommitMode } from "../../shared/types"
import { isDiffPathChecked } from "../core/stores/diffCommit"
import type { Child } from "../ui/attributes"
import { buttonClass } from "../ui/button"
import * as ContextMenu from "../ui/context-menu"
import {
  ArrowDown,
  ArrowUp,
  Check,
  Eye,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitMerge,
  Github,
  GitPullRequest,
  GitPullRequestDraft,
  History,
  LoaderCircle,
  PenLine,
  Pencil,
  RefreshCw,
  Search,
  Sparkles,
  Upload,
} from "../ui/icons"
import { input } from "../ui/input"
import { textarea } from "../ui/textarea"
import { pickerView } from "./branchPicker"
import { branchCardContent, commitCardContent, diffFileCardContent, pullRequestCardContent } from "./cards"
import { rowMenu, sameTarget, toParts, tooltip, type ColumnContext, type H } from "./context"
import { mergeDialogView, publishDialogView } from "./gitDialogs"
import {
  branchDetailsKey,
  branchPullRequestEntry,
  CARD_PILL_CLASS,
  commitDetailsKey,
  diffHold,
  diffStatus,
  filterFilesByQuery,
  getDiffPreviewAttachment,
  getPrimaryCommitActionPrefix,
  INITIAL_VISIBLE_DIFF_FILE_COUNT,
  INITIAL_VISIBLE_HISTORY_COUNT,
  patchKey,
  sortByPath,
  splitDiffPath,
  summarizeChanges,
  VISIBLE_DIFF_FILE_INCREMENT,
  visibleHistoryEntries,
  type DiffFile,
} from "./gitLogic"
import { checksIcon, diffFileStat, labelledIcon, pullRequestStateIcon, stageCheckbox } from "./gitParts"
import { listHoverAttributes, listHoverCard } from "./hoverCard"
import { Message } from "./message"
import { RequestBranchDetails } from "./mounts"
import {
  WIDGET_FOOTER_BUTTON_CLASS,
  WIDGET_FOOTER_ICON_BUTTON_CLASS,
  WIDGET_ROW_REVEAL_CLASS,
  WIDGET_STRIP_INPUT_CLASS,
  swapIn,
  widgetCard,
  widgetFooter,
  widgetList,
  widgetMoreRow,
  widgetPresence,
  widgetRow,
  widgetStatic,
  widgetStrip,
} from "./parts"

// GitWidgets (widgets/GitWidgets.tsx): the git part of the widget column,
// split by time. Branch is the present: where you are and what you're doing
// there (the branch's PR, the changes and the commit box), with the branch
// picker in place of its body while the header is open. Commits is the past.

export const HOVER_LISTS = {
  changes: "changes",
  history: "history",
  branchPullRequest: "branch-pr",
  picker: "picker",
} as const

const toHover = (message: Parameters<typeof Message.GotHoverMessage>[0]["message"]) => Message.GotHoverMessage({ message })
const stopped = (message: Parameters<typeof Message.GotPartsMessage>[0]["message"]) => Message.GotPartsMessage({ message })

/** The icon-only Fetch button's tooltip: when it last ran. */
function formatFetchTooltip(isoTimestamp?: string) {
  if (!isoTimestamp) return "No local fetch recorded"
  return `Fetched ${formatRelativeTime(isoTimestamp)}`
}

/** What the git cards work out from the snapshot and the column's state. */
export function gitFacts(context: Pick<ColumnContext, "diffs" | "model" | "selection" | "summary">) {
  const { diffs, model, selection } = context
  const git = model.git
  const hasChanges = diffs.files.length > 0
  const filesInOrder = sortByPath(diffs.files)
  const selectedPaths = diffs.files.filter((file) => isDiffPathChecked(selection, file.path)).map((file) => file.path)
  const selectedCount = selectedPaths.length
  const allSelected = diffs.files.length > 0 && selectedCount === diffs.files.length
  const someSelected = selectedCount > 0 && selectedCount < diffs.files.length
  const trimmedSummary = context.summary.trim()
  const hasSummary = trimmedSummary.length > 0
  const isCommitting = git.commitModeInFlight !== null
  const isBusy = git.isGenerating || isCommitting
  const branchHistory = diffs.branchHistory?.entries ?? []
  const behindCount = diffs.behindCount ?? 0
  const aheadCount = diffs.aheadCount ?? 0
  const isPublishedBranch = diffs.hasUpstream === true
  const isPublishableBranch = diffs.hasUpstream === false && Boolean(diffs.branchName)
  const hasRemoteOrigin = diffs.hasOriginRemote === true
  const encodedBranchName = diffs.branchName ? diffs.branchName.split("/").map((segment) => encodeURIComponent(segment)).join("/") : null
  const syncAction: "fetch" | "pull" | "publish" = isPublishableBranch ? "publish" : behindCount > 0 ? "pull" : "fetch"
  const compareUrl = diffs.originRepoSlug && encodedBranchName ? `https://github.com/${diffs.originRepoSlug}/compare/${encodedBranchName}?expand=1` : null
  const canOpenPullRequest = Boolean(isPublishedBranch && compareUrl && diffs.branchName && diffs.branchName !== diffs.defaultBranchName)
  const canGenerate = diffs.status === "ready" && selectedCount > 0 && !isBusy
  const canCommit = diffs.status === "ready" && selectedCount > 0 && hasSummary && !isBusy
  const primaryCommitMode: DiffCommitMode = hasRemoteOrigin ? "commit_and_push" : "commit_only"
  const hasIncoming = isPublishedBranch && behindCount > 0
  return {
    hasChanges,
    filesInOrder,
    selectedPaths,
    selectedCount,
    allSelected,
    someSelected,
    trimmedSummary,
    hasSummary,
    isCommitting,
    isBusy,
    branchHistory,
    behindCount,
    aheadCount,
    isPublishedBranch,
    hasRemoteOrigin,
    syncAction,
    compareUrl,
    canOpenPullRequest,
    canGenerate,
    canCommit,
    primaryCommitMode,
    hasIncoming,
  }
}

export type GitFacts = ReturnType<typeof gitFacts>

/** The files a Changes search shows, and the page of them on screen. */
export function visibleFiles(context: Pick<ColumnContext, "model">, facts: GitFacts) {
  const git = context.model.git
  const matchingFiles = filterFilesByQuery(facts.filesInOrder, git.fileQuery)
  const searching = git.fileQuery.trim().length > 0
  const pageSize = searching ? Math.max(git.visibleFileCount, VISIBLE_DIFF_FILE_INCREMENT) : git.visibleFileCount
  const shown = pageSize < matchingFiles.length ? matchingFiles.slice(0, pageSize) : matchingFiles
  return { matchingFiles, searching, shown, hiddenCount: matchingFiles.length - shown.length }
}

// THE BRANCH HEADER'S SYNC CONTROLS

const SYNC_BUTTON_CLASS = "h-6 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground hover:!bg-transparent hover:!border-border/0"

function remoteSyncActions(context: ColumnContext, facts: GitFacts, h: H): ReadonlyArray<Child> {
  const { model, diffs } = context
  const isSyncing = model.git.isSyncing
  const spinner = () => LoaderCircle({ class: "size-3.5 animate-spin" }, h)
  if (!facts.hasRemoteOrigin) {
    return [h.button([
      h.Class(buttonClass({ variant: "ghost", size: "sm", class: SYNC_BUTTON_CLASS })),
      h.OnClick(Message.ClickedPushToGitHub()),
    ], [Github({ class: "size-3.5" }, h), h.span([], ["Push to GitHub"])])]
  }
  if (facts.syncAction === "publish") {
    return [h.button([
      h.Class(buttonClass({ variant: "ghost", size: "sm", class: SYNC_BUTTON_CLASS })),
      h.OnClick(Message.ClickedSync({ action: "publish" })),
      ...(isSyncing ? [h.Disabled(true)] : []),
    ], [isSyncing ? spinner() : Upload({ class: "size-3.5" }, h), h.span([], ["Publish"])])]
  }
  const behind = facts.behindCount
  const ahead = facts.aheadCount
  return [
    facts.syncAction === "fetch"
      ? tooltip(model, "fetch", {
        content: () => [formatFetchTooltip(diffs.lastFetchedAt)],
        toView: ({ trigger, portal }) => h.button([
          h.Class(buttonClass({ variant: "ghost", size: "sm", class: SYNC_BUTTON_CLASS })),
          h.AriaLabel("Fetch"),
          ...(isSyncing ? [h.Disabled(true)] : []),
          ...trigger,
          h.OnClick(Message.ClickedSync({ action: "fetch" })),
        ], [isSyncing ? spinner() : RefreshCw({ class: "size-3.5" }, h), portal]),
      }, h)
      // Counts, not words: at the column's width the branch name is what matters.
      : tooltip(model, "pull", {
        content: () => ["Pull ", String(behind), " ", behind === 1 ? "commit" : "commits"],
        toView: ({ trigger, portal }) => h.button([
          h.Class(buttonClass({ variant: "ghost", size: "sm", class: SYNC_BUTTON_CLASS })),
          h.AriaLabel(`Pull ${behind}`),
          ...(isSyncing ? [h.Disabled(true)] : []),
          ...trigger,
          h.OnClick(Message.ClickedSync({ action: "pull" })),
        ], [isSyncing ? spinner() : ArrowDown({ class: "size-3.5" }, h), h.span([h.Class("tabular-nums")], [String(behind)]), portal]),
      }, h),
    facts.isPublishedBranch && ahead > 0
      ? tooltip(model, "push", {
        content: () => ["Push ", String(ahead), " ", ahead === 1 ? "commit" : "commits"],
        toView: ({ trigger, portal }) => h.button([
          h.Class(buttonClass({ variant: "default", size: "sm", class: "h-6 gap-1 px-1.5 text-xs" })),
          h.AriaLabel(`Push ${ahead}`),
          ...(isSyncing ? [h.Disabled(true)] : []),
          ...trigger,
          h.OnClick(Message.ClickedSync({ action: "push" })),
        ], [isSyncing ? spinner() : ArrowUp({ class: "size-3.5" }, h), h.span([h.Class("tabular-nums")], [String(ahead)]), portal]),
      }, h)
      : null,
  ]
}

// THE PICKER'S FOOTER

function branchActions(context: ColumnContext, facts: GitFacts, h: H): Html | null {
  const { diffs, model } = context
  if (!(diffs.status === "ready" && (diffs.branchName || facts.canOpenPullRequest))) return null
  return widgetFooter({}, [
    diffs.branchName
      ? h.button([
        h.Class(buttonClass({ variant: "outline", class: WIDGET_FOOTER_BUTTON_CLASS })),
        h.Type("button"),
        h.OnClick(Message.ClickedMergeInto()),
      ], [
        h.span([h.Class("flex min-w-0 items-center gap-1.5")], [
          GitMerge({ class: "size-3 shrink-0", strokeWidth: 2.5 }, h),
          // The ellipsis says it opens a dialog, not a merge.
          h.span([h.Class("min-w-0 truncate text-left")], [
            "Merge into ",
            GitBranch({ class: "mr-[4.5px] ml-0.5 inline size-3", strokeWidth: 2.5 }, h),
            diffs.branchName,
            "…",
          ]),
        ]),
      ])
      : null,
    facts.canOpenPullRequest && facts.compareUrl
      ? tooltip(model, "open-pr", {
        content: () => ["Open pull request"],
        toView: ({ trigger, portal }) => h.button([
          h.Class(buttonClass({ variant: "outline", class: WIDGET_FOOTER_ICON_BUTTON_CLASS })),
          h.Type("button"),
          h.AriaLabel("Open pull request"),
          ...trigger,
          h.OnClick(Message.ClickedOpenUrl({ url: facts.compareUrl! })),
        ], [GitPullRequest({ class: "size-3.5", strokeWidth: 2.5 }, h), portal]),
      }, h)
      : null,
  ], h)
}

// THE COMMIT BOX

const commitShortcut = (key: string, modifiers: { metaKey: boolean; ctrlKey: boolean }) =>
  (modifiers.metaKey || modifiers.ctrlKey) && key === "Enter" ? Option.some(Message.PressedCommitShortcut()) : Option.none()

function commitFields(context: ColumnContext, facts: GitFacts, h: H): Html {
  const { model } = context
  const git = model.git
  return h.div([], [
    h.div([h.Class("flex h-10 min-w-0 items-stretch border-b border-border")], [
      input({
        value: context.summary,
        placeholder: "Commit message",
        class: "h-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-3 py-0",
        disabled: facts.isBusy,
        onInput: (value) => Message.ChangedCommitSummary({ value }),
        attributes: [h.Id("widgets-commit-message"), h.OnKeyDownPreventDefault(commitShortcut)],
      }, h),
      tooltip(model, "generate", {
        content: () => ["Generate commit message"],
        toView: ({ trigger, portal }) => h.button([
          h.Type("button"),
          h.AriaLabel("Generate commit message"),
          h.Class("flex h-full w-10 shrink-0 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"),
          ...(!facts.canGenerate ? [h.Disabled(true)] : []),
          ...trigger,
          h.OnClick(Message.ClickedGenerateMessage()),
        ], [
          git.isGenerating
            ? LoaderCircle({ class: "size-3.5 animate-spin", strokeWidth: 2.5 }, h)
            : Sparkles({ class: "size-3.5", strokeWidth: 2.5 }, h),
          portal,
        ]),
      }, h),
    ]),
    textarea({
      value: context.description,
      placeholder: "Description",
      rows: 3,
      class: "resize-none rounded-none border-0 bg-transparent px-3 py-2.5 outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0",
      disabled: facts.isBusy,
      onInput: (value) => Message.ChangedCommitDescription({ value }),
      attributes: [h.OnKeyDownPreventDefault(commitShortcut)],
    }, h),
  ])
}

/** The commit message fields: open from the first look when a draft was there. */
export function commitEditorOpen(context: ColumnContext) {
  const stored = context.model.git.commitEditorOpen
  if (stored !== null) return stored
  return context.summary.trim().length > 0 || context.description.trim().length > 0
}

function commitBox(context: ColumnContext, facts: GitFacts, h: H): Html | null {
  const { diffs, model } = context
  if (!(facts.hasChanges && diffs.status === "ready")) return null
  const git = model.git
  const editorOpen = commitEditorOpen(context)
  const commitButtonState = facts.hasSummary
    ? (facts.isCommitting ? `committing:${git.commitModeInFlight}:${git.isGeneratedCommitInFlight}` : "commit")
    : (git.isGenerating ? "generating" : "generate")
  const prefix = getPrimaryCommitActionPrefix({
    hasSummary: facts.hasSummary,
    isGenerating: git.isGenerating,
    isCommitting: facts.isCommitting,
    isGeneratedCommitInFlight: git.isGeneratedCommitInFlight,
    commitModeInFlight: git.commitModeInFlight,
    primaryCommitMode: facts.primaryCommitMode,
  })
  const resolvedBranchName = diffs.branchName ?? "current branch"
  const glyph = facts.hasSummary
    ? facts.isCommitting
      ? LoaderCircle({ class: "size-3 shrink-0 animate-spin", strokeWidth: 2.5 }, h)
      : facts.primaryCommitMode === "commit_and_push"
        ? diffs.hasUpstream ? Upload({ class: "size-3 shrink-0", strokeWidth: 2.5 }, h) : GitBranchPlus({ class: "size-3 shrink-0", strokeWidth: 2.5 }, h)
        : Check({ class: "size-3 shrink-0", strokeWidth: 2.5 }, h)
    : git.isGenerating
      ? LoaderCircle({ class: "size-3 shrink-0 animate-spin", strokeWidth: 2.5 }, h)
      : PenLine({ class: "size-3 shrink-0", strokeWidth: 2.5 }, h)
  const disabled = facts.hasSummary ? !facts.canCommit : !facts.canGenerate
  const commitOnlyDisabled = !facts.hasSummary || !facts.canCommit

  const commitButton = h.submodel({
    slotId: "widgets-commit-menu",
    model: model.commitMenu,
    view: ContextMenu.view,
    viewInputs: {
      // Only on a branch with an upstream is there a choice to make.
      items: diffs.hasUpstream ? [ContextMenu.item({ value: "commit-only", disabled: commitOnlyDisabled })] : [],
      renderItem: () => ["Commit Only"],
      toView: ({ trigger, portal }) => h.button([
        ...trigger,
        h.Type("button"),
        ...(disabled ? [h.Disabled(true)] : []),
        h.OnClick(Message.ClickedCommit()),
        h.Class("flex h-full min-w-0 flex-1 items-center justify-center px-4 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:text-foreground/50"),
      ], [
        // Cross-fades per state: the label changes width and wording while you watch it.
        swapIn({ swapKey: commitButtonState, class: "min-w-0 gap-1.5", toParts }, [
          glyph,
          h.span([h.Class("min-w-0 truncate text-left")], git.isGenerating || facts.isCommitting
            ? [prefix]
            : [prefix, " ", GitBranch({ class: "mr-[4.5px] ml-0.5 inline size-3 ", strokeWidth: 2.5 }, h), resolvedBranchName]),
        ], h),
        portal,
      ]),
    },
    toParentMessage: (message) => Message.GotCommitMenuMessage({ message }),
  })

  const label = editorOpen ? "Hide commit message" : "Write commit message"
  return widgetFooter({ above: editorOpen ? commitFields(context, facts, h) : null }, [
    // A split button: the commit taking the width and the pencil an accessory at its end.
    h.div([h.Class("flex h-full min-w-0 flex-1 items-stretch")], [
      commitButton,
      tooltip(model, "pencil", {
        content: () => [label],
        toView: ({ trigger, portal }) => h.button([
          h.Type("button"),
          h.AriaLabel(label),
          h.AriaPressed(editorOpen ? "true" : "false"),
          ...trigger,
          h.OnClick(Message.ToggledCommitEditor()),
          h.Class(cn(
            "flex h-full w-10 shrink-0 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            editorOpen && "bg-muted text-foreground",
          )),
        ], [Pencil({ class: "size-3.5", strokeWidth: 2.5 }, h), portal]),
      }, h),
    ]),
  ], h)
}

// THE BRANCH'S PULL REQUEST

function branchPullRequestBlock(context: ColumnContext, h: H): Html | null {
  const { diffs, model } = context
  if (!(diffs.branchName && diffs.branchPullRequest)) return null
  const pr = diffs.branchPullRequest
  const entry = branchPullRequestEntry(diffs.branchName, pr)
  const details = model.branchDetails[branchDetailsKey(entry)]?.pullRequest
  // A draft says so before the read lands; anything else waits for it.
  const state = details
    ? pullRequestStateIcon(details, h)
    : pr.isDraft
      ? { icon: GitPullRequestDraft({ class: "text-muted-foreground" }, h), label: "Draft" }
      : pullRequestStateIcon(undefined, h)
  const list = HOVER_LISTS.branchPullRequest
  const hovered = model.hovered[list] === entry.id
  return h.div([h.Class("border-t border-border")], [
    widgetList({ attributes: listHoverAttributes(list, toHover, h) }, [
      widgetRow({
        key: entry.id,
        icon: labelledIcon(state, h),
        title: pr.title,
        subtitle: `#${pr.number}${pr.isDraft ? " · Draft" : ""}`,
        ...(details?.checks ? { subMeta: checksIcon(details.checks, { onOpen: (url) => Message.ClickedOpenUrl({ url }), stopped }, h) } : {}),
        rowKey: entry.id,
        onActivate: Message.ClickedOpenUrl({ url: pr.url }),
        ariaLabel: `Open pull request #${pr.number} on GitHub`,
        attributes: [h.OnMount(RequestBranchDetails({ entry }))],
      }, h),
    ], h),
    hovered ? branchHoverCard(context, list, entry, h) : null,
  ])
}

export function branchHoverCard(context: ColumnContext, list: string, entry: ChatBranchListEntry, h: H): Html {
  const { model, diffs } = context
  const details = model.branchDetails[branchDetailsKey(entry)] ?? null
  const content = entry.kind === "pull_request"
    ? pullRequestCardContent({
      list,
      entry,
      pr: details?.pullRequest,
      url: details?.pullRequest?.url ?? (diffs.originRepoSlug && entry.prNumber ? `https://github.com/${diffs.originRepoSlug}/pull/${entry.prNumber}` : undefined),
      now: context.now,
    }, h)
    : branchCardContent(entry, details, h)
  return listHoverCard({ list, rowKey: entry.id, toMessage: toHover }, content, h)
}

// COMMITS

function commitHistoryRow(context: ColumnContext, entry: ChatBranchHistoryEntry, isPendingPush: boolean, className: string | undefined, h: H): Html {
  const relativeTime = formatRelativeTime(entry.authoredAt)
  return widgetRow({
    key: entry.sha,
    icon: isPendingPush
      ? h.span([h.Title("Not pushed yet"), h.AriaLabel("Not pushed yet"), h.Class("flex")], [ArrowUp({ class: "text-foreground" }, h)])
      : GitCommitHorizontal({}, h),
    title: entry.summary,
    subtitle: entry.authorName || entry.tags.length > 0
      ? [h.span([h.Class("flex min-w-0 items-center gap-1")], [
        entry.authorName ? h.span([h.Class("truncate")], [entry.authorName]) : null,
        ...entry.tags.map((tag) => h.keyed("span")(tag, [h.Class(CARD_PILL_CLASS)], [tag])),
      ])]
      : null,
    meta: relativeTime || null,
    ...(entry.checks ? { subMeta: checksIcon(entry.checks, { onOpen: (url) => Message.ClickedOpenUrl({ url }), stopped }, h) } : {}),
    rowKey: entry.sha,
    ...(className ? { class: className } : {}),
    ...(entry.githubUrl ? { onActivate: Message.ClickedOpenUrl({ url: entry.githubUrl }), ariaLabel: `Open commit ${entry.sha.slice(0, 7)} on GitHub` } : {}),
  }, h)
}

function commitList(context: ColumnContext, facts: GitFacts, h: H): ReadonlyArray<Child> {
  const { model } = context
  const git = model.git
  const visible = visibleHistoryEntries(facts.branchHistory, git.showAllHistory)
  const behind = facts.behindCount
  const list = HOVER_LISTS.history
  const hoveredSha = model.hovered[list]
  const hoveredEntry = hoveredSha ? visible.shown.find((entry) => entry.sha === hoveredSha) : undefined
  return [
    widgetList({ attributes: listHoverAttributes(list, toHover, h) }, [
      facts.hasIncoming
        ? widgetRow({
          key: "incoming",
          icon: git.isSyncing ? LoaderCircle({ class: "animate-spin" }, h) : ArrowDown({ class: "text-foreground" }, h),
          title: `${behind} incoming ${behind === 1 ? "commit" : "commits"}`,
          subtitle: "On the remote, not here yet",
          disabled: git.isSyncing,
          onActivate: Message.ClickedPullIncoming(),
          ariaLabel: `Pull ${behind} ${behind === 1 ? "commit" : "commits"}`,
        }, h)
        : null,
      ...visible.shown.map((entry, index) => commitHistoryRow(context, entry, index < facts.aheadCount, index >= INITIAL_VISIBLE_HISTORY_COUNT ? WIDGET_ROW_REVEAL_CLASS : undefined, h)),
      facts.branchHistory.length > INITIAL_VISIBLE_HISTORY_COUNT
        ? widgetMoreRow({
          count: visible.hiddenCount,
          shown: git.showAllHistory,
          onClick: Message.ClickedShowAllHistory({ shown: !git.showAllHistory }),
          toParts,
        }, h)
        : null,
    ], h),
    hoveredEntry
      ? listHoverCard({ list, rowKey: hoveredEntry.sha, toMessage: toHover }, commitCardContent({
        list,
        entry: hoveredEntry,
        details: model.commitDetails[commitDetailsKey(hoveredEntry)] ?? null,
        copied: model.copiedSha === hoveredEntry.sha,
        now: context.now,
      }, h), h)
      : null,
  ]
}

// CHANGES

function diffFileRow(context: ColumnContext, file: DiffFile, className: string | undefined, h: H): Html {
  const { model } = context
  const status = diffStatus(file)
  const { name, folder } = splitDiffPath(file.path)
  const isChecked = isDiffPathChecked(context.selection, file.path)
  return widgetRow({
    key: file.path,
    icon: stageCheckbox({ checked: isChecked, class: "size-4", onClick: Message.ToggledFile({ path: file.path }), stopped }, h),
    title: [h.span([h.Class("flex min-w-0 items-baseline gap-1.5")], [
      h.span([h.Class("min-w-0 max-w-[75%] shrink-0 truncate")], [name]),
      // RTL so the ellipsis eats the folder's start; the <bdi> keeps the path left to right.
      folder ? h.span([h.Class("min-w-0 flex-1 truncate text-xs text-muted-foreground [direction:rtl] text-left")], [h.bdi([], [folder])]) : null,
    ])],
    rowKey: file.path,
    meta: [diffFileStat({ additions: file.additions, deletions: file.deletions }, h)],
    active: context.reviewedPath === file.path,
    ...(className ? { class: className } : {}),
    onActivate: Message.ClickedReviewFile({ path: file.path }),
    // The status sits in the kebab's slot at rest and gives way to it on hover.
    menuIdle: h.span([h.Class(cn("font-mono text-[11px] font-semibold leading-none", status.className)), h.Title(status.label)], [status.letter]),
    menu: rowMenu(model, { _tag: "DiffFile", path: file.path }, `Actions for ${file.path}`, h),
  }, h)
}

function fileList(context: ColumnContext, facts: GitFacts, h: H): ReadonlyArray<Child> {
  const { model, diffs } = context
  const git = model.git
  const { matchingFiles, searching, shown, hiddenCount } = visibleFiles(context, facts)
  const changesSummary = summarizeChanges(diffs.files, new Set(facts.selectedPaths))
  const firstCheckedPath = facts.filesInOrder.find((file) => isDiffPathChecked(context.selection, file.path))?.path ?? null
  const reviewLabel = facts.allSelected ? "Review all" : facts.someSelected ? `Review ${facts.selectedCount}` : "Review"
  const filesMore = hiddenCount > 0
    ? widgetMoreRow({
      count: Math.min(VISIBLE_DIFF_FILE_INCREMENT, hiddenCount),
      ...(hiddenCount > VISIBLE_DIFF_FILE_INCREMENT ? { detail: `${hiddenCount.toLocaleString()} left` } : {}),
      onClick: Message.ClickedShowMoreFiles(),
      toParts,
    }, h)
    : !searching && diffs.files.length > INITIAL_VISIBLE_DIFF_FILE_COUNT
      ? widgetMoreRow({ count: 0, shown: true, onClick: Message.ClickedShowFewerFiles(), toParts }, h)
      : null
  const allSelected = facts.allSelected
  const list = HOVER_LISTS.changes
  const hoveredPath = model.hovered[list]
  const hoveredFile = hoveredPath ? shown.find((file) => file.path === hoveredPath) : undefined
  const count = diffs.files.length

  return [
    widgetStrip({
      field: true,
      // Everything checked is the resting state, so the strip shows a search;
      // the check swaps in on hover or keyboard focus.
      leading: h.span([h.Class("group/lead relative flex size-4 items-center justify-center")], [
        allSelected
          ? Search({
            class: "size-3.5 transition-[opacity,scale,filter] duration-150 ease-snappy group-hover/lead:scale-75 group-hover/lead:opacity-0 group-hover/lead:blur-[1px] group-focus-within/lead:scale-75 group-focus-within/lead:opacity-0 group-focus-within/lead:blur-[1px] [@media(hover:none)]:hidden",
            attributes: [h.AriaHidden(true)],
          }, h)
          : null,
        h.span([h.Class(cn(
          "flex items-center justify-center",
          allSelected && "absolute inset-0 scale-75 opacity-0 blur-[1px] transition-[opacity,scale,filter] duration-150 ease-snappy group-hover/lead:scale-100 group-hover/lead:opacity-100 group-hover/lead:blur-none group-focus-within/lead:scale-100 group-focus-within/lead:opacity-100 group-focus-within/lead:blur-none [@media(hover:none)]:scale-100 [@media(hover:none)]:opacity-100 [@media(hover:none)]:blur-none",
        ))], [
          stageCheckbox({
            checked: allSelected,
            mixed: facts.someSelected,
            label: allSelected ? "Unselect all files from commit" : "Select all files for commit",
            class: "size-4",
            onClick: Message.ToggledAllFiles(),
            stopped,
          }, h),
        ]),
      ]),
      trailing: [
        h.span([h.Title(changesSummary.title), h.Class("flex")], [diffFileStat({ additions: changesSummary.additions, deletions: changesSummary.deletions }, h)]),
        tooltip(model, "review", {
          content: () => [reviewLabel],
          toView: ({ trigger, portal }) => h.button([
            h.Class(buttonClass({ variant: "ghost", size: "none", class: "flex h-6 w-6 shrink-0 items-center justify-center p-0 text-muted-foreground hover:text-foreground hover:!bg-transparent hover:!border-border/0" })),
            ...(!firstCheckedPath ? [h.Disabled(true)] : []),
            h.AriaLabel(reviewLabel),
            ...trigger,
            h.OnClick(Message.ClickedReviewChecked()),
          ], [Eye({ class: "size-3.5" }, h), portal]),
        }, h),
      ],
    }, [
      h.input([
        h.Value(git.fileQuery),
        h.OnInput((value) => Message.ChangedFileQuery({ value })),
        h.OnKeyDownPreventDefault((key) => (key === "Escape" && git.fileQuery ? Option.some(Message.ClearedFileQuery()) : Option.none())),
        h.Placeholder(`Search ${count.toLocaleString()} ${count === 1 ? "change" : "changes"}`),
        h.AriaLabel("Search changes"),
        h.Type("search"),
        h.Autocomplete("off"),
        h.Spellcheck(false),
        h.DataAttribute("1p-ignore", "true"),
        h.Class(cn(WIDGET_STRIP_INPUT_CLASS, "[&::-webkit-search-cancel-button]:hidden")),
      ]),
    ], h),
    widgetList({ attributes: listHoverAttributes(list, toHover, h) }, [
      ...shown.map((file, index) => diffFileRow(context, file, !searching && index >= INITIAL_VISIBLE_DIFF_FILE_COUNT ? WIDGET_ROW_REVEAL_CLASS : undefined, h)),
      searching && matchingFiles.length === 0
        ? h.keyed("div")("no-match", [h.Class("truncate px-2 py-1.5 text-xs text-muted-foreground")], ["No files match “", git.fileQuery.trim(), "”"])
        : null,
      filesMore,
    ], h),
    hoveredFile ? diffFileHoverCard(context, list, hoveredFile, h) : null,
  ]
}

function diffFileHoverCard(context: ColumnContext, list: string, file: DiffFile, h: H): Html {
  const preview = getDiffPreviewAttachment(context.projectId, file)
  const imageUrl = preview?.kind === "image" ? preview.contentUrl : undefined
  const hold = preview ? null : diffHold(file)
  const patch = preview || hold ? null : context.model.patches[patchKey(file)] ?? null
  return listHoverCard({ list, rowKey: file.path, toMessage: toHover }, diffFileCardContent({
    file,
    patch,
    ...(imageUrl ? { previewUrl: imageUrl } : {}),
    ...(hold ? { note: hold.message } : {}),
  }, h), h)
}

// THE CARDS

export function gitWidgetsView(context: ColumnContext, h: H): ReadonlyArray<Html> {
  const { diffs, model } = context
  const git = model.git
  const facts = gitFacts(context)
  const prBlock = branchPullRequestBlock(context, h)
  const box = commitBox(context, facts, h)
  return [
    widgetPresence({ toParts, key: "git-init", show: diffs.status === "no_repo" }, [
      widgetCard({
        icon: GitBranch({}, h),
        title: ["Git"],
        footer: widgetFooter({}, [
          h.button([
            h.Class(buttonClass({ variant: "outline", class: WIDGET_FOOTER_BUTTON_CLASS })),
            h.Type("button"),
            h.OnClick(Message.ClickedInitGit()),
          ], ["Init Git"]),
        ], h),
        body: [widgetStatic({}, [h.p([h.Class("text-sm text-muted-foreground")], ["Not a git repository."])], h)],
      }, h),
    ], h),
    widgetPresence({ toParts, key: "git-branch", show: diffs.status === "ready" }, [
      widgetCard({
        icon: GitBranch({}, h),
        title: [h.span([h.Class("flex min-w-0 items-baseline gap-1.5")], [
          h.span([h.Class("shrink-0")], ["Branch"]),
          h.span([h.Class("min-w-0 truncate text-muted-foreground")], [diffs.branchName ?? "Detached HEAD"]),
        ])],
        expanded: git.branchesExpanded,
        onToggle: Message.ToggledBranches(),
        actions: remoteSyncActions(context, facts, h),
        footer: git.branchesExpanded ? branchActions(context, facts, h) : null,
        bodyDivider: false,
        collapsedBody: [
          widgetPresence({ toParts, key: "branch-pr", show: prBlock !== null, spaced: false }, [prBlock], h),
          // A clean tree folds the changes away, commit box and all.
          widgetPresence({ toParts, key: "branch-changes", show: facts.hasChanges, spaced: false }, [
            h.div([h.Class("border-t border-border")], [
              ...fileList(context, facts, h),
              box ? h.div([h.Class("border-t border-border")], [box]) : null,
            ]),
          ], h),
        ],
        body: [h.div([h.Class("border-t border-border")], pickerView(context, h))],
      }, h),
    ], h),
    widgetPresence({ toParts, key: "git-commits", show: diffs.status === "ready" && (facts.branchHistory.length > 0 || facts.hasIncoming) }, [
      widgetCard({
        icon: History({}, h),
        title: ["Commits"],
        // Not the length: what is worth a glance is what hasn't reached the remote yet.
        count: facts.isPublishedBranch && facts.aheadCount > 0 ? `${facts.aheadCount} unpushed` : null,
        expanded: context.expanded("history", facts.branchHistory.length, true),
        onToggle: Message.ToggledHistory(),
        body: commitList(context, facts, h),
      }, h),
    ], h),
    mergeDialogView(context, h),
    publishDialogView(context, h),
  ]
}

/** Is the open row menu on a changed file that is still listed. */
export function diffMenuFile(context: ColumnContext): DiffFile | null {
  const target = context.model.menuTarget
  if (target?._tag !== "DiffFile") return null
  return context.diffs.files.find((file) => sameTarget(target, { _tag: "DiffFile", path: file.path })) ?? null
}
