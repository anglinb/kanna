import { Schema } from "effect"
import type { RepoRef } from "../../client/lib/project-fs"
import type { MacSetupState } from "../core/macApp"
import type { FsListResult, GitHubRecentReposResult, KeybindingsSnapshot } from "../../shared/types"
import { opaque } from "../core/schema"
import * as AppDialog from "../ui/app-dialog"
import * as Usage from "./usage"

// What CommandPalette held in React state and refs, and what its two hooks
// (useDirectoryBrowser, useRepoMetadata) kept. Everything it lists (chats,
// projects, settings, the composer) is the root's, read through `app`.

export const PAGES = [
  "models", "harness", "new-thread", "open-in", "settings", "usage", "project-chats",
  "add-project", "clone-github", "create-new", "browse", "hide-project",
] as const
export const PalettePage = Schema.Literals(PAGES)
export type PalettePage = typeof PalettePage.Type

/** Palette sub-pages callers may deep-link to when opening the palette. */
export type CommandPaletteTargetPage = "new-thread" | "project-chats" | "add-project" | "clone-github"

/**
 * One level of the palette's page stack. Browse pages each carry the
 * directory they show, so nested folder navigation is plain stack
 * pushes/pops (Backspace/Escape = up one level).
 */
export const StackEntry = Schema.Struct({
  page: PalettePage,
  /** Only for `page === "browse"`: the directory this level lists (null = home). */
  browsePath: Schema.NullOr(Schema.String),
  /**
   * What was typed on the page underneath when this one was pushed. Popping
   * puts it back, so going back lands on the search that led here.
   */
  returnQuery: Schema.NullOr(Schema.String),
})
export type StackEntry = typeof StackEntry.Type

/** State of an in-flight (or failed) clone driven from the palette. */
export const CloneRun = Schema.Struct({
  repo: opaque<RepoRef>("RepoRef"),
  destinationLabel: Schema.String,
  status: Schema.Literals(["cloning", "success", "error"]),
  error: Schema.NullOr(Schema.String),
})
export type CloneRun = typeof CloneRun.Type

/** useRepoMetadata's RepoMeta. */
export interface RepoMeta {
  fullName: string
  description: string | null
  stars: number
  language: string | null
  pushedAt: string | null
}

/**
 * useDirectoryBrowser: per-open cache and a stale response guard. The
 * palette drives navigation by pushing browse stack entries; this resolves
 * path → listing. Nothing persists across opens.
 */
export const Browser = Schema.Struct({
  dir: Schema.NullOr(opaque<FsListResult>("FsListResult")),
  loading: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  cache: Schema.Record(Schema.String, opaque<FsListResult>("FsListResult")),
  /** Bumped per request and on reset: an answer for an older one is dropped. */
  seq: Schema.Number,
})
export type Browser = typeof Browser.Type

export const initialBrowser: Browser = { dir: null, loading: false, error: null, cache: {}, seq: 0 }

/** useRepoMetadata: debounced GitHub metadata for a typed repo. */
export const RepoMetadata = Schema.Struct({
  /** `owner/repo` being looked up (the hook's keyRef), or null. */
  key: Schema.NullOr(Schema.String),
  meta: Schema.NullOr(opaque<RepoMeta>("RepoMeta")),
  loading: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  cache: Schema.Record(Schema.String, opaque<RepoMeta>("RepoMeta")),
  /** Bumped per (re)run of the hook's effect, so a cleared timer's fetch is dropped. */
  seq: Schema.Number,
  /** What the hook's effect last ran for: enabled, the repo, and the memo inputs that rebuilt it. */
  inputs: Schema.String,
})
export type RepoMetadata = typeof RepoMetadata.Type

export const initialRepoMetadata: RepoMetadata = { key: null, meta: null, loading: false, error: null, cache: {}, seq: 0, inputs: "" }

export const Phase = Schema.Literals(["Closed", "Open", "Closing"])
export type Phase = typeof Phase.Type

/** What a pending project request (`state.handleCreateProject`) was for. */
export const ProjectRequestKind = Schema.Literals(["action", "clone"])

