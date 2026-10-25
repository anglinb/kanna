import type { Attribute, Html } from "foldkit/html"
import { formatCompactAge } from "../../client/lib/formatters"
import { cn } from "../../client/lib/utils"
import type {
  ChatBranchDetails,
  ChatBranchHistoryEntry,
  ChatBranchListEntry,
  ChatCheckRun,
  ChatCheckRunState,
  ChatCommitChecks,
  ChatCommitDetails,
  ChatPullRequestDetails,
} from "../../shared/types"
import { formatDuration, formatPromptTimestamp } from "../transcript/messages/simple"
import type { Child } from "../ui/attributes"
import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleSlash,
  Copy,
  FileDiff,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Laptop,
  MessageSquare,
  Minus,
  Unlink,
  X,
} from "../ui/icons"
import { TURN_CARD_ROW_INSET, turnCardMessage, turnCardMetaRow, turnCardMetaSeparator } from "../ui/turn-card"
import type { H } from "./context"
import {
  CARD_PILL_CLASS,
  checksWallClock,
  countCheckRuns,
  diffStatus,
  peekPatch,
  previewPullRequestBody,
  rollupFromRuns,
  sortCheckRuns,
  VISIBLE_CHECK_RUN_COUNT,
  type DiffFile,
} from "./gitLogic"
import { cardPerson, diffFileStat } from "./gitParts"
import { Message } from "./message"

// The git hover cards' contents: CommitHoverCard.tsx, BranchHoverCard.tsx,
// DiffFileHoverCard.tsx and CheckRunsSection.tsx. Each card's list and
// details are the host's (git.ts); these draw what a card says.

// CHECK RUNS

function checkRunGlyph(state: ChatCheckRunState, h: H): Html {
  return h.span([h.Class("flex size-2.5 shrink-0 items-center justify-center"), h.AriaHidden(true)], [
    state === "success"
      ? Check({ class: "size-2.5 text-success", strokeWidth: 2.5 }, h)
      : state === "failure"
        ? X({ class: "size-2.5 text-destructive", strokeWidth: 2.5 }, h)
        : state === "pending"
          ? h.span([h.Class("size-1.5 rounded-full bg-amber-500")], [])
          : state === "skipped"
            ? CircleSlash({ class: "size-2.5 opacity-60", strokeWidth: 2.5 }, h)
            : Minus({ class: "size-2.5 opacity-60", strokeWidth: 2.5 }, h),
  ])
}

/** The right edge of a row: how long a finished job took, or what an unfinished one is doing. */
export function describeCheckRunTiming(run: ChatCheckRun): string | null {
  if (run.state === "skipped") return "skipped"
  if (run.state === "pending") return run.startedAt ? "running" : "pending"
  if (!run.startedAt || !run.completedAt) return null
  const elapsed = Date.parse(run.completedAt) - Date.parse(run.startedAt)
  return Number.isFinite(elapsed) && elapsed >= 1_000 ? formatDuration(elapsed) : null
}

const RING_SEGMENTS: ReadonlyArray<{ state: ChatCheckRunState; className: string }> = [
  { state: "success", className: "stroke-success" },
  { state: "failure", className: "stroke-destructive" },
  { state: "pending", className: "stroke-amber-500" },
  { state: "neutral", className: "stroke-muted-foreground/50" },
  { state: "skipped", className: "stroke-muted-foreground/30" },
]

const RING_RADIUS = 4.5
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

function checksRing(counts: Record<ChatCheckRunState, number>, total: number, h: H): Html {
  let offset = 0
  const circle = (attributes: ReadonlyArray<Attribute<Message>>) => h.circle([h.Attribute("cx", "6"), h.Attribute("cy", "6"), h.Attribute("r", String(RING_RADIUS)), h.Attribute("fill", "none"), h.Attribute("stroke-width", "2"), ...attributes])
  return h.svg([h.Attribute("viewBox", "0 0 12 12"), h.Class("size-3 shrink-0 -rotate-90"), h.AriaHidden(true)], [
    circle([h.Class("stroke-muted")]),
    ...RING_SEGMENTS.map(({ state, className }) => {
      if (counts[state] === 0 || total === 0) return null
      const length = (counts[state] / total) * RING_CIRCUMFERENCE
      const dashOffset = -offset
      offset += length
      return circle([
        h.Attribute("stroke-dasharray", `${length} ${RING_CIRCUMFERENCE - length}`),
        h.Attribute("stroke-dashoffset", String(dashOffset)),
        h.Class(className),
      ])
    }),
  ])
}

