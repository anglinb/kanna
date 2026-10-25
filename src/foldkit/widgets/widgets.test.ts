import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { fromString } from "foldkit/url"
import type { ChatBranchListResult, ChatDiffFile, ChatDiffSnapshot } from "../../shared/types"
import type { AppAction } from "../app/action"
import type { Flags, Model as AppModel } from "../app/model"
import * as Stores from "../app/stores"
import { init as initApp } from "../app/update"
import { memoryStorage } from "../core/stores/testing"
import * as AppDialog from "../ui/app-dialog"
import * as ContextMenu from "../ui/context-menu"
import {
  branchCreateOptions,
  filterFilesByQuery,
  getPrimaryCommitActionPrefix,
  peekPatch,
  pickerState,
  sortByPath,
  summarizeChanges,
} from "./gitLogic"
import { Message } from "./message"
import { init, type Model, type Watch } from "./model"
import { update } from "./update"

// The widget column's update: what it sends and asks the root for as the
// column opens, as a commit is written and made, as the branch picker is
// driven by keys, as a file's menu discards it, as quick actions are added
// and run, and as a task is stopped. Plus the git widgets' pure parts.

function file(path: string, extra: Partial<ChatDiffFile> = {}): ChatDiffFile {
  return { path, changeType: "modified", isUntracked: false, additions: 2, deletions: 1, patchDigest: `d-${path}`, ...extra }
}

const DIFFS: ChatDiffSnapshot = {
  status: "ready",
  branchName: "main",
  defaultBranchName: "main",
  hasOriginRemote: true,
  hasUpstream: true,
  originRepoSlug: "you/tidepool",
  aheadCount: 0,
  behindCount: 0,
  files: [file("src/lib/units.ts"), file("src/lib/units.test.ts", { changeType: "added", isUntracked: true })],
  branchHistory: { entries: [] },
}

function boot(options: { diffs?: ChatDiffSnapshot; summary?: string } = {}): AppModel {
  const flags: Flags = { sidebarCollapsed: false, systemTheme: "dark", initialAppSettings: null, stores: Stores.load(memoryStorage()) }
  const app = initApp(flags, Option.getOrThrow(fromString("http://localhost/chat/c1"))).model
  const projectUi: AppModel["stores"]["rightSidebar"]["projectUi"] = options.summary ? { p1: { expanded: {}, summary: options.summary, description: "" } } : {}
  return {
    ...app,
    projectDiffs: { p1: options.diffs ?? DIFFS },
    stores: { ...app.stores, rightSidebar: { ...app.stores.rightSidebar, projectUi } },
  }
}

const WATCH: Watch = {
  projectId: "p1",
  chatId: "c1",
  active: true,
  isMobile: false,
  widgetsChatKey: "c1",
  filesKey: "2:x",
  reviewedPath: null,
  clockMs: null,
}

function opened(app: AppModel, watch: Watch = WATCH): Model {
  return update(init(), Message.ObservedPage({ watch, paths: (app.projectDiffs.p1?.files ?? []).map((entry) => entry.path) }), app).model
}

const names = (result: { commands?: ReadonlyArray<{ name: string }> }) => (result.commands ?? []).map((command) => command.name)
const argsOf = (result: { commands?: ReadonlyArray<{ name: string; args?: unknown }> }, name: string) =>
  (result.commands ?? []).find((command) => command.name === name)?.args as Record<string, unknown> | undefined

/** The store Message a result asks the root for, by its inner tag; a Batch lists each. */
function storeTags(result: { outMessage?: { action: AppAction } }): string[] {
  const action = result.outMessage?.action
  if (!action) return []
  const actions = action._tag === "Batch" ? (action.actions as AppAction[]) : [action]
  return actions.map((entry) => {
    if (entry._tag !== "Store") return entry._tag
    const inner = (entry.message as { message?: { _tag: string } }).message
    return inner?._tag ?? entry._tag
  })
}