export const Model = Schema.Struct({
  /** The dialog: open, or still on screen while its exit animation runs. */
  phase: Phase,
  /** Bumped per open and close, so a stale exit-animation end is dropped. */
  version: Schema.Number,
  pages: Schema.Array(StackEntry),
  query: Schema.String,
  /** cmdk's highlighted item value, controlled so the footer can react to it. */
  selectedValue: Schema.String,
  /**
   * Reference time for relative age labels ("4h", "6w"), snapped on open:
   * the palette is transient, so a per-open snapshot stays accurate enough.
   */
  nowMs: Schema.Number,
  /**
   * Which project the "Chats in <project>" sub-page browses. Null falls back
   * to the active project (the sidebar's openCommandPalette("project-chats")).
   */
  projectChatsTargetId: Schema.NullOr(Schema.String),
  /** Add Project: in-flight clone (locks the palette). */
  cloneRun: Schema.NullOr(CloneRun),
  /** A busy row value (spinner + double-run guard) and its inline error for open/create rows. */
  pendingActionValue: Schema.NullOr(Schema.String),
  actionError: Schema.NullOr(Schema.String),
  /** Which of the two waits on the root's project request (startingLocalPath), if any. */
  projectRequest: Schema.NullOr(ProjectRequestKind),
  /** Bumped per clone, so the success flash's close is for this clone. */
  cloneSeq: Schema.Number,
  /** Clone page: recent repos from the signed-in `gh` account. Kept across opens. */
  githubRepos: Schema.NullOr(opaque<GitHubRecentReposResult>("GitHubRecentReposResult")),
  githubReposLoading: Schema.Boolean,
  githubReposSeq: Schema.Number,
  /** Create page: lowercase entry names inside the new-projects directory. Null while loading. */
  createDirNames: Schema.NullOr(Schema.Array(Schema.String)),
  createDirSeq: Schema.Number,
  browser: Browser,
  repoMetadata: RepoMetadata,
  /** This Mac's switches (Kanna for Mac on its own server only), or null. */
  mac: Schema.NullOr(opaque<MacSetupState>("MacSetupState")),
  /** The phone layout, where the sidebar is a page and not a column (`(max-width: 767px)`). */
  phoneLayout: Schema.Boolean,
  /** The keybindings snapshot, mirrored for the global shortcut's listener (observe). */
  keybindings: Schema.NullOr(opaque<KeybindingsSnapshot>("KeybindingsSnapshot")),
  /** The Usage… page's UsageSection. */
  usage: Usage.Model,
  /** The New Delegator prompt (createDelegator's dialog.prompt / alert). */
  dialog: AppDialog.Model,
  /** The project a New Delegator prompt is for, by its request id. */
  delegatorRequest: Schema.NullOr(Schema.Struct({ requestId: Schema.String, projectId: Schema.String })),
  dialogSeq: Schema.Number,
})
export type Model = typeof Model.Type

export function init(): Model {
  return {
    phase: "Closed",
    version: 0,
    pages: [],
    query: "",
    selectedValue: "",
    nowMs: 0,
    projectChatsTargetId: null,
    cloneRun: null,
    pendingActionValue: null,
    actionError: null,
    projectRequest: null,
    cloneSeq: 0,
    githubRepos: null,
    githubReposLoading: false,
    githubReposSeq: 0,
    createDirNames: null,
    createDirSeq: 0,
    browser: initialBrowser,
    repoMetadata: initialRepoMetadata,
    mac: null,
    phoneLayout: false,
    keybindings: null,
    usage: Usage.init(),
    dialog: AppDialog.init(),
    delegatorRequest: null,
    dialogSeq: 0,
  }
}

export const isOpen = (model: Model) => model.phase === "Open"

/** The page on top of the stack. */
export function topEntry(model: Model): StackEntry | null {
  return model.pages.length > 0 ? model.pages[model.pages.length - 1]! : null
}

export function currentPage(model: Model): PalettePage | "root" {
  return topEntry(model)?.page ?? "root"
}

/** Distinguishes browse→browse pushes (same page string, different dir). */
export function pageKey(model: Model): string {
  const top = topEntry(model)
  return `${top?.page ?? "root"}:${top?.browsePath ?? ""}`
}

/** While a clone runs (or flashes success) the palette is locked: no close, no Escape, no pops. */
export function isLocked(model: Model): boolean {
  return model.cloneRun !== null && model.cloneRun.status !== "error"
}
