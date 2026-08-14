import { Focus, X } from "lucide-react"

/**
 * The one visible sign that focus mode is on: a "Focus" row naming the project
 * the sidebar is narrowed to.
 *
 * Same row as New Chat and Add Project above it — same layout, padding and
 * type — but held in their hover treatment (`border-border bg-muted`) rather
 * than reaching it on hover. That is what reads as a tag: an ordinary row the
 * sidebar has picked out. The project name sits in the trailing slot on the
 * same terms a chat row's detail label does.
 *
 * The whole row is the exit control, not just the X. At this size the glyph
 * alone is a poor tap target, and there is nothing else the row could do.
 */
export function FocusModePill({
  projectTitle,
  shortcutHint,
  onExit,
}: {
  projectTitle: string
  /** Shown in the tooltip, e.g. "⌘⇧F". Omitted when the action is unbound. */
  shortcutHint?: string
  onExit: () => void
}) {
  return (
    <button
      type="button"
      onClick={onExit}
      title={shortcutHint ? `Exit focus mode (${shortcutHint})` : "Exit focus mode"}
      aria-label={`Exit focus mode: ${projectTitle}`}
      className="group/focus-pill flex w-full items-center gap-2 rounded-lg border border-border bg-muted px-2 py-1.5 max-md:py-2 text-sm max-md:text-base text-muted-foreground transition-colors hover:text-foreground"
    >
      <Focus className="h-4 w-4 shrink-0" />
      <span>Focus</span>
      {/* A chat row's trailing slot, to the class: natural width, capped at half
          the row, truncating on a block so the ellipsis actually lands. */}
      <span className="ml-auto flex max-w-[50%] shrink-0 items-center gap-1.5 pl-3 text-xs">
        <span className="min-w-0 truncate">{projectTitle}</span>
      </span>
      <X className="h-4 w-4 shrink-0" />
    </button>
  )
}