function checksHeader(rollup: ChatCommitChecks, runs: readonly ChatCheckRun[], now: number, h: H): Html {
  const counts = countCheckRuns(runs)
  const wallClock = checksWallClock(runs, now)
  const tallies = [
    counts.failure ? h.span([h.Class("text-destructive")], [String(counts.failure), " failed"]) : null,
    counts.pending ? h.span([h.Class("text-amber-500")], [String(counts.pending), " running"]) : null,
    counts.skipped ? h.span([], [String(counts.skipped), " skipped"]) : null,
  ].filter((tally) => tally !== null)
  return h.div([h.Class(cn("mt-1.5 mb-1 flex items-center gap-1.5 text-[12px] tracking-wide text-muted-foreground", TURN_CARD_ROW_INSET))], [
    checksRing(counts, runs.length, h),
    h.span([h.Class("min-w-0 truncate tabular-nums")], [
      h.span([h.Class("font-medium text-popover-foreground")], [String(rollup.passed), "/", String(rollup.total)]),
      " passed",
      ...tallies.map((tally) => h.span([], [", ", tally])),
    ]),
    wallClock
      ? h.span([
        h.Class("ml-auto shrink-0 pl-2 tabular-nums"),
        h.Title(wallClock.running ? "Since the first job started" : "First job's start to last job's end"),
      ], [formatDuration(Math.floor(wallClock.ms / 1_000) * 1_000)])
      : null,
  ])
}

/** A hover card's CI section: the rollup, then each check, failing ones first. */
export function checkRunsSection(options: { runs: readonly ChatCheckRun[]; checks?: ChatCommitChecks; onOpen?: (url: string) => Message; now: number }, h: H): ReadonlyArray<Child> {
  const { runs, onOpen } = options
  if (runs.length === 0) return []
  const rollup = options.checks ?? rollupFromRuns(runs)
  const shown = sortCheckRuns(runs).slice(0, VISIBLE_CHECK_RUN_COUNT)
  const hiddenCount = Math.max(rollup.total, runs.length) - shown.length
  return [
    h.div([h.Class("-mx-1.5 mt-2 border-t border-border/60"), h.AriaHidden(true)], []),
    checksHeader(rollup, runs, options.now, h),
    ...shown.map((run, index) => {
      const timing = describeCheckRunTiming(run)
      const open = onOpen && run.url ? onOpen(run.url) : undefined
      return h.keyed("button")(`${run.workflowName ?? ""}\u0000${run.name}\u0000${index}`, [
        h.Type("button"),
        h.AriaLabel(`${run.workflowName ? `${run.workflowName} / ` : ""}${run.name}: ${run.state}`),
        ...(run.description !== undefined ? [h.Title(run.description)] : []),
        ...(open !== undefined ? [h.OnClick(open)] : [h.Disabled(true)]),
        h.Class(cn(
          "flex w-full items-center gap-1.5 rounded text-left text-[12px] text-muted-foreground",
          TURN_CARD_ROW_INSET,
          open !== undefined
            ? "cursor-pointer transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            : "cursor-default",
          (run.state === "skipped" || run.state === "neutral") && "opacity-70",
        )),
      ], [
        checkRunGlyph(run.state, h),
        h.span([h.Class("min-w-0 flex-1 truncate")], [
          run.workflowName ? h.span([h.Class("text-muted-foreground/70")], [`${run.workflowName} / `]) : null,
          h.span(run.state === "failure" ? [h.Class("text-foreground")] : [], [run.name]),
        ]),
        timing ? h.span([h.Class("shrink-0 pl-2 tabular-nums")], [timing]) : null,
      ])
    }),
    hiddenCount > 0
      ? h.button([
        h.Type("button"),
        ...(onOpen && rollup.url ? [h.OnClick(onOpen(rollup.url))] : [h.Disabled(true)]),
        h.Class(cn(
          "w-full rounded text-left text-[12px] text-muted-foreground/70",
          TURN_CARD_ROW_INSET,
          onOpen && rollup.url ? "cursor-pointer transition-colors hover:bg-muted/60 hover:text-foreground" : "cursor-default",
        )),
      ], [String(hiddenCount), " more check", hiddenCount === 1 ? "" : "s"])
      : null,
  ]
}

