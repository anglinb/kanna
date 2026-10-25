import type { Html, HtmlBuilder } from "foldkit/html"
import { shortcutToGlyphs } from "../../client/lib/keybindings"
import type { RepoRef } from "../../client/lib/project-fs"
import type { Child } from "../ui/attributes"
import { Check, Circle, GitBranch, Loader2, Star } from "../ui/icons"
import type { RepoMeta } from "./model"

// The palette's presentational pieces: CommandPalette's ShortcutHint and
// trailing labels, and add-project-rows.tsx.

export const ICON_CLASS = "h-4 w-4 text-muted-foreground"

/** ShortcutHint: the first keybinding as glyphs, e.g. "⌘J". */
export function shortcutHint<Message>(binding: string, h: HtmlBuilder<Message>): Html {
  return h.span([h.Class("ml-auto shrink-0 pl-3 text-xs tracking-widest text-muted-foreground")], [shortcutToGlyphs(binding)])
}

/** The muted trailing label an action shows when it has no shortcut. */
export function trailingHint<Message>(text: string, h: HtmlBuilder<Message>): Html {
  return h.span([h.Class("ml-auto shrink-0 pl-3 text-xs text-muted-foreground")], [text])
}

/** The truncated trailing path most project rows show. */
export function trailingPath<Message>(text: string, h: HtmlBuilder<Message>, width = "max-w-[220px]", extra = ""): Html {
  return h.span([h.Class(`ml-auto ${width} shrink-0 truncate pl-3 ${extra}${extra ? " " : ""}text-xs text-muted-foreground`)], [text])
}

/** A row's busy spinner, where its trailing label was. */
export function rowSpinner<Message>(h: HtmlBuilder<Message>): Html {
  return Loader2({ class: "ml-auto h-4 w-4 shrink-0 animate-spin text-muted-foreground" }, h)
}

export function titleSpan<Message>(title: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  return h.span([h.Class("min-w-0 truncate")], title)
}

/**
 * Inner content for the typed-repo result row on the Clone page: repo name,
 * debounced GitHub metadata (description, stars, language, last update), and
 * the clone destination.
 */
export function repoResultContent<Message>(args: {
  repo: RepoRef
  meta: RepoMeta | null
  metaLoading: boolean
  metaError: string | null
  destinationLabel: string
}, h: HtmlBuilder<Message>): Html {
  const { repo, meta, metaLoading, metaError, destinationLabel } = args
  return h.div([h.Class("flex min-w-0 flex-1 flex-col gap-0.5 py-0.5")], [
    h.div([h.Class("flex items-center gap-2 min-w-0")], [
      GitBranch({ class: "h-4 w-4 flex-shrink-0 text-muted-foreground" }, h),
      h.span([h.Class("text-sm font-medium truncate")], [meta?.fullName ?? `${repo.owner}/${repo.repo}`]),
      ...(metaLoading ? [Loader2({ class: "h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground" }, h)] : []),
      h.span([h.Class("ml-auto max-w-[220px] shrink-0 truncate pl-3 text-xs text-muted-foreground")], [destinationLabel]),
    ]),
    ...(meta?.description ? [h.p([h.Class("pl-6 text-xs text-muted-foreground truncate")], [meta.description])] : []),
    ...(meta
      ? [h.div([h.Class("flex items-center gap-3 pl-6 text-xs text-muted-foreground")], [
        h.span([h.Class("flex items-center gap-1")], [Star({ class: "h-3 w-3" }, h), meta.stars.toLocaleString()]),
        ...(meta.language
          ? [h.span([h.Class("flex items-center gap-1")], [Circle({ class: "h-2 w-2 fill-current" }, h), meta.language])]
          : []),
        ...(meta.pushedAt ? [h.span([], [`Updated ${new Date(meta.pushedAt).toLocaleDateString()}`])] : []),
      ])]
      : metaError
        ? [h.p([h.Class("pl-6 text-xs text-muted-foreground")], [metaError])]
        : repo.host !== "github.com"
          ? [h.p([h.Class("pl-6 text-xs text-muted-foreground")], [`Repository on ${repo.host}`])]
          : []),
  ])
}

/** Locked-palette clone progress: spinner while cloning, ✓ flash on success. */
export function cloneProgressBlock<Message>(args: { repo: RepoRef; status: "cloning" | "success"; destinationLabel: string }, h: HtmlBuilder<Message>): Html {
  const { repo, status, destinationLabel } = args
  const name = `${repo.owner}/${repo.repo}`
  return h.div([h.Class("space-y-2 px-3 py-3")], [
    h.div([h.Class("flex items-center gap-2.5")], [
      status === "cloning"
        ? Loader2({ class: "h-4 w-4 flex-shrink-0 animate-spin text-primary" }, h)
        : Check({ class: "h-4 w-4 flex-shrink-0 text-green-500" }, h),
      h.span([h.Class("text-sm text-foreground")], status === "cloning"
        ? ["Cloning ", h.span([h.Class("font-medium")], [name]), "…"]
        : ["Cloned ", h.span([h.Class("font-medium")], [name])]),
    ]),
    h.p([h.Class("pl-6 font-mono text-xs text-muted-foreground truncate")], [destinationLabel]),
  ])
}

/** Inline destructive error row (clone failures, open/create failures). */
export function paletteErrorRow<Message>(message: string, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class("mx-2 my-1.5 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive")], [message])
}
