import { Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { DIFF_REVIEW_STORAGE_KEY_PREFIX } from "../../client/lib/storageKeys"
import { cn } from "../../client/lib/utils"
import type { ViewerAttachment } from "../core/stores/viewer"
import { isDiffPathChecked, type ProjectDiffCommitSelection } from "../core/stores/diffCommit"
import { errorMessage, sendCommand } from "../core/socket"
import { ChevronDown, Columns2, FileDiff, FoldVertical, Rows3, UnfoldVertical, WrapText } from "../ui/icons"
import { skeleton } from "../ui/skeleton"
import { domStream } from "../ui/overlay/stream"
import { hasRenderedView, renderedFilePreview } from "./attachment"
import { PatchDiffMount } from "./diffs"
import type { FileContext } from "./file"
import { diffFileStat, diffHold, diffStatus, getDiffPreviewAttachment, sortByPath, splitDiffPath, type DiffFile, type DiffRenderMode } from "./git"
import { Message, type RestoredReview } from "./message"
import type { DiffState, Model, PatchEntry } from "./model"
import { openFileSelect, selectId } from "./openFileSelect"
import { VIEWER_END_PAD_CLASS, viewerDivider, viewerIconButton, viewerSurface, viewerToggle, type LayerContext } from "./surface"

// DiffViewer (components/chat-ui/git/DiffViewer.tsx) with DiffPatchView: the
// change set in the viewer, as on GitHub's "Files changed": every file
// checked for the commit, one after another in one scroll, each as tall as
// its diff. A file's header sticks while you're in it; the viewer's header
// counts which file that is, and j/k jump between them.
//
// Built to stay quick on a large change: a page of files at a time, and a
// file's patch is read and drawn only once it comes near the view (until
// then it holds its place at about its size). Binaries, deleted, generated
// and very large files wait, as on GitHub (diffHold).

type H = HtmlBuilder<Message>

export const DIFF_CARD_KEY = "diff"

/** Files the list holds before "Load more": a long change set opens at once and scrolls smoothly. */
export const DIFF_VIEWER_PAGE_SIZE = 25
/** A diff line's height, for holding a file's place before it's drawn. */
const ESTIMATED_LINE_HEIGHT = 20
/** How far outside the view a file starts loading and drawing, so scrolling lands on diffs, not skeletons. */
const DRAW_AHEAD = "1200px 0px"
/** How long a restored position is held while the files around it draw, unless you scroll first. */
const RESTORE_HOLD_MS = 4_000

/** What the viewer needs from the page to show diffs: the files, and how to read and open them. */
export interface DiffContext extends FileContext {
  projectId: string
  /** Whether `files` is the working tree's, not the empty list a page starts with. */
  filesReady: boolean
  diffRenderMode: DiffRenderMode
  selection: ProjectDiffCommitSelection | undefined
}

/**
 * The files the viewer lists: the ones checked for the commit, in the
 * Changes card's order (tree order), plus the one you opened if it isn't
 * checked (you asked to see it).
 */
export function reviewFiles(files: readonly DiffFile[], isChecked: (path: string) => boolean, openedPath: string) {
  return files.filter((file) => isChecked(file.path) || file.path === openedPath)
}

/** How many files to hold: whole pages, enough to reach the one asked for. */
export function pageLimit(limit: number, index: number) {
  if (index < limit) return limit
  return Math.ceil((index + 1) / DIFF_VIEWER_PAGE_SIZE) * DIFF_VIEWER_PAGE_SIZE
}

/** Where a file's patch is kept: the three-line diff and the full file are read and kept apart. */
export function patchKey(path: string, full: boolean) {
  return full ? `${path}\u0000full` : path
}

/** Whether "Show full file" has anything to add. */
function canShowFullFile(file: DiffFile) {
  return (file.changeType === "modified" || file.changeType === "renamed") && file.additions + file.deletions > 0
}

/** A changed file as it reads now, from the working tree. */
function workingTreeAttachment(projectId: string, file: DiffFile): ViewerAttachment {
  return {
    url: `/api/projects/${projectId}/files/${encodeURIComponent(file.path)}/content?v=${encodeURIComponent(file.patchDigest)}`,
    name: splitDiffPath(file.path).name,
    mimeType: file.mimeType ?? "text/plain",
    size: file.size ?? null,
  }
}

/** What a file shows instead of its diff until you ask, or null once it's drawn as usual. */
function heldBack(projectId: string, file: DiffFile, loaded: ReadonlyArray<string>) {
  if (getDiffPreviewAttachment(projectId, file)) return null
  const hold = diffHold(file)
  if (!hold || (hold.loadable && loaded.includes(file.path))) return null
  return hold
}

// THE REVIEW'S STATE

export function readReviewState(projectId: string): RestoredReview | null {
  try {
    const raw = sessionStorage.getItem(`${DIFF_REVIEW_STORAGE_KEY_PREFIX}${projectId}`)
    return raw ? JSON.parse(raw) as RestoredReview : null
  } catch {
    return null
  }
}

export const SaveReviewState = Command.define("SaveViewerReviewState", {
  args: { projectId: Schema.String, state: Schema.Unknown },
  messages: [Message.CompletedSideEffect],
  execute: ({ projectId, state }) => Effect.sync(() => {
    try {
      sessionStorage.setItem(`${DIFF_REVIEW_STORAGE_KEY_PREFIX}${projectId}`, JSON.stringify(state))
    } catch {
      // Storage full or off: a reload starts at the file's top instead.
    }
    return Message.CompletedSideEffect()
  }),
})

export const ClearReviewState = Command.define("ClearViewerReviewState", {
  args: { projectId: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ projectId }) => Effect.sync(() => {
    try {
      sessionStorage.removeItem(`${DIFF_REVIEW_STORAGE_KEY_PREFIX}${projectId}`)
    } catch {
      // Nothing to clear.
    }
    return Message.CompletedSideEffect()
  }),
})