// COMMIT

/**
 * A commit's card: the full message, who and when, how big it is, and each
 * of its checks.
 */
export function commitCardContent(options: {
  list: string
  entry: ChatBranchHistoryEntry
  details: ChatCommitDetails | null
  copied: boolean
  now: number
}, h: H): ReadonlyArray<Child> {
  const { entry, details, list } = options
  const shortSha = entry.sha.slice(0, 7)
  const isMerge = (details?.parentCount ?? 0) > 1
  const openUrl = (url: string) => Message.ClickedCardUrl({ list, url })
  return [
    turnCardMetaRow({}, [
      h.button([
        h.Type("button"),
        h.AriaLabel(`Copy ${entry.sha}`),
        h.OnClick(Message.ClickedCopySha({ sha: entry.sha })),
        h.Class("flex shrink-0 cursor-pointer items-center gap-1 rounded-sm font-mono transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"),
      ], [
        isMerge ? GitMerge({ class: "size-2.5 shrink-0", strokeWidth: 2.5 }, h) : GitCommitHorizontal({ class: "size-2.5 shrink-0", strokeWidth: 2.5 }, h),
        shortSha,
        options.copied ? Check({ class: "size-2.5 shrink-0 text-success", strokeWidth: 2.5 }, h) : Copy({ class: "size-2.5 shrink-0 opacity-60", strokeWidth: 2.5 }, h),
      ]),
      ...(isMerge ? [turnCardMetaSeparator(h), h.span([h.Class("shrink-0")], ["Merge"])] : []),
      ...(details?.committerName ? [turnCardMetaSeparator(h), h.span([h.Class("truncate")], ["committed by ", details.committerName])] : []),
      h.span([h.Class("ml-auto shrink-0 pl-2"), ...(details?.authorEmail !== undefined ? [h.Title(details.authorEmail)] : [])], [formatPromptTimestamp(entry.authoredAt)]),
    ], h),
    h.div([h.Class("mt-1 space-y-1")], [
      turnCardMessage({
        class: "line-clamp-3 text-sm font-medium text-popover-foreground",
        label: "Open this commit on GitHub",
        ...(entry.githubUrl ? { onSelect: openUrl(entry.githubUrl) } : {}),
      }, [entry.summary], h),
      entry.description
        ? h.div([h.Class(cn("line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground", TURN_CARD_ROW_INSET))], [entry.description.trim()])
        : null,
    ]),
    ...(details?.checkRuns ? checkRunsSection({ runs: details.checkRuns, ...(entry.checks ? { checks: entry.checks } : {}), onOpen: openUrl, now: options.now }, h) : []),
    details && details.totalFileCount > 0
      ? turnCardMetaRow({ class: "-mx-1.5 -mb-2 mt-2 rounded-b-lg border-t border-border/60 bg-muted/40 px-3 py-1.5" }, [
        FileDiff({ class: "size-2.5 shrink-0", strokeWidth: 2.5 }, h),
        // React's text nodes, as JSX split them: shaping (the "fi") follows them.
        h.span([], [String(details.totalFileCount), " file", details.totalFileCount === 1 ? "" : "s", " changed"]),
        diffFileStat({ additions: details.additions, deletions: details.deletions, class: "ml-auto pl-2" }, h),
      ], h)
      : null,
  ]
}

// BRANCHES AND PULL REQUESTS

/** "↑3 ↓1 main", "even with main": where a branch stands against another. */
function divergence(ahead: number, behind: number, name: string, h: H): Html {
  if (ahead === 0 && behind === 0) return h.span([h.Class("truncate")], ["Even with ", name])
  return h.span([h.Class("flex min-w-0 items-center gap-1"), h.Title(`${ahead} ahead, ${behind} behind ${name}`)], [
    ahead ? h.span([h.Class("flex items-center text-foreground")], [ArrowUp({ class: "size-2.5", strokeWidth: 2.5 }, h), String(ahead)]) : null,
    behind ? h.span([h.Class("flex items-center")], [ArrowDown({ class: "size-2.5", strokeWidth: 2.5 }, h), String(behind)]) : null,
    h.span([h.Class("truncate")], [name]),
  ])
}

