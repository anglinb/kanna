import type { ComponentPropsWithRef } from "react"
import { GitBranch } from "lucide-react"
import type { ProjectSidebarLabel } from "../../lib/project-label"
import { cn } from "../../lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"

/**
 * A project's name as the sidebar shows it: the repo, prefixed with a branch
 * glyph when the project is on a branch worth flagging.
 *
 * This used to read `repo/branch` inline, which spent the widest part of a very
 * narrow slot on the least scannable half — at sidebar width a long branch name
 * pushed the repo into an ellipsis, so the one thing that tells two rows apart
 * was the first to go. The glyph says "not on main" in a fixed 12px, and the
 * branch moves to the tooltip, where there's room to spell it out and qualify it
 * with `owner/repo`.
 */

/** Branch over `owner/repo` — the tooltip body. Renders nothing when there's nothing to add. */
export function ProjectLabelTooltipLines({ label }: { label: ProjectSidebarLabel }) {
  if (!label.branchName && !label.repoPath) return null
  return (
    <>
      {label.branchName ? <div className="font-medium">{label.branchName}</div> : null}
      {/* Fainter: it's the qualifier, not the answer. The branch is what you
          hovered for; the repo is already on screen behind the tooltip. */}
      {label.repoPath ? <div className="text-muted-foreground">{label.repoPath}</div> : null}
    </>
  )
}

/**
 * The inline form — glyph plus name, truncating the name only (`shrink-0` keeps
 * a long repo name from squeezing the glyph into a sliver).
 *
 * Takes `ref` and spreads the rest so it can be a Radix `asChild` trigger: the
 * tooltip clones its trigger onto this element and needs both its handlers and
 * a real DOM node to anchor to.
 */
export function ProjectLabelInline({
  label,
  className,
  ...props
}: { label: ProjectSidebarLabel } & ComponentPropsWithRef<"span">) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)} {...props}>
      {label.branchName ? <GitBranch className="size-3 shrink-0" /> : null}
      <span className="min-w-0 truncate">{label.name}</span>
    </span>
  )
}

/**
 * The whole treatment for a chat row's trailing slot: inline label plus the
 * hover tooltip carrying what the inline form dropped. A label with nothing to
 * add (a renamed project, or a repo not probed yet) renders as plain text rather
 * than a trigger that opens an empty card.
 */
export function ProjectLabel({ label }: { label: ProjectSidebarLabel }) {
  if (!label.branchName && !label.repoPath) {
    return <span className="min-w-0 truncate">{label.name}</span>
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* The sidebar row's label wrapper is `pointer-events-none` so a fading
            label can't steal hover from the row's action icons; the trigger has
            to opt back in or it would never see a pointer. */}
        <ProjectLabelInline label={label} className="pointer-events-auto" />
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-64 leading-snug">
        <ProjectLabelTooltipLines label={label} />
      </TooltipContent>
    </Tooltip>
  )
}