/** `onLoadPatch`: `project.readDiffPatch`, the whole file around the changes with `full`. */
export const ReadPatch = Command.define("ReadViewerDiffPatch", {
  args: { projectId: Schema.String, path: Schema.String, full: Schema.Boolean, key: Schema.String, digest: Schema.String },
  messages: [Message.ReceivedPatch, Message.FailedPatch],
  execute: ({ projectId, path, full, key, digest }) =>
    sendCommand<{ patch: string }>({ type: "project.readDiffPatch", projectId, path, ...(full ? { fullContext: true } : {}) }).pipe(
      Effect.map((result) => Message.ReceivedPatch({ key, digest, patch: result.patch })),
      Effect.catch((error) => Effect.succeed(Message.FailedPatch({ key, digest, error: errorMessage(error) }))),
    ),
})

export function initialDiffState(projectId: string, path: string, openCount: number, restored: RestoredReview | null): DiffState {
  const restore = restored && restored.path === path ? restored : null
  return {
    projectId,
    path,
    openCount,
    restore: restore ? { path: restore.path, offset: restore.offset } : null,
    patches: {},
    seen: [],
    collapsed: restore?.collapsed ?? [],
    previewing: restore?.previewing ?? [],
    loaded: restore?.loaded ?? [],
    full: restore?.full ?? [],
    activeIndex: 0,
    limit: DIFF_VIEWER_PAGE_SIZE,
    jump: { path, seq: 1 },
    jumpSeq: 1,
    offset: restore?.offset ?? 0,
  }
}

/** What a review saves for a reload to come back to. */
export function reviewSnapshot(state: DiffState, files: ReadonlyArray<DiffFile>): RestoredReview | null {
  const shown = files.slice(0, Math.min(files.length, pageLimit(state.limit, files.findIndex((file) => file.path === state.path))))
  const current = shown[Math.min(state.activeIndex, shown.length - 1)]
  if (!current) return null
  return {
    path: current.path,
    offset: state.offset,
    collapsed: [...state.collapsed],
    previewing: [...state.previewing],
    full: [...state.full],
    loaded: [...state.loaded],
  }
}

/** The files the review lists, in its order. */
export function reviewList(context: DiffContext, openedPath: string): DiffFile[] {
  return reviewFiles(sortByPath(context.files), (candidate) => isDiffPathChecked(context.selection, candidate), openedPath)
}

