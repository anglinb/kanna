import type { Html, HtmlBuilder } from "foldkit/html"
import { formatRelativeTime } from "../../client/lib/formatters"
import { cn } from "../../client/lib/utils"
import type { ChatBranchListEntry, ChatCommitChecks, ChatPullRequestDetails } from "../../shared/types"
import type { Child } from "../ui/attributes"
import { Check, GitBranch, GitPullRequest, GitPullRequestArrow, GitPullRequestDraft, Minus, X } from "../ui/icons"
import { StopClickPropagation, type PartsMessage } from "./parts"
import { Mount } from "foldkit"

// Small git glyphs shared by the rows and cards: git/shared.tsx's
// StageCheckbox, DiffFileStat, CardPerson and CheckRollupLabel,
// git/PullRequestState.tsx and BranchList.tsx's branchRowContent.

/**
 * The commit checkbox. Its click doesn't reach the row (React stopped it):
 * `stopped` lifts the Mount that stops it into the host's Message.
 */
export function stageCheckbox<M>(
  options: { checked: boolean; mixed?: boolean; label?: string; class?: string; onClick: M; stopped: (message: PartsMessage) => M },
  h: HtmlBuilder<M>,
): Html {
  const mixed = options.mixed ?? false
  const checked = options.checked
  return h.button([
    h.Type("button"),
    h.AriaLabel(options.label ?? (checked ? "Exclude file from commit" : "Include file in commit")),
    h.Attribute("aria-checked", mixed ? "mixed" : String(checked)),
    h.Attribute("aria-pressed", mixed ? "mixed" : String(checked)),
    h.OnClick(options.onClick),
    h.OnMount(Mount.mapMessage(StopClickPropagation(), options.stopped)),
    h.Class(cn(
      "flex size-4.5 shrink-0 items-center justify-center rounded border transition-colors",
      checked || mixed ? "border-foreground bg-foreground text-background" : "border-border bg-background text-transparent",
      options.class,
    )),
  ], [
    mixed
      ? Minus({ class: "h-3 w-3", strokeWidth: 3 }, h)
      : checked ? Check({ class: "h-3 w-3", strokeWidth: 3 }, h) : null,
  ])
}

/** A file's line changes — `+6`, `-2`, or both. Nothing when both are zero or unknown. */
export function diffFileStat<M>(options: { additions?: number; deletions?: number; class?: string }, h: HtmlBuilder<M>): Html {
  const hasAdditions = (options.additions ?? 0) > 0
  const hasDeletions = (options.deletions ?? 0) > 0
  if (!hasAdditions && !hasDeletions) return null
  return h.span([h.Class(cn("whitespace-nowrap text-xs font-mono", options.class))], [
    hasAdditions ? h.span([h.Class("text-emerald-600 dark:text-emerald-400")], [`+${options.additions}`]) : null,
    hasDeletions ? h.span([h.Class(cn("text-red-600 dark:text-red-400", hasAdditions && "ml-2"))], [`-${options.deletions}`]) : null,
  ])
}

function describeChecks(checks: ChatCommitChecks) {
  return checks.state === "pending"
    ? `Checks running: ${checks.passed} of ${checks.total} finished`
    : `${checks.passed} of ${checks.total} checks passed`
}

/**
 * A check rollup under a row's age: "12/16" then ✓, ✕, or the amber pending
 * dot. Opens the CI run when GitHub gave a link (its click doesn't reach the
 * row).
 */
export function checksIcon<M>(checks: ChatCommitChecks, options: { onOpen: (url: string) => M; stopped: (message: PartsMessage) => M }, h: HtmlBuilder<M>): Html {
  const label = describeChecks(checks)
  const glyph = checks.state === "success"
    ? Check({ class: "size-3 text-success", strokeWidth: 2.5 }, h)
    : checks.state === "failure"
      ? X({ class: "size-3 text-destructive", strokeWidth: 2.5 }, h)
      : h.span([h.Class("size-1.5 rounded-full bg-amber-500")], [])
  const content: ReadonlyArray<Child> = [
    h.span([h.Class("tabular-nums")], [String(checks.passed), "/", String(checks.total)]),
    h.span([h.Class("flex size-3 shrink-0 items-center justify-center")], [glyph]),
  ]
  const className = "flex shrink-0 items-center gap-1"
  if (!checks.url) return h.span([h.Title(label), h.AriaLabel(label), h.Class(className)], content)
  return h.button([
    h.Type("button"),
    h.Title(label),
    h.AriaLabel(label),
    h.OnClick(options.onOpen(checks.url)),
    h.OnMount(Mount.mapMessage(StopClickPropagation(), options.stopped)),
    h.Class(`${className} cursor-pointer rounded-sm hover:text-foreground`),
  ], content)
}