/** A local or remote branch: who last committed, its whole name, that commit, where it stands. */
export function branchCardContent(entry: ChatBranchListEntry, details: ChatBranchDetails | null, h: H): ReadonlyArray<Child> {
  const commit = details?.lastCommit
  const upstream = details?.upstream
  const standing = upstream || details?.localBranchName || details?.base || (entry.kind === "local" && details)
  return [
    commit?.authorName ? turnCardMetaRow({}, [cardPerson({ name: commit.authorName, title: formatPromptTimestamp(commit.authoredAt) }, h)], h) : null,
    h.div([h.Class("mt-1 space-y-1")], [
      h.div([h.Class(cn("break-all text-sm font-medium text-popover-foreground", TURN_CARD_ROW_INSET))], [entry.displayName]),
      commit ? h.div([h.Class(cn("line-clamp-2 text-sm text-muted-foreground", TURN_CARD_ROW_INSET))], [commit.summary]) : null,
    ]),
    standing
      ? turnCardMetaRow({ class: "mt-1" }, [
        upstream
          ? upstream.gone
            ? h.span([h.Class("flex items-center gap-1 text-destructive")], [Unlink({ class: "size-2.5", strokeWidth: 2.5 }, h), "Upstream deleted"])
            : h.span([h.Class("flex min-w-0 items-center gap-1")], [
              GitBranch({ class: "size-2.5 shrink-0", strokeWidth: 2.5 }, h),
              divergence(upstream.ahead, upstream.behind, upstream.name, h),
            ])
          : details?.localBranchName
            ? h.span([h.Class("flex items-center gap-1")], [Laptop({ class: "size-2.5", strokeWidth: 2.5 }, h), "Checked out locally"])
            : entry.kind === "local" ? h.span([], ["Not pushed"]) : null,
        details?.base
          ? h.span([h.Class("ml-auto flex min-w-0 items-center pl-2")], [divergence(details.base.ahead, details.base.behind, details.base.name, h)])
          : null,
      ], h)
      : null,
  ]
}

/** A pull request: where it merges and when it was opened, the whole title, its description, its size. */
export function pullRequestCardContent(options: {
  list: string
  entry: ChatBranchListEntry
  pr: ChatPullRequestDetails | undefined
  url: string | undefined
  now: number
}, h: H): ReadonlyArray<Child> {
  const { entry, pr, list } = options
  const body = pr?.body ? previewPullRequestBody(pr.body) : ""
  const hasStats = pr && (pr.changedFiles !== undefined || pr.commits !== undefined || pr.comments || pr.additions !== undefined)
  const openUrl = (url: string) => Message.ClickedCardUrl({ list, url })
  return [
    turnCardMetaRow({}, [
      GitBranch({ class: "size-2.5 shrink-0", strokeWidth: 2.5 }, h),
      h.span([h.Class("min-w-0 truncate")], [
        entry.headLabel ?? entry.headRefName ?? "",
        pr?.baseRefName ? h.span([h.Class("opacity-60")], [" → "]) : null,
        pr?.baseRefName ?? "",
      ]),
      pr?.createdAt
        ? h.span([h.Class("ml-auto shrink-0 pl-2"), h.Title(`Opened ${formatPromptTimestamp(pr.createdAt)}`)], ["opened ", formatCompactAge(pr.createdAt)])
        : null,
    ], h),
    h.div([h.Class("mt-1 space-y-1")], [
      turnCardMessage({
        class: "line-clamp-3 text-sm font-medium text-popover-foreground",
        label: "Open this pull request on GitHub",
        ...(options.url ? { onSelect: openUrl(options.url) } : {}),
      }, [pr?.title ?? entry.prTitle ?? entry.displayName], h),
      body ? h.div([h.Class(cn("line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground", TURN_CARD_ROW_INSET))], [body]) : null,
    ]),
    hasStats
      ? turnCardMetaRow({ class: "mt-1" }, [
        pr.changedFiles !== undefined
          ? h.span([h.Class("flex items-center gap-1"), h.Title(`${pr.changedFiles} files changed`)], [FileDiff({ class: "size-2.5", strokeWidth: 2.5 }, h), String(pr.changedFiles)])
          : null,
        pr.commits !== undefined
          ? h.span([h.Class("ml-1.5 flex items-center gap-1"), h.Title(`${pr.commits} commits`)], [GitCommitHorizontal({ class: "size-2.5", strokeWidth: 2.5 }, h), String(pr.commits)])
          : null,
        pr.comments
          ? h.span([h.Class("ml-1.5 flex items-center gap-1"), h.Title(`${pr.comments} comments`)], [MessageSquare({ class: "size-2.5", strokeWidth: 2.5 }, h), String(pr.comments)])
          : null,
        diffFileStat({ additions: pr.additions, deletions: pr.deletions, class: "ml-auto pl-2" }, h),
      ], h)
      : null,
    pr?.labels.length
      ? turnCardMetaRow({ class: "mt-1 flex-wrap gap-y-1" }, pr.labels.map((label) => h.keyed("span")(label, [h.Class(CARD_PILL_CLASS)], [label])), h)
      : null,
    ...(pr?.checkRuns ? checkRunsSection({ runs: pr.checkRuns, ...(pr.checks ? { checks: pr.checks } : {}), onOpen: openUrl, now: options.now }, h) : []),
  ]
}