/** The patches the view needs read, as it stands: files near the view, open and showing their diff. */
function neededLoads(state: DiffState, shown: ReadonlyArray<DiffFile>) {
  const loads: Array<{ path: string; full: boolean; digest: string }> = []
  for (const file of shown) {
    if (!state.seen.includes(file.path) || state.collapsed.includes(file.path) || state.previewing.includes(file.path)) continue
    if (heldBack(state.projectId, file, state.loaded)) continue
    const full = state.full.includes(file.path)
    const entry = state.patches[patchKey(file.path, full)]
    if (!entry || entry.digest !== file.patchDigest) loads.push({ path: file.path, full, digest: file.patchDigest })
  }
  return loads
}

// MOUNTS

/** Where the last jump left each list's scroller, and to which file. */
const lastJumps = new WeakMap<Element, { index: number; top: number }>()

/**
 * On a hidden element in the list, remade with each change of the files it
 * holds (React's effects on `shown`): a file is drawn once it comes within
 * DRAW_AHEAD of the view, and stays; and the file you're in is the last
 * whose top has reached the top of the view.
 */
export const ObserveReviewList = Mount.defineStream("ViewerObserveReviewList", {
  args: { paths: Schema.Array(Schema.String) },
  messages: [Message.SawFiles, Message.ScrolledReview],
  execute: ({ element, paths }) =>
    domStream<typeof Message.SawFiles.Type | typeof Message.ScrolledReview.Type>((emit) => {
      const list = element.parentElement
      const scroller = list?.parentElement
      if (!list || !scroller) return () => {}
      const sections = () => paths
        .map((path) => list.querySelector<HTMLElement>(`:scope > section[data-path="${CSS.escape(path)}"]`))
        .filter((section): section is HTMLElement => section !== null)

      const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
        const arrived = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => (entry.target as HTMLElement).dataset.path)
          .filter((value): value is string => Boolean(value))
        if (arrived.length > 0) emit(Message.SawFiles({ paths: arrived }))
      }, { root: scroller, rootMargin: DRAW_AHEAD })
      for (const section of sections()) observer?.observe(section)

      let frame = 0
      const update = () => {
        frame = 0
        const top = scroller.scrollTop
        const jump = lastJumps.get(scroller)
        if (jump && Math.abs(jump.top - top) < 2) {
          emit(Message.ScrolledReview({ index: jump.index, offset: -1 }))
          return
        }
        lastJumps.delete(scroller)
        const all = sections()
        let index = 0
        for (const [position, section] of all.entries()) {
          if (section.offsetTop > top + 1) break
          index = position
        }
        const section = all[index]
        emit(Message.ScrolledReview({ index, offset: section ? Math.max(0, Math.round(top - section.offsetTop)) : 0 }))
      }
      const handleScroll = () => {
        if (!frame) frame = requestAnimationFrame(update)
      }
      scroller.addEventListener("scroll", handleScroll, { passive: true })
      return () => {
        observer?.disconnect()
        scroller.removeEventListener("scroll", handleScroll)
        if (frame) cancelAnimationFrame(frame)
      }
    }),
})

/** A jump, once its file is in the list: no animation, it's a keypress or a click, and you want to be there. */
export const JumpToFile = Mount.define("ViewerJumpToFile", {
  args: { seq: Schema.Number, path: Schema.String, index: Schema.Number, offset: Schema.Number },
  messages: [Message.LandedJump],
  execute: ({ element, seq, path, index, offset }) => Effect.sync(() => {
    const list = element.parentElement
    const scroller = list?.parentElement
    const section = list?.querySelector<HTMLElement>(`:scope > section[data-path="${CSS.escape(path)}"]`)
    if (scroller && section) {
      scroller.scrollTop = section.offsetTop + offset
      lastJumps.set(scroller, { index, top: scroller.scrollTop })
    }
    return Message.LandedJump({ seq, index, path, offset })
  }),
})

/**
 * A restored spot is held while the files draw (a patch arriving, a file
 * above growing from its placeholder to its diff). The first sign of you
 * moving (wheel, touch, a key, a click) lets go.
 */
