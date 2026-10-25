import { Number, Option } from "effect"
import { Command } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { AppAction } from "../app/action"
import { requestAction, type AppModel, type SliceObserve } from "../app/slice"
import * as Stores from "../app/stores"
import * as TerminalLayout from "../core/stores/terminalLayout"
import { effectiveSelection, findItem, navigate as navigateSelection } from "./cmdk"
import * as Commands from "./commands"
import { derive, type PaletteData } from "./derive"
import { Message } from "./message"
import { currentPage, isLocked, pageKey, PAGES, type Model, type PalettePage } from "./model"
import * as Usage from "./usage"
import { closePalette, closeWith, newProjectsDir, openPalette, popPage, pushPage, withCommands, type Return } from "./steps"

// CommandPalette's handlers and effects. Each Message is handled, then
// `afterChange` runs what React ran in effects keyed on what changed: the
// selection reset (open, page, query, a browse listing landing), and each
// page's fetch on entry.

const asPage = (page: string | null): PalettePage | null =>
  page !== null && (PAGES as ReadonlyArray<string>).includes(page) ? page as PalettePage : null

/** `openPalette()` from the shortcut or an open request. */
function open(model: Model, page: PalettePage | null, at: number): Return {
  return { model: openPalette(model, page, at), commands: [Commands.RefreshMacSetup()] }
}

const toUsageMessage = (message: Usage.Message) => Message.GotUsageMessage({ message })

/**
 * useDirectoryBrowser's `load` for the browse page on top: a cache hit
 * renders at once (and supersedes any request in flight), else a request.
 */
function loadBrowseDirectory(model: Model): Return {
  const top = model.pages[model.pages.length - 1]
  const target = top?.page === "browse" ? top.browsePath : null
  const seq = Number.increment(model.browser.seq)
  const cached = target !== null ? model.browser.cache[target] : undefined
  if (cached) return { model: { ...model, browser: { ...model.browser, seq, error: null, loading: false, dir: cached } } }
  return {
    model: { ...model, browser: { ...model.browser, seq, error: null, loading: true } },
    commands: [Commands.LoadDirectory({ seq, path: target })],
  }
}

/** useRepoMetadata's effect, run again: the repo (or whether it is enabled) changed. */
function runRepoMetadata(model: Model, repo: { host: string; owner: string; repo: string } | null, enabled: boolean, inputs: string): Return {
  const metadata = model.repoMetadata
  const seq = Number.increment(metadata.seq)
  if (!enabled || !repo || repo.host !== "github.com") {
    return { model: { ...model, repoMetadata: { ...metadata, seq, inputs, key: null, meta: null, error: null, loading: false } } }
  }
  const key = `${repo.owner}/${repo.repo}`
  const cached = metadata.cache[key]
  if (cached) return { model: { ...model, repoMetadata: { ...metadata, seq, inputs, key, meta: cached, error: null, loading: false } } }
  return {
    model: { ...model, repoMetadata: { ...metadata, seq, inputs, key, meta: null, error: null, loading: true } },
    commands: [Commands.WaitRepoMetaDebounce({ seq, key })],
  }
}

const browseDirPath = (model: Model) => (currentPage(model) === "browse" ? model.browser.dir?.path ?? null : null)

