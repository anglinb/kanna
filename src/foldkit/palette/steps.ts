import { Number } from "effect"
import type { Command } from "foldkit"
import { modifyFields } from "foldkit/struct"
import type { ProjectRequest } from "../../client/app/kannaStateHelpers"
import { formatPathWithTilde } from "../../client/lib/pathUtils"
import { resolveCloneDestination, type RepoRef } from "../../client/lib/project-fs"
import { DEFAULT_NEW_PROJECTS_DIRECTORY } from "../../shared/types"
import { AppAction, batch } from "../app/action"
import { SliceOutMessage, type AppModel, type SliceReturn } from "../app/slice"
import type { KannaSocketService } from "../core/socket"
import { WaitForExitAnimation } from "./commands"
import { appSettings } from "./context"
import type { Message } from "./message"
import { initialBrowser, initialRepoMetadata, type Model, type PalettePage, type StackEntry } from "./model"

// The palette's state changes that more than one Message makes: opening,
// closing, the page stack, and the project requests (CommandPalette's
// openPalette, close, pushPage, popPage, runProjectAction, runClone,
// startClone).

export type Return = SliceReturn<Model, Message>
type PaletteCommand = Command.Command<Message, never, KannaSocketService>

/** Adds an AppAction to a step's result, after any it already asks for. */
export function withAction(result: Return, action: AppAction | null): Return {
  if (!action) return result
  const existing = result.outMessage?.action
  return { ...result, outMessage: SliceOutMessage.RequestedAppAction({ action: existing ? batch(existing, action) : action }) }
}

export function withCommands(result: Return, ...commands: PaletteCommand[]): Return {
  return { ...result, commands: [...(result.commands ?? []), ...commands] }
}

/** `openPalette(initialPage)`: a fresh palette, on a page or at the root. */
export function openPalette(model: Model, initialPage: PalettePage | null, at: number): Model {
  const entry = (page: PalettePage): StackEntry => ({ page, browsePath: null, returnQuery: null })
  return {
    ...model,
    phase: "Open",
    version: model.phase === "Open" ? model.version : Number.increment(model.version),
    // Deep-linking to the Clone page seeds Add Project underneath so
    // Backspace/Escape walk back through the same stack as manual navigation.
    pages: initialPage === "clone-github"
      ? [entry("add-project"), entry("clone-github")]
      : initialPage ? [entry(initialPage)] : [],
    query: "",
    selectedValue: "",
    nowMs: at,
    projectChatsTargetId: null,
    cloneRun: null,
    pendingActionValue: null,
    actionError: null,
    projectRequest: null,
    // browser.reset(): nothing persists across opens.
    browser: { ...initialBrowser, seq: Number.increment(model.browser.seq) },
    repoMetadata: { ...initialRepoMetadata, cache: model.repoMetadata.cache, seq: Number.increment(model.repoMetadata.seq) },
  }
}

/** `setOpen(false)`: the content stays up, `data-state="closed"`, while it animates out. */
export function closePalette(model: Model): Return {
  if (model.phase !== "Open") return { model }
  const version = Number.increment(model.version)
  return {
    model: modifyFields(model, { phase: () => "Closing" as const, version: () => version }),
    commands: [WaitForExitAnimation({ version })],
  }
}

/** Close, then ask the root for `action` (most rows' `close(); state.handleX(...)`). */
export function closeWith(model: Model, action: AppAction | null): Return {
  return withAction(closePalette(model), action)
}

/** `pushPage`: what was typed comes back on the way back. */
export function pushPage(model: Model, page: PalettePage, browsePath: string | null = null): Model {
  return {
    ...model,
    pages: [...model.pages, { page, browsePath, returnQuery: model.query }],
    query: "",
    actionError: null,
  }
}

/** `popPage`. */
export function popPage(model: Model): Model {
  const top = model.pages[model.pages.length - 1]
  return {
    ...model,
    pages: model.pages.slice(0, -1),
    query: top?.returnQuery ?? "",
    actionError: null,
  }
}

export function newProjectsDir(app: AppModel): string {
  return appSettings(app)?.newProjectsDirectory ?? DEFAULT_NEW_PROJECTS_DIRECTORY
}

/**
 * Open/create a project (and start a chat in it) from a palette row. The row
 * shows a spinner while pending; a failure renders inline instead of closing
 * the palette (see `observe`, which hears how the root's request ended).
 */
export function runProjectAction(model: Model, value: string, project: ProjectRequest): Return {
  if (model.pendingActionValue !== null) return { model }
  return {
    model: { ...model, pendingActionValue: value, actionError: null, projectRequest: "action" },
    outMessage: SliceOutMessage.RequestedAppAction({ action: AppAction.CreateProject({ project }) }),
  }
}

/** Clone into the configured new-projects directory, locking the palette while it runs. */
export function runClone(model: Model, app: AppModel, repo: RepoRef): Return {
  const destination = resolveCloneDestination(newProjectsDir(app), repo)
  const destinationLabel = formatPathWithTilde(destination.localPath)
  return {
    model: {
      ...model,
      cloneRun: { repo, destinationLabel, status: "cloning", error: null },
      projectRequest: "clone",
      cloneSeq: Number.increment(model.cloneSeq),
    },
    outMessage: SliceOutMessage.RequestedAppAction({
      action: AppAction.CreateProject({
        project: {
          mode: "clone",
          localPath: destination.localPath,
          fallbackPath: destination.fallbackPath,
          title: destination.title,
          cloneUrl: repo.cloneUrl,
        },
      }),
    }),
  }
}

/**
 * Entry point for every "Clone owner/repo" row (root, Add Project page): jump
 * to the Clone page and start at once, so all clone progress and error UI
 * lives in one place.
 */
export function startClone(model: Model, app: AppModel, repo: RepoRef): Return {
  const top = model.pages[model.pages.length - 1]
  const pages = top?.page === "clone-github"
    ? model.pages
    : [...model.pages, { page: "clone-github" as const, browsePath: null, returnQuery: model.query }]
  return runClone({ ...model, pages, query: `${repo.owner}/${repo.repo}`, actionError: null }, app, repo)
}