// CHANGED FILES

/** A changed file's card: its whole path, what happened to it, and a peek at the change. */
export function diffFileCardContent(options: { file: DiffFile; patch: string | null; previewUrl?: string; note?: string }, h: H): ReadonlyArray<Child> {
  const { file, patch, previewUrl, note } = options
  const status = diffStatus(file)
  const peek = patch ? peekPatch(patch) : null
  const kind = file.size !== undefined && file.mimeType && !file.mimeType.startsWith("text/") ? file.mimeType : undefined
  return [
    file.isUntracked || kind
      ? turnCardMetaRow({}, [
        h.span([h.Class("shrink-0")], [file.isUntracked ? "Untracked" : status.label]),
        ...(kind ? [turnCardMetaSeparator(h), h.span([h.Class("truncate")], [kind])] : []),
      ], h)
      : null,
    h.div([h.Class(cn("break-all text-sm font-medium text-popover-foreground", TURN_CARD_ROW_INSET, (file.isUntracked || kind) && "mt-1"))], [file.path]),
    ...(previewUrl
      ? [h.div([h.Class("mx-1.5 mt-1.5")], [h.img([h.Src(previewUrl), h.Alt(file.path), h.Class("max-h-40 rounded-md border border-border/60 object-contain")])])]
      : peek
        ? [
          h.div([h.Class("mx-1.5 mt-1.5 overflow-hidden rounded-md border border-border/60 bg-muted/30 py-1 font-mono text-[11px] leading-4")], [
            h.div([h.Class("truncate px-2 text-muted-foreground/70")], [peek.header]),
            ...peek.lines.map((line, index) => h.keyed("div")(String(index), [
              h.Class(cn(
                "truncate whitespace-pre px-2",
                line.kind === "add" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                line.kind === "remove" && "bg-red-500/10 text-red-700 dark:text-red-300",
                line.kind === "context" && "text-muted-foreground",
              )),
            ], [line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ", line.text || " "])),
          ]),
          peek.moreChanges > 0
            ? h.div([h.Class(cn("mt-1 text-[12px] text-muted-foreground/70", TURN_CARD_ROW_INSET))], [String(peek.moreChanges), " more changed line", peek.moreChanges === 1 ? "" : "s"])
            : null,
        ]
        : note
          ? [turnCardMetaRow({ class: "mt-1" }, [FileText({ class: "size-2.5 shrink-0", strokeWidth: 2.5 }, h), h.span([], [note])], h)]
          : patch !== null
            ? [turnCardMetaRow({ class: "mt-1" }, [FileText({ class: "size-2.5 shrink-0", strokeWidth: 2.5 }, h), h.span([], ["No text changes to show"])], h)]
            : []),
    turnCardMetaRow({ class: "mt-1" }, [h.span([], ["Click to review"])], h),
  ]
}