/** What React ran in effects after the render this change caused. */
function afterChange(previous: Model, result: Return, app: AppModel, discrete: boolean): Return {
  let next = result
  const model = () => next.model
  const wasOpen = previous.phase === "Open"
  const isOpenNow = model().phase === "Open"
  const commands = (...list: Array<NonNullable<Return["commands"]>[number]>) => {
    next = { ...next, commands: [...(next.commands ?? []), ...list] }
  }

  // The Clone page fetches the signed-in user's recent repos on entry; leaving
  // drops the answer (the effect's `cancelled`).
  const onClone = (candidate: Model, open: boolean) => open && currentPage(candidate) === "clone-github"
  if (onClone(model(), isOpenNow) !== onClone(previous, wasOpen)) {
    const seq = Number.increment(model().githubReposSeq)
    if (onClone(model(), isOpenNow)) {
      next = { ...next, model: { ...model(), githubReposSeq: seq, githubReposLoading: true } }
      commands(Commands.FetchGithubRepos({ seq }))
    } else {
      next = { ...next, model: { ...model(), githubReposSeq: seq } }
    }
  }

  // The Create page lists the new-projects directory for the "already exists" flip.
  const onCreate = (candidate: Model, open: boolean) => open && currentPage(candidate) === "create-new"
  if (onCreate(model(), isOpenNow) !== onCreate(previous, wasOpen)) {
    const seq = Number.increment(model().createDirSeq)
    if (onCreate(model(), isOpenNow)) {
      next = { ...next, model: { ...model(), createDirSeq: seq, createDirNames: null } }
      commands(Commands.ListCreateDir({ seq, path: newProjectsDir(app) }))
    } else {
      next = { ...next, model: { ...model(), createDirSeq: seq } }
    }
  }

  // The Usage… page's UsageSection mounts and unmounts with the page.
  const onUsage = (candidate: Model, open: boolean) => open && currentPage(candidate) === "usage"
  if (onUsage(model(), isOpenNow) !== onUsage(previous, wasOpen)) {
    if (onUsage(model(), isOpenNow)) {
      const mounted = Usage.mounted()
      next = { ...next, model: { ...model(), usage: mounted.model } }
      commands(...Command.mapMessages(mounted.commands, toUsageMessage))
    } else {
      next = { ...next, model: { ...model(), usage: Usage.unmounted() } }
    }
  }

  // Browse pages resolve their stack entry's directory.
  if (isOpenNow && currentPage(model()) === "browse" && (!wasOpen || pageKey(previous) !== pageKey(model()))) {
    const loaded = loadBrowseDirectory(model())
    next = { ...next, model: loaded.model }
    commands(...(loaded.commands ?? []))
  }

  // useRepoMetadata's effect, keyed on the typed repo and whether it's enabled.
  if (isOpenNow) {
    const effects = derive(model(), app).effects
    const inputs = `${effects.typedRepoEnabled}\u0000${effects.typedRepo ? `${effects.typedRepo.host}/${effects.typedRepo.owner}/${effects.typedRepo.repo}` : ""}\u0000${effects.typedRepoInputs}`
    if (inputs !== model().repoMetadata.inputs) {
      const ran = runRepoMetadata(model(), effects.typedRepo, effects.typedRepoEnabled, inputs)
      next = { ...next, model: ran.model }
      commands(...(ran.commands ?? []))
    }
  }

  // On open, page change, every query change, and a browse listing landing:
  // the selection snaps to the first result and the list to the top.
  if (isOpenNow && (
    !wasOpen
    || pageKey(previous) !== pageKey(model())
    || previous.query !== model().query
    || browseDirPath(previous) !== browseDirPath(model())
  )) {
    const data = derive(model(), app)
    // cmdk re-selects its first enabled row when the highlighted one
    // unmounts, a render later. After user input React has already run the
    // palette's reset effect by then, so cmdk's pick wins; after an
    // asynchronous result (a listing landing) the effect runs last and wins.
    const unmounted = discrete && wasOpen && selectedRowUnmounted(previous, model(), data, app)
    next = { ...next, model: { ...model(), selectedValue: unmounted ? effectiveSelection(data.nodes, "") : data.firstResultValue } }
    commands(Commands.ResetListScroll())
  }
  return next
}

/** A row's React identity: its page (each renders in its own place), its group's key and its own value. */
function rowIdentities(model: Model, nodes: PaletteData["nodes"]): Map<string, string> {
  const identities = new Map<string, string>()
  const page = currentPage(model)
  for (const node of nodes) {
    if (node.kind !== "group") continue
    for (const child of node.children) {
      if (child.kind === "item") identities.set(child.value, `${page}\u0000${node.key}\u0000${child.value}`)
    }
  }
  return identities
}

/** Whether the row highlighted before this change is gone from the list after it. */
function selectedRowUnmounted(previous: Model, current: Model, data: PaletteData, app: AppModel): boolean {
  const before = derive(previous, app)
  if (!before.selected) return false
  const identity = rowIdentities(previous, before.nodes).get(before.selected)
  if (!identity) return false
  return ![...rowIdentities(current, data.nodes).values()].includes(identity)
}

/** User input (a key, a click, typing), as against a result arriving: React renders the first synchronously. */
function isDiscrete(message: Message): boolean {
  switch (message._tag) {
    case "PressedPaletteShortcut":
    case "DismissedPalette":
    case "ChangedQuery":
    case "PressedNavigationKey":
    case "PressedEnter":
    case "HoveredItem":
    case "ClickedItem":
    case "ClickedBack":
    case "PressedBackKey":
    case "PressedCopyShortcut":
    case "ClickedBrowseFooter":
      return true
    default:
      return false
  }
}