describe("widgets: the column opening", () => {
  test("the first look reconciles the commit selection and reads the ports", () => {
    const app = boot()
    const result = update(init(), Message.ObservedPage({ watch: WATCH, paths: ["src/lib/units.ts", "src/lib/units.test.ts"] }), app)
    expect(storeTags(result)).toEqual(["ReconciledProject"])
    expect(names(result)).toEqual(["WidgetsListPorts"])
    expect(result.model.git.commitEditorOpen).toBe(false)
  })

  test("a closed column reads no ports; opening it does, once", () => {
    const app = boot()
    const closed = update(init(), Message.ObservedPage({ watch: { ...WATCH, active: false }, paths: [] }), app)
    expect(names(closed)).toEqual([])
    const open = update(closed.model, Message.ObservedPage({ watch: WATCH, paths: [] }), app)
    expect(names(open)).toEqual(["WidgetsListPorts"])
    const again = update(open.model, Message.ObservedPage({ watch: { ...WATCH, reviewedPath: "x" }, paths: [] }), app)
    expect(names(again)).not.toContain("WidgetsListPorts")
  })

  test("a draft already written starts the commit message fields open", () => {
    const app = boot({ summary: "Half a thought" })
    expect(opened(app).git.commitEditorOpen).toBe(true)
  })

  test("another chat drops the stops pending on the last one", () => {
    const app = boot()
    const model = { ...opened(app), stopping: ["t1"], stopError: "nope" }
    const next = update(model, Message.ObservedPage({ watch: { ...WATCH, chatId: "c2" }, paths: [] }), app).model
    expect(next.stopping).toEqual([])
    expect(next.stopError).toBeNull()
  })
})

describe("widgets: committing", () => {
  test("with a message written, the button commits the checked files and pushes", () => {
    const app = boot({ summary: "Switch wave heights to meters" })
    const result = update(opened(app), Message.ClickedCommit(), app)
    expect(names(result)).toEqual(["WidgetsCommitDiffs"])
    expect(argsOf(result, "WidgetsCommitDiffs")).toMatchObject({
      projectId: "p1",
      paths: ["src/lib/units.ts", "src/lib/units.test.ts"],
      summary: "Switch wave heights to meters",
      mode: "commit_and_push",
    })
    expect(result.model.git.commitModeInFlight).toBe("commit_and_push")
  })

  test("without one, it drafts a message, then commits with it", () => {
    const app = boot()
    const generating = update(opened(app), Message.ClickedCommit(), app)
    expect(names(generating)).toEqual(["WidgetsGenerateCommitMessage"])
    expect(generating.model.git.isGenerating).toBe(true)
    const drafted = update(generating.model, Message.SucceededGenerateMessage({ subject: "Add units", body: "Body", thenCommit: "commit_and_push" }), app)
    expect(storeTags(drafted)).toEqual(["ChangedCommitDraft"])
    expect(names(drafted)).toEqual(["WidgetsCommitDiffs"])
    expect(drafted.model.git.isGeneratedCommitInFlight).toBe(true)
  })

  test("a commit that lands clears the draft and reads the diffs again", () => {
    const app = boot({ summary: "Done" })
    const committing = update(opened(app), Message.ClickedCommit(), app).model
    const done = update(committing, Message.SucceededCommit({ result: { ok: true, mode: "commit_and_push", pushed: true, snapshotChanged: true } }), app)
    expect(storeTags(done)).toEqual(["ClearedCommitDraft"])
    expect(names(done)).toEqual(["WidgetsRefreshDiffs"])
    expect(done.model.git.commitModeInFlight).toBeNull()
  })

  test("a commit that fails says why in the column's alert", () => {
    const app = boot({ summary: "Done" })
    const committing = update(opened(app), Message.ClickedCommit(), app).model
    const failed = update(committing, Message.FailedCommit({ error: "nothing to commit" }), app)
    expect(Option.getOrNull(failed.model.appDialog.request)).toMatchObject({ _tag: "Alert", title: "Commit failed", description: "nothing to commit" })
  })

  test("Cmd+Enter in the message field does what the button does", () => {
    const app = boot({ summary: "Done" })
    expect(names(update(opened(app), Message.PressedCommitShortcut(), app))).toEqual(["WidgetsCommitDiffs"])
  })
})

const BRANCHES: ChatBranchListResult = {
  currentBranchName: "main",
  defaultBranchName: "main",
  recent: [{ id: "local:docs", kind: "local", name: "docs", displayName: "docs" }],
  local: [{ id: "local:docs", kind: "local", name: "docs", displayName: "docs" }, { id: "local:main", kind: "local", name: "main", displayName: "main" }],
  remote: [],
  pullRequests: [],
  pullRequestsStatus: "unavailable",
}

