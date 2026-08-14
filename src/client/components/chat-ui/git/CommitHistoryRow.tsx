import { ArrowUp, Check, X } from "lucide-react"
import type { ChatBranchHistoryEntry, ChatCommitChecks } from "../../../../shared/types"
import { formatRelativeTime } from "../../../lib/formatters"
import { cn } from "../../../lib/utils"

function openInNewTab(url: string) {
  if (typeof window === "undefined") return
  window.open(url, "_blank", "noopener,noreferrer")
}

function describeChecks(checks: ChatCommitChecks) {
  if (checks.state === "pending") {
    return `Checks running — ${checks.passed} of ${checks.total} finished`
  }
  return `${checks.passed} of ${checks.total} checks passed`
}

function CommitChecksBadge({ checks }: { checks: ChatCommitChecks }) {
  const label = describeChecks(checks)
  return (
    <button
      type="button"
      // The row behind this badge opens the commit, so the click must stop
      // here to reach the Actions run instead.
      onClick={(event) => {
        event.stopPropagation()
        if (checks.url) openInNewTab(checks.url)
      }}
      disabled={!checks.url}
      title={label}
      aria-label={label}
      className={cn(
        // Pushed to the row's right edge, so the counts line up down the list
        // however long the author name and time read.
        "pointer-events-auto -mr-1 ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 transition-colors",
        checks.url ? "hover:bg-accent hover:text-foreground" : "cursor-default"
      )}
    >
      {checks.state === "success" ? (
        <Check className="size-3 text-emerald-600 dark:text-emerald-500" />
      ) : checks.state === "failure" ? (
        <X className="size-3 text-red-600 dark:text-red-500" />
      ) : (
        <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
      )}
      <span className="tabular-nums">{checks.passed} / {checks.total}</span>
    </button>
  )
}

export function CommitHistoryRow({ entry, isPendingPush = false }: { entry: ChatBranchHistoryEntry; isPendingPush?: boolean }) {
  const relativeTime = formatRelativeTime(entry.authoredAt)
  const isClickable = Boolean(entry.githubUrl)
  const showTags = entry.tags.length > 0 || isPendingPush

  return (
    <div className="relative">
      {/* The commit link sits behind the row rather than wrapping it. The
          checks badge is a button too, and a button cannot nest in a button. */}
      <button
        type="button"
        disabled={!isClickable}
        onClick={() => {
          if (entry.githubUrl) openInNewTab(entry.githubUrl)
        }}
        aria-label={`Open commit ${entry.sha.slice(0, 7)} on GitHub`}
        className={cn(
          "absolute inset-0 transition-colors",
          isClickable ? "hover:bg-accent" : "cursor-default"
        )}
      />
      <div
        className={cn(
          "pointer-events-none relative flex w-full items-start gap-3 py-2.5 pl-3 pr-2 text-left",
          isClickable ? null : "opacity-60"
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{entry.summary}</div>
          {entry.description ? (
            <div className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
              {entry.description}
            </div>
          ) : null}
          <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            {entry.authorName ? <span className="truncate">{entry.authorName}</span> : null}
            {entry.authorName && relativeTime ? <span aria-hidden="true">•</span> : null}
            {relativeTime ? <span>{relativeTime}</span> : null}
            {entry.checks ? <CommitChecksBadge checks={entry.checks} /> : null}
          </div>
        </div>
        {showTags ? (
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            {entry.tags.map((tag) => (
              <span key={tag} className="inline-flex items-center rounded-full bg-slate-900/10 border-black/10 dark:bg-white/10 border dark:border-white/10  px-2 py-0.5 text-[11px]">
                {tag}
              </span>
            ))}
            {isPendingPush ? (
              <span className="inline-flex items-center rounded-full bg-slate-900/10 border-black/10 dark:bg-white/10 border dark:border-white/10  px-2 py-0.5 text-[11px]">
                <ArrowUp className="size-3" />
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