export function update(model: Model, message: Message, app: AppModel): Return {
  return afterChange(model, handle(model, message, app), app, isDiscrete(message))
}

function handle(model: Model, message: Message, app: AppModel): Return {
  return Message.match<Return>(message, {
    PressedPaletteShortcut: ({ at }) => {
      if (model.phase !== "Open") return open(model, null, at)
      return isLocked(model) ? { model } : closePalette(model)
    },
    ReceivedOpenRequest: ({ page, at }) => open(model, asPage(page), at),
    DismissedPalette: () => (isLocked(model) ? { model } : closePalette(model)),
    CompletedExitAnimation: ({ version }) =>
      version === model.version && model.phase === "Closing"
        ? { model: modifyFields(model, { phase: () => "Closed" as const }) }
        : { model },
    CompletedMountContent: () => ({ model }),
    CompletedMountRoot: () => ({ model }),

    ChangedQuery: ({ value }) => ({
      model: {
        ...model,
        query: value,
        // Typing clears inline failures so the list comes back.
        cloneRun: model.cloneRun?.status === "error" ? null : model.cloneRun,
        actionError: null,
      },
    }),
    PressedNavigationKey: (keys) => {
      const data = derive(model, app)
      return Option.match(navigateSelection(data.nodes, data.selected, keys), {
        onNone: () => ({ model }),
        onSome: (value) => value === data.selected
          ? { model }
          : { model: { ...model, selectedValue: value }, commands: [Commands.ScrollSelectedIntoView()] },
      })
    },
    PressedEnter: ({ withModifier }) => {
      const data = derive(model, app)
      if (withModifier && data.footerBrowseTarget) return data.runBrowseTarget(data.footerBrowseTarget)
      return choose(model, data, data.selected, true)
    },
    HoveredItem: ({ value }) => {
      if (value === derive(model, app).selected) return { model }
      return { model: { ...model, selectedValue: value }, commands: [Commands.FocusInputAfterSelect()] }
    },
    ClickedItem: ({ value }) => choose(model, derive(model, app), value, false),

    ClickedBack: () => (model.pages.length > 0 && !isLocked(model) ? { model: popPage(model) } : { model }),
    PressedBackKey: () => (model.pages.length > 0 && !isLocked(model) ? { model: popPage(model) } : { model }),
    PressedCopyShortcut: () => {
      const path = derive(model, app).footerCopyPath
      return path ? closeWith(model, AppAction.CopyPath({ localPath: path })) : { model }
    },
    ClickedBrowseFooter: () => {
      const data = derive(model, app)
      return data.footerBrowseTarget ? data.runBrowseTarget(data.footerBrowseTarget) : { model }
    },

    ReceivedGithubRepos: ({ seq, result }) => seq === model.githubReposSeq
      ? { model: { ...model, githubRepos: result, githubReposLoading: false } }
      : { model },
    ReceivedCreateDirNames: ({ seq, names }) => seq === model.createDirSeq
      ? { model: { ...model, createDirNames: names } }
      : { model },
    ReceivedDirectory: ({ seq, result }) => {
      const cache = { ...model.browser.cache, [result.path]: result }
      if (seq !== model.browser.seq) return { model: { ...model, browser: { ...model.browser, cache } } }
      return { model: { ...model, browser: { ...model.browser, cache, dir: result, loading: false } } }
    },
    FailedDirectory: ({ seq, error }) => seq === model.browser.seq
      ? { model: { ...model, browser: { ...model.browser, error, loading: false } } }
      : { model },
    ReceivedJump: ({ seq, result }) => {
      // The cache entry is stored clean: a nearest fallback is view state,
      // not a fact about the ancestor.
      const cache = { ...model.browser.cache, [result.path]: { ...result, missingSuffix: undefined } }
      const browser = { ...model.browser, cache, loading: seq === model.browser.seq ? false : model.browser.loading }
      if (model.phase !== "Open") return { model: { ...model, browser } }
      const pushed = pushPage({ ...model, browser }, "browse", result.path)
      return { model: result.missingSuffix ? { ...pushed, query: result.missingSuffix } : pushed }
    },
    FailedJump: ({ seq, error }) => seq === model.browser.seq
      ? { model: { ...model, browser: { ...model.browser, error, loading: false } } }
      : { model },
    ElapsedRepoMetaDebounce: ({ seq, key }) => seq === model.repoMetadata.seq && key === model.repoMetadata.key
      ? { model, commands: [Commands.FetchRepoMeta({ key })] }
      : { model },
    ReceivedRepoMeta: ({ key, meta }) => {
      const metadata = { ...model.repoMetadata, cache: { ...model.repoMetadata.cache, [key]: meta } }
      return {
        model: { ...model, repoMetadata: metadata.key === key ? { ...metadata, meta, loading: false } : metadata },
      }
    },
    FailedRepoMeta: ({ key, error }) => model.repoMetadata.key === key
      ? { model: { ...model, repoMetadata: { ...model.repoMetadata, error, loading: false } } }
      : { model },
    ElapsedCloneSuccess: ({ cloneSeq }) => cloneSeq === model.cloneSeq && model.cloneRun?.status === "success"
      ? closePalette({ ...model, cloneRun: null })
      : { model },
    ReceivedMacSetup: ({ state }) => ({ model: { ...model, mac: state } }),
    ChangedPhoneLayout: ({ phone }) => ({ model: { ...model, phoneLayout: phone } }),
    ReceivedNotificationPermission: ({ preference }) =>
      requestAction(model, AppAction.WriteAppSettings({ patch: { chatBrowserNotificationPreference: preference } })),
    GeneratedTerminalId: ({ projectId, terminalId, chatKey }) => requestAction(model, AppAction.Store({
      message: Stores.Message.GotTerminalLayoutMessage({
        message: TerminalLayout.Message.AddedTerminal({ projectId, terminalId, afterTerminalId: null, chatKey }),
      }),
    })),

    GotUsageMessage: ({ message: child }) => {
      const result = Usage.update(model.usage, child)
      return { model: { ...model, usage: result.model }, commands: Command.mapMessages(result.commands, toUsageMessage) }
    },
    CompletedSideEffect: () => ({ model }),
  })
}