describe("widgets: the branch picker", () => {
  function openPicker(app: AppModel) {
    const toggled = update(opened(app), Message.ToggledBranches(), app)
    const token = toggled.model.git.picker.token
    return update(toggled.model, Message.SucceededListBranches({ token, result: BRANCHES }), app).model
  }

  test("opening it lists the branches and focuses its search", () => {
    const app = boot()
    const toggled = update(opened(app), Message.ToggledBranches(), app)
    expect(names(toggled)).toEqual(["WidgetsListBranches", "WidgetsFocusById"])
    expect(toggled.model.git.branchesExpanded).toBe(true)
    expect(toggled.model.git.picker.isLoading).toBe(true)
  })

  test("↓ moves the cursor onto the first row; Enter on a dirty tree asks to bring the changes", () => {
    const app = boot()
    const down = update(openPicker(app), Message.PressedPickerKey({ key: "ArrowDown" }), app)
    expect(down.model.git.picker.mode).toBe("keyboard")
    expect(down.model.git.picker.keyboardActiveId).toBe("widgets-branch-picker-local:docs")
    const enter = update(down.model, Message.PressedPickerKey({ key: "Enter" }), app)
    expect(Option.getOrNull(enter.model.appDialog.request)).toMatchObject({ _tag: "Confirm", title: "Bring Changes?", confirmLabel: "Bring Changes" })
    const requestId = enter.model.pendingDialog!.requestId
    const answered = update(enter.model, Message.GotAppDialogMessage({ message: AppDialog.Message.ClickedConfirm() }), app)
    expect(answered.model.pendingDialog).toBeNull()
    expect(requestId).toBe("widgets-dialog-1")
    expect(argsOf(answered, "WidgetsCheckoutBranch")).toMatchObject({ chatId: "c1", bringChanges: true })
  })

  test("a search offers to create what it names, off the default branch", () => {
    const app = boot()
    const searched = update(openPicker(app), Message.ChangedPickerQuery({ value: "feature arrows" }), app).model
    const state = pickerState(searched.git.picker, "main")
    expect(state.createOptions).toEqual([{ name: "feature-arrows", baseBranchName: "main" }])
    const enter = update(searched, Message.PressedPickerKey({ key: "Enter" }), app)
    expect(argsOf(enter, "WidgetsCreateBranch")).toMatchObject({ name: "feature-arrows", baseBranchName: "main" })
  })

  test("Esc clears the search first, then closes the picker", () => {
    const app = boot()
    const searched = update(openPicker(app), Message.ChangedPickerQuery({ value: "doc" }), app).model
    const cleared = update(searched, Message.PressedPickerKey({ key: "Escape" }), app).model
    expect(cleared.git.picker.query).toBe("")
    expect(cleared.git.branchesExpanded).toBe(true)
    expect(update(cleared, Message.PressedPickerKey({ key: "Escape" }), app).model.git.branchesExpanded).toBe(false)
  })
})

describe("widgets: a changed file's menu", () => {
  function chooseOnFile(app: AppModel, path: string, value: string) {
    const target = { _tag: "DiffFile" as const, path }
    const menuOpen = update(opened(app), Message.RequestedMenu({ target }), app).model
    return update(menuOpen, Message.GotMenuMessage({ message: ContextMenu.Message.ChoseItem({ value }) }), app)
  }

  test("Discard asks first, then discards", () => {
    const app = boot()
    const asked = chooseOnFile(app, "src/lib/units.ts", "discard")
    expect(Option.getOrNull(asked.model.appDialog.request)).toMatchObject({ _tag: "Confirm", title: "Discard Changes", confirmLabel: "Discard" })
    const confirmed = update(asked.model, Message.GotAppDialogMessage({ message: AppDialog.Message.ClickedConfirm() }), app)
    expect(argsOf(confirmed, "WidgetsDiffFileAction")).toEqual({ kind: "discard", chatId: "c1", path: "src/lib/units.ts" })
  })

  test("Review opens the file's diff in the viewer", () => {
    const app = boot()
    expect(storeTags(chooseOnFile(app, "src/lib/units.ts", "review"))).toEqual(["OpenedItem"])
  })
})