/** GitHub's merge state as the PR row's main icon, named by its tooltip. */
export function pullRequestStateIcon<M>(pr: ChatPullRequestDetails | undefined, h: HtmlBuilder<M>): { icon: Html; label: string } {
  if (pr?.isDraft) return { icon: GitPullRequestDraft({ class: "text-muted-foreground" }, h), label: "Draft" }
  switch (pr?.mergeableState) {
    case "clean":
    case "has_hooks":
      return { icon: GitPullRequestArrow({ class: "text-success" }, h), label: "Ready to merge" }
    case "dirty":
      return { icon: GitPullRequest({ class: "text-destructive" }, h), label: "Has conflicts" }
    case "unstable":
      return { icon: GitPullRequest({ class: "text-amber-500" }, h), label: "Mergeable, but checks are failing" }
    case "blocked":
      return { icon: GitPullRequest({ class: "text-amber-500" }, h), label: "Blocked: needs reviews or checks" }
    case "behind":
      return { icon: GitPullRequest({ class: "text-amber-500" }, h), label: "Behind its base branch" }
    default:
      return { icon: GitPullRequest({}, h), label: "Pull request" }
  }
}

/** A state glyph named by its tooltip, as the rows set it. */
export function labelledIcon<M>(state: { icon: Html; label: string }, h: HtmlBuilder<M>): Html {
  return h.span([h.Title(state.label), h.AriaLabel(state.label), h.Class("flex")], [state.icon])
}

/**
 * What a branch row shows. A PR row: its title, then "#number · author", its
 * age on the right. A branch row: its name and age.
 */
export function branchRowContent<M>(entry: ChatBranchListEntry, h: HtmlBuilder<M>): { icon: Html; title: string; subtitle?: string; meta?: string } {
  if (entry.kind === "pull_request") {
    const subtitle = [entry.prNumber ? `#${entry.prNumber}` : null, entry.authorName ?? entry.authorLogin].filter(Boolean).join(" · ")
    return {
      icon: GitPullRequest({}, h),
      title: entry.prTitle ?? entry.displayName,
      ...(subtitle ? { subtitle } : {}),
      ...(entry.updatedAt ? { meta: formatRelativeTime(entry.updatedAt) } : {}),
    }
  }
  return {
    icon: GitBranch({}, h),
    title: entry.displayName,
    ...(entry.headLabel ? { subtitle: entry.headLabel } : {}),
    ...(entry.updatedAt ? { meta: formatRelativeTime(entry.updatedAt) } : {}),
  }
}

/**
 * Who a hover card is about, leading the card: a GitHub avatar when there's
 * a login; otherwise the name's initial in a disc.
 */
export function cardPerson<M>(options: { name: string; avatarUrl?: string; detail?: string; title?: string }, h: HtmlBuilder<M>): Html {
  return h.span([h.Class("flex min-w-0 items-center gap-1.5"), ...(options.title !== undefined ? [h.Title(options.title)] : [])], [
    options.avatarUrl
      ? h.img([h.Src(options.avatarUrl), h.Alt(""), h.Class("size-4 shrink-0 rounded-full bg-muted")])
      : h.span([h.AriaHidden(true), h.Class("flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold uppercase text-foreground")], [options.name.trim().charAt(0)]),
    h.span([h.Class("truncate text-[13px] font-medium tracking-normal text-popover-foreground")], [options.name]),
    options.detail ? h.span([h.Class("shrink-0 truncate")], [options.detail]) : null,
  ])
}