/** cmdk's item select: the row becomes the value (without a scroll), then its onSelect runs. */
function choose(model: Model, data: ReturnType<typeof derive>, value: string, byKey: boolean): Return {
  const chosen = value ? findItem(data.nodes, value) : undefined
  if (!chosen || chosen.disabled || !chosen.run) return { model }
  // `run` closes over the Model it was derived from; the selection rides along.
  const result = chosen.run(byKey)
  return result.model.selectedValue === value ? result : { ...result, model: { ...result.model, selectedValue: value } }
}

/**
 * Open the palette, optionally on a page (React's `kanna:open-command-palette`
 * window event, now `AppAction.OpenCommandPalette`). The root calls this.
 */
export function requestOpen(model: Model, page: string | null, _app: AppModel): Return {
  return { model, commands: [Commands.OpenAt({ page })] }
}

/**
 * What the palette hears of the root: the keybindings (for the shortcut's
 * listener), and how its project request ended. React awaited
 * `state.handleCreateProject`; here the root's `startingLocalPath` going back
 * to null is the end, and `projectRequestError` says whether it failed.
 */
export const observe: SliceObserve<Model, Message> = (model, previousApp, app) => {
  let next = model
  const commands: Array<NonNullable<Return["commands"]>[number]> = []
  if (app.keybindings !== model.keybindings) next = { ...next, keybindings: app.keybindings }
  const settled = previousApp.actions.startingLocalPath !== null && app.actions.startingLocalPath === null
  if (next.projectRequest && settled) {
    const error = app.actions.projectRequestError
    if (next.projectRequest === "action") {
      next = { ...next, projectRequest: null, pendingActionValue: null }
      if (error) next = { ...next, actionError: error }
      else {
        const closed = closePalette(next)
        next = closed.model
        commands.push(...(closed.commands ?? []))
      }
    } else if (next.cloneRun) {
      next = error
        ? { ...next, projectRequest: null, cloneRun: { ...next.cloneRun, status: "error", error } }
        : { ...next, projectRequest: null, cloneRun: { ...next.cloneRun, status: "success", error: null } }
      // Navigation to the new chat already happened; flash the ✓ then close.
      if (!error) commands.push(Commands.WaitCloneSuccess({ cloneSeq: next.cloneSeq }))
    }
  }
  if (next === model) return { model }
  return withCommands({ model: next }, ...commands)
}