export const HoldRestoredSpot = Mount.defineStream("ViewerHoldRestoredSpot", {
  args: { path: Schema.String, offset: Schema.Number, index: Schema.Number },
  messages: [Message.ReleasedRestore],
  execute: ({ element, path, offset, index }) =>
    domStream<typeof Message.ReleasedRestore.Type>((emit) => {
      const list = element.parentElement
      const scroller = list?.parentElement
      if (!list || !scroller) return () => {}
      const apply = () => {
        const section = list.querySelector<HTMLElement>(`:scope > section[data-path="${CSS.escape(path)}"]`)
        if (!section) return
        scroller.scrollTop = section.offsetTop + offset
        lastJumps.set(scroller, { index, top: scroller.scrollTop })
      }
      const release = () => emit(Message.ReleasedRestore())
      const observer = new ResizeObserver(apply)
      observer.observe(list)
      const timer = window.setTimeout(release, RESTORE_HOLD_MS)
      const scrollerEvents = ["wheel", "touchstart", "pointerdown"] as const
      for (const type of scrollerEvents) scroller.addEventListener(type, release, { passive: true })
      window.addEventListener("keydown", release, true)
      return () => {
        observer.disconnect()
        window.clearTimeout(timer)
        for (const type of scrollerEvents) scroller.removeEventListener(type, release)
        window.removeEventListener("keydown", release, true)
      }
    }),
})

/** Reports what it was made with, once: a fact the view saw that update must act on. */
export const ReportNeededPatches = Mount.define("ViewerReportNeededPatches", {
  args: { loads: Schema.Array(Schema.Struct({ path: Schema.String, full: Schema.Boolean, digest: Schema.String })) },
  messages: [Message.NeededPatches],
  execute: ({ loads }) => Effect.succeed(Message.NeededPatches({ loads })),
})

export const ReportReopened = Mount.define("ViewerReportReopenedReview", {
  args: { path: Schema.String, openCount: Schema.Number },
  messages: [Message.ReopenedReview],
  execute: ({ path, openCount }) => Effect.succeed(Message.ReopenedReview({ path, openCount })),
})

export const ReportEmptied = Mount.define("ViewerReportEmptiedReview", {
  messages: [Message.EmptiedReview],
  execute: () => Effect.succeed(Message.EmptiedReview()),
})

/** The review mounted: what this tab left it at comes back (`readReviewState`). */
export const MountReview = Mount.define("ViewerMountReview", {
  args: { projectId: Schema.String, path: Schema.String, openCount: Schema.Number },
  messages: [Message.MountedReview],
  execute: ({ projectId, path, openCount }) => Effect.sync(() => Message.MountedReview({ projectId, path, openCount, restore: readReviewState(projectId) })),
})

// THE VIEW

/** The patch while it loads, in the diff's own line rhythm so it lands in place. */
const SKELETON_DIFF_LINES = [
  { indent: 0, width: "38%" },
  { indent: 1, width: "64%" },
  { indent: 1, width: "52%" },
  { indent: 2, width: "71%" },
  { indent: 2, width: "44%" },
  { indent: 1, width: "30%" },
  { indent: 1, width: "58%" },
  { indent: 0, width: "22%" },
]

export function diffPatchSkeleton(h: H): Html {
  return h.div([h.Class("space-y-2 px-4 py-4"), h.AriaBusy(true), h.AriaLabel("Loading diff")], [
    skeleton({ class: "h-3 w-24 bg-foreground/[0.05]" }, h),
    ...SKELETON_DIFF_LINES.map((line) => h.div([h.Class("flex items-center gap-3")], [
      skeleton({ class: "h-3 w-5 shrink-0 bg-foreground/[0.05]" }, h),
      skeleton({ class: "h-3", style: { "margin-left": `${line.indent * 12}px`, width: line.width } }, h),
    ])),
  ])
}

/** The review's state as the view sees it: the card's own once it has mounted, a fresh one before. */
export function diffStateOf(model: Model, projectId: string, path: string, openCount: number): DiffState {
  const state = model.card?.key === DIFF_CARD_KEY ? model.diff : null
  return state && state.projectId === projectId ? state : initialDiffState(projectId, path, openCount, null)
}