describe("widgets: quick actions", () => {
  test("+ opens the add form with the section; saving writes the list", () => {
    const app = boot()
    const adding = update(opened(app), Message.ClickedAddQuickAction(), app)
    expect(adding.model.quickActions.isAdding).toBe(true)
    expect(storeTags(adding)).toEqual(["ChangedWidgetExpanded"])
    const typed = update(adding.model, Message.ChangedNewCommand({ value: "  bun run dev " }), app).model
    const saved = update(typed, Message.SubmittedQuickAction(), app)
    expect(names(saved)).toEqual(["WidgetsWriteQuickActions"])
    expect(saved.model.quickActions.isAdding).toBe(false)
    expect(saved.model.quickActions.written?.actions.map((action) => action.command)).toEqual(["bun run dev"])
  })

  test("running one shows its check for a second and re-reads the ports after 1s and 2s", () => {
    const app = boot()
    const ran = update(opened(app), Message.RanQuickAction({ id: "qa1" }), app)
    expect(ran.model.quickActions.ranActionId).toBe("qa1")
    expect(names(ran)).toEqual(["WidgetsExpireRanQuickAction", "WidgetsWaitPostRunRefresh", "WidgetsWaitPostRunRefresh"])
    const expired = update(ran.model, Message.ExpiredRanQuickAction({ token: ran.model.quickActions.ranToken }), app).model
    expect(expired.quickActions.ranActionId).toBeNull()
  })
})

describe("widgets: stopping a task", () => {
  test("the row says Stopping… at once; a failed stop says why and lets go", () => {
    const app = boot()
    const stopping = update(opened(app), Message.ClickedStopTask({ taskId: "t1" }), app)
    expect(names(stopping)).toEqual(["WidgetsStopTask"])
    expect(stopping.model.stopping).toEqual(["t1"])
    const failed = update(stopping.model, Message.FailedStopTask({ taskId: "t1", error: "Can't stop it" }), app).model
    expect(failed.stopping).toEqual([])
    expect(failed.stopError).toBe("Can't stop it")
  })
})

describe("widgets: the git widgets' pure parts", () => {
  test("the Changes search matches every word, in any order", () => {
    const files = [{ path: "src/widgets/WidgetCard.tsx" }, { path: "src/lib/units.ts" }]
    expect(filterFilesByQuery(files, "card widget")).toEqual([{ path: "src/widgets/WidgetCard.tsx" }])
    expect(filterFilesByQuery(files, "  ")).toBe(files)
  })

  test("the totals count the checked files once some are unchecked", () => {
    const files = [{ path: "a", additions: 2, deletions: 1 }, { path: "b", additions: 5, deletions: 0 }]
    expect(summarizeChanges(files, new Set(["a", "b"]))).toEqual({ title: "2 files changed", additions: 7, deletions: 1 })
    expect(summarizeChanges(files, new Set(["b"]))).toEqual({ title: "1 of 2 files changed", additions: 5, deletions: 0 })
  })

  test("the commit button names what it will do", () => {
    const base = { hasSummary: false, isGenerating: false, isCommitting: false, isGeneratedCommitInFlight: false, commitModeInFlight: null, primaryCommitMode: "commit_and_push" as const }
    expect(getPrimaryCommitActionPrefix(base)).toBe("Generate & push to")
    expect(getPrimaryCommitActionPrefix({ ...base, isGenerating: true })).toBe("Generating…")
    expect(getPrimaryCommitActionPrefix({ ...base, hasSummary: true })).toBe("Commit & push to")
    expect(getPrimaryCommitActionPrefix({ ...base, hasSummary: true, isCommitting: true, isGeneratedCommitInFlight: true, commitModeInFlight: "commit_and_push" })).toBe("Pushing…")
  })

  test("tree order puts a folder's subfolders before its files", () => {
    expect(sortByPath([{ path: "src/b.ts" }, { path: "src/lib/a.ts" }, { path: "README.md" }]).map((entry) => entry.path))
      .toEqual(["src/lib/a.ts", "src/b.ts", "README.md"])
  })

  test("no branch is offered for a name that exists", () => {
    expect(branchCreateOptions("docs", BRANCHES, "main")).toEqual([])
    expect(branchCreateOptions("", BRANCHES, "main")).toEqual([])
  })

  test("a patch peek is the first hunk, and counts what it leaves out", () => {
    const patch = ["diff --git a/x b/x", "@@ -1,2 +1,3 @@", " keep", "+add", "-gone", ...Array.from({ length: 12 }, (_, index) => `+more ${index}`)].join("\n")
    const peek = peekPatch(patch)!
    expect(peek.header).toBe("@@ -1,2 +1,3 @@")
    expect(peek.lines).toHaveLength(12)
    expect(peek.moreChanges).toBe(3)
  })
})