export function diffViewer(model: Model, context: LayerContext, diff: DiffContext, item: { projectId: string; path: string }, openCount: number, h: H): Html {
  const { projectId, path } = item
  const state = diffStateOf(model, projectId, path, openCount)
  const files = reviewList(diff, path)
  const openedIndex = files.findIndex((file) => file.path === path)
  const shownCount = Math.min(files.length, pageLimit(state.limit, openedIndex))
  const shown = files.slice(0, shownCount)
  const mounted = model.card?.key === DIFF_CARD_KEY && model.diff?.projectId === projectId
  const reports: Array<Html | null> = [
    mounted ? null : h.keyed("span")(`review-mount:${projectId}`, [h.Hidden(true), h.OnMount(MountReview({ projectId, path, openCount }))], []),
    mounted && (state.path !== path || state.openCount !== openCount)
      ? h.keyed("span")(`review-reopen:${path}:${openCount}`, [h.Hidden(true), h.OnMount(ReportReopened({ path, openCount }))], [])
      : null,
  ]

  if (files.length === 0) {
    // Everything was committed or unchecked: nothing left to review. Not
    // before the files have arrived, though: that's a reload, still loading.
    if (diff.filesReady) return h.keyed("span")("review-empty", [h.Hidden(true), h.OnMount(ReportEmptied())], [])
    return viewerSurface(model, context, {
      cardKey: DIFF_CARD_KEY,
      label: "Review changes",
      icon: FileDiff({}, h),
      title: "Changes",
      body: [diffPatchSkeleton(h), ...reports],
    }, h)
  }

  const activeIndex = Math.min(state.activeIndex, files.length - 1)
  const totals = files.reduce(
    (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  )
  const remaining = files.length - shownCount
  const loads = mounted ? neededLoads(state, shown) : []
  const jump = mounted && state.jump ? state.jump : null
  const jumpIndex = jump ? shown.findIndex((file) => file.path === jump.path) : -1
  const restore = mounted && state.restore ? state.restore : null
  const restoreIndex = restore ? shown.findIndex((file) => file.path === restore.path) : -1

  return viewerSurface(model, context, {
    cardKey: DIFF_CARD_KEY,
    label: "Review changes",
    icon: FileDiff({}, h),
    title: "Changes",
    subtitle: `${files.length.toLocaleString()} ${files.length === 1 ? "file" : "files"}`,
    navigation: { index: activeIndex, count: files.length },
    toolbar: [
      diffFileStat({ additions: totals.additions, deletions: totals.deletions, className: "px-1" }, h),
      viewerDivider(h),
      viewerIconButton(model, { id: "unified", label: "Unified diff", active: diff.diffRenderMode === "unified", onClick: Message.ChoseDiffMode({ mode: "unified" }) }, Rows3({}, h), h),
      viewerIconButton(model, { id: "split", label: "Side-by-side diff", active: diff.diffRenderMode === "split", onClick: Message.ChoseDiffMode({ mode: "split" }) }, Columns2({}, h), h),
      viewerIconButton(model, {
        id: "wrap",
        label: diff.wrapLines ? "Disable word wrap" : "Enable word wrap",
        active: diff.wrapLines,
        onClick: Message.ClickedWrapLines(),
      }, WrapText({}, h), h),
    ],
    body: [
      // relative: each file's offsetTop is then its place in the scroll.
      h.div([h.Class(cn("relative", VIEWER_END_PAD_CLASS))], [
        ...shown.map((file) => fileSection(model, state, diff, file, h)),
        remaining > 0
          ? h.keyed("div")("load-more", [h.Class("flex justify-center px-4 py-6")], [
            h.button([
              h.Type("button"),
              h.OnClick(Message.ClickedLoadMore()),
              h.Class("flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm transition-[background-color,scale] duration-150 ease-snappy hover:bg-muted active:scale-[0.97]"),
            ], [
              `Load ${Math.min(DIFF_VIEWER_PAGE_SIZE, remaining).toLocaleString()} more`,
              remaining > DIFF_VIEWER_PAGE_SIZE ? h.span([h.Class("text-muted-foreground")], [`· ${remaining.toLocaleString()} left`]) : null,
            ]),
          ])
          : null,
        mounted
          ? h.keyed("span")(`review-observe:${shown.map((file) => file.path).join("\u0000")}`, [h.Hidden(true), h.OnMount(ObserveReviewList({ paths: shown.map((file) => file.path) }))], [])
          : null,
        jump && jumpIndex !== -1
          ? h.keyed("span")(`review-jump:${jump.seq}`, [h.Hidden(true), h.OnMount(JumpToFile({
            seq: jump.seq,
            path: jump.path,
            index: jumpIndex,
            offset: restore?.path === jump.path ? restore.offset : 0,
          }))], [])
          : null,
        restore && restoreIndex !== -1 && !jump
          ? h.keyed("span")("review-restore", [h.Hidden(true), h.OnMount(HoldRestoredSpot({ path: restore.path, offset: restore.offset, index: restoreIndex }))], [])
          : null,
        loads.length > 0
          ? h.keyed("span")(`review-loads:${JSON.stringify(loads)}`, [h.Hidden(true), h.OnMount(ReportNeededPatches({ loads }))], [])
          : null,
      ]),
      ...reports,
    ],
  }, h)
}

/** One file in the list: a header that sticks while you're in it, then its diff (or preview). */
function fileSection(model: Model, state: DiffState, diff: DiffContext, file: DiffFile, h: H): Html {
  const { projectId } = state
  const status = diffStatus(file)
  const { name, folder } = splitDiffPath(file.path)
  const attachment = workingTreeAttachment(projectId, file)
  // A deleted file has nothing left in the working tree to render.
  const previewable = file.changeType !== "deleted" && hasRenderedView(attachment)
  const collapsed = state.collapsed.includes(file.path)
  const previewing = state.previewing.includes(file.path)
  const drawn = state.seen.includes(file.path)
  const hold = heldBack(projectId, file, state.loaded)
  const full = state.full.includes(file.path)
  const entry = state.patches[patchKey(file.path, full)]
  const isCurrent = entry?.digest === file.patchDigest
  const changedLines = file.additions + file.deletions
  const fullToggle = canShowFullFile(file) && !collapsed && !(previewable && previewing) && !hold
    && !getDiffPreviewAttachment(projectId, file)

  let body: Array<Html | null> = []
  if (collapsed) {
    body = []
  } else if (!drawn) {
    // Holds the file's place at about its size, so the scrollbar and the files below don't jump.
    const lines = hold ? 3 : changedLines + 8
    body = [h.div([h.AriaHidden(true), h.Style({ height: `${Math.max(80, lines * ESTIMATED_LINE_HEIGHT)}px` })], [])]
  } else if (previewable && previewing) {
    const preview = renderedFilePreview(model, DIFF_CARD_KEY, `section:${file.path}`, attachment, false, h)
    body = [preview.body, preview.loader]
  } else if (hold) {
    body = [h.div([h.Class("flex items-center justify-center gap-3 px-4 py-6 text-sm text-muted-foreground")], [
      h.span([], [hold.message]),
      hold.loadable
        ? h.button([
          h.Type("button"),
          h.OnClick(Message.ClickedLoadHeld({ path: file.path })),
          h.Class("rounded-lg border border-border px-3 py-1.5 text-foreground transition-[background-color,scale] duration-150 ease-snappy hover:bg-muted active:scale-[0.97]"),
        ], ["Load diff"])
        : null,
    ])]
  } else {
    body = [diffPatchView(projectId, file, isCurrent ? entry : undefined, !isCurrent || Boolean(entry?.loading), diff, full, h)]
  }

  return h.keyed("section")(file.path, [h.DataAttribute("path", file.path), h.AriaLabel(file.path), h.Class("border-b border-border")], [
    // Sticks to the top of the view while you're in this file.
    h.header([
      h.Class(cn(
        "sticky top-0 z-10 h-10 items-center gap-2 bg-background px-2 dark:bg-card",
        !collapsed && "border-b border-border",
        previewable ? "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]" : "flex",
      )),
    ], [
      h.div([h.Class(cn("flex min-w-0 items-center gap-2", !previewable && "flex-1"))], [
        h.button([
          h.Type("button"),
          h.OnClick(Message.ToggledCollapsed({ path: file.path })),
          h.AriaExpanded(!collapsed),
          h.AriaLabel(collapsed ? `Expand ${file.path}` : `Collapse ${file.path}`),
          h.Class("flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"),
        ], [ChevronDown({ class: cn("size-4 transition-transform duration-150 ease-snappy", collapsed && "-rotate-90") }, h)]),
        h.span([h.Class(cn("w-3 shrink-0 text-center font-mono text-xs font-semibold", status.className)), h.Title(status.label)], [status.letter]),
        h.div([h.Class("flex min-w-0 flex-1 items-baseline gap-2")], [
          h.span([h.Class("min-w-0 max-w-[60%] shrink-0 truncate text-sm font-medium text-foreground")], [name]),
          // RTL so a long folder loses its start, not its end; <bdi> keeps the path reading left to right.
          folder ? h.span([h.Class("min-w-0 flex-1 truncate text-left text-xs text-muted-foreground [direction:rtl]")], [h.bdi([], [folder])]) : null,
        ]),
      ]),
      previewable
        ? h.div([h.Class("flex items-center")], [
          viewerToggle(previewing ? "preview" : "diff", [{ value: "diff", label: "Diff" }, { value: "preview", label: "Preview" }], (value) => Message.ToggledPreview({ path: file.path, value }), h),
        ])
        : null,
      h.div([h.Class("flex min-w-0 shrink-0 items-center justify-end gap-2")], [
        // A binary has no lines to count; GitHub's BIN says so where they'd be.
        file.binary
          ? h.span([h.Class("px-1 font-mono text-xs text-muted-foreground")], ["BIN"])
          : diffFileStat({ additions: file.additions, deletions: file.deletions, className: "px-1" }, h),
        fullToggle
          ? viewerIconButton(model, {
            id: `full:${file.path}`,
            label: full ? "Hide full file" : "Show full file",
            active: full,
            onClick: Message.ToggledFullFile({ path: file.path }),
          }, full ? FoldVertical({}, h) : UnfoldVertical({}, h), h)
          : null,
        openFileSelect(model, diff.open, { id: selectId("diff", file.path, null), path: file.path, line: null }, h),
      ]),
    ]),
    ...body,
  ])
}

/** One file's change: its preview, its patch, a skeleton while it loads, or why it can't show. */
function diffPatchView(projectId: string, file: DiffFile, entry: PatchEntry | undefined, isLoading: boolean, diff: DiffContext, full: boolean, h: H): Html {
  const previewAttachment = getDiffPreviewAttachment(projectId, file)
  // An image or PDF shows as itself, as big as a file in the list can be.
  if (previewAttachment) {
    return previewAttachment.kind === "image"
      ? h.div([h.Class("flex items-center justify-center bg-muted/30 p-6")], [
        h.img([h.Src(previewAttachment.contentUrl), h.Alt(previewAttachment.displayName), h.Class("max-h-[min(500px,70vh)] max-w-full rounded-lg object-contain shadow-sm")]),
      ])
      : h.iframe([h.Src(previewAttachment.contentUrl), h.Title(previewAttachment.displayName), h.Class("h-[min(500px,70vh)] w-full border-0")])
  }
  if (isLoading) return diffPatchSkeleton(h)
  if (entry?.error) {
    return h.div([h.Class("flex items-center gap-3 px-4 py-4 text-sm text-destructive")], [
      h.span([h.Class("min-w-0 flex-1")], [entry.error]),
      h.button([
        h.Type("button"),
        h.OnClick(Message.ClickedRetryPatch({ path: file.path, full })),
        h.Class("shrink-0 text-muted-foreground transition-colors hover:text-foreground"),
      ], ["Retry"]),
    ])
  }
  const patch = entry?.patch
  if (patch === undefined) return diffPatchSkeleton(h)
  if (!patch.trim()) return h.div([h.Class("px-4 py-4 text-sm text-muted-foreground")], ["No textual changes."])
  return h.keyed("div")(`patch:${file.path}:${full}:${file.patchDigest}:${diff.diffRenderMode}:${diff.wrapLines}:${diff.theme}`, [
    h.Class("kanna-diff-patch overflow-hidden"),
    h.OnMount(PatchDiffMount({ patch, diffStyle: diff.diffRenderMode, wrap: diff.wrapLines, theme: diff.theme })),
  ], [])
}
