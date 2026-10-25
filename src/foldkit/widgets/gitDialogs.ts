import type { Html } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import type { ChatBranchListEntry } from "../../shared/types"
import { buttonClass } from "../ui/button"
import * as Dialog from "../ui/dialog"
import { AlertTriangle, Building2, Check, FileText, GitBranchPlus, Globe, LoaderCircle, Lock, PencilLine, Search, UserRound } from "../ui/icons"
import { input } from "../ui/input"
import * as Select from "../ui/select"
import { skeleton } from "../ui/skeleton"
import { textarea } from "../ui/textarea"
import { branchListSection, branchListSkeleton } from "./branchPicker"
import { tooltip, type ColumnContext, type H } from "./context"
import { getMergeBranchGroups, mergeMatches } from "./gitLogic"
import { Message } from "./message"

// MergeBranchModal.tsx and GitHubPublishModal.tsx.

/** BranchSearchInput: a boxed search field, for the merge dialog. */
function branchSearchInput(options: { value: string; placeholder: string; onInput: (value: string) => Message }, h: H): Html {
  return h.div([h.Class("relative")], [
    Search({ class: "pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" }, h),
    input({ value: options.value, placeholder: options.placeholder, class: "h-9 pl-7 text-sm", onInput: options.onInput }, h),
  ])
}

/** The selected branch of the merge dialog, if it is still listed. */
export function mergeSelectedEntry(context: ColumnContext): ChatBranchListEntry | null {
  const merge = context.model.merge
  if (!merge.selectedName) return null
  const groups = getMergeBranchGroups(merge.branchList, context.diffs.branchName)
  return [groups.defaultBranch, ...groups.recent, ...groups.other]
    .find((entry): entry is ChatBranchListEntry => entry !== undefined && entry.name === merge.selectedName) ?? null
}

export function mergeDisabled(context: ColumnContext) {
  const merge = context.model.merge
  return !mergeSelectedEntry(context) || !merge.preview || merge.isPreviewLoading || merge.isMerging || merge.preview.status !== "mergeable"
}

export function mergeDialogView(context: ColumnContext, h: H): Html {
  const { model, diffs } = context
  const merge = model.merge
  const groups = getMergeBranchGroups(merge.branchList, diffs.branchName)
  const visibleDefault = groups.defaultBranch && mergeMatches(groups.defaultBranch, merge.query) ? groups.defaultBranch : undefined
  const visibleRecent = groups.recent.filter((entry) => mergeMatches(entry, merge.query))
  const visibleOther = groups.other.filter((entry) => mergeMatches(entry, merge.query))
  const selectedEntry = mergeSelectedEntry(context)
  const select = (entry: ChatBranchListEntry) => Message.SelectedMergeBranch({ name: entry.name })
  const preview = merge.preview
  const disabled = mergeDisabled(context)

  const previewView = (): Html => {
    if (!selectedEntry) return h.div([h.Class("text-sm text-muted-foreground")], ["Select a branch to preview the merge."])
    if (merge.isPreviewLoading) {
      return h.div([h.Class("flex items-start gap-2"), h.AriaBusy(true), h.AriaLabel("Checking merge preview")], [
        skeleton({ class: "mt-1 size-3.5 shrink-0 rounded-full" }, h),
        h.div([h.Class("min-w-0 flex-1 space-y-1.5 pt-1")], [skeleton({ class: "h-3 w-3/5" }, h), skeleton({ class: "h-2.5 w-2/5" }, h)]),
      ])
    }
    if (merge.previewError) return h.div([h.Class("text-sm text-destructive")], [merge.previewError])
    if (!preview) return h.div([h.Class("text-sm text-muted-foreground")], ["Preview unavailable."])
    return h.div([h.Class("flex items-start gap-2")], [
      preview.status === "up_to_date"
        ? Check({ class: "mt-1 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" }, h)
        : preview.status === "conflicts"
          ? AlertTriangle({ class: "mt-1 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" }, h)
          : preview.status === "mergeable"
            ? GitBranchPlus({ class: "mt-1 size-3.5 shrink-0 text-muted-foreground" }, h)
            : AlertTriangle({ class: "mt-1 size-3.5 shrink-0 text-destructive" }, h),
      h.div([h.Class("min-w-0 space-y-1")], [
        h.div([h.Class("text-sm font-medium text-foreground")], [preview.message]),
        preview.detail ? h.div([h.Class("line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground")], [preview.detail]) : null,
      ]),
    ])
  }

  return h.submodel({
    slotId: "widgets-merge-dialog",
    model: merge.dialog,
    view: Dialog.view,
    viewInputs: {
      size: "sm",
      className: "max-w-[min(92vw,475px)]",
      content: ({ titleId, descriptionId }) => [
        Dialog.dialogBody({ class: "flex min-h-0 flex-col gap-3 px-4 pb-4 pt-4" }, [
          h.div([h.Class("space-y-1")], [
            Dialog.dialogTitle({ id: titleId }, [`Merge into ${diffs.branchName ?? "current branch"}`], h),
            Dialog.dialogDescription({ id: descriptionId }, ["Choose a branch to continue."], h),
          ]),
          branchSearchInput({ value: merge.query, placeholder: "Search branches", onInput: (value) => Message.ChangedMergeQuery({ value }) }, h),
          h.div([h.Class("max-h-[375px] overflow-y-auto pr-1")], !merge.branchList
            ? [branchListSkeleton(h)]
            : [
              ...branchListSection({ title: "Default Branch", entries: visibleDefault ? [visibleDefault] : [], emptyLabel: "No default branch available.", selectedName: merge.selectedName, onSelect: select }, h),
              ...branchListSection({ title: "Recent Branches", entries: visibleRecent, emptyLabel: "No recent branches.", selectedName: merge.selectedName, onSelect: select }, h),
              ...branchListSection({ title: "Other Branches", entries: visibleOther, emptyLabel: "No other branches match this search.", selectedName: merge.selectedName, onSelect: select }, h),
            ]),
          h.div([h.Class("px-2")], [previewView()]),
        ], h),
        Dialog.dialogFooter({}, [
          h.div([h.Class("flex min-w-0 w-full items-center justify-end gap-2")], [
            h.button([h.Class(buttonClass({ variant: "ghost", size: "sm" })), h.OnClick(Message.ClickedMergeCancel())], ["Cancel"]),
            h.button([
              h.Class(buttonClass({ size: "sm", class: "max-w-full min-w-0" })),
              ...(disabled ? [h.Disabled(true)] : []),
              h.OnClick(Message.ClickedMerge()),
            ], merge.isMerging
              ? [LoaderCircle({ class: "mr-1.5 h-3.5 w-3.5 animate-spin" }, h), "Merging…"]
              : [h.span([h.Class("block max-w-full truncate")], ["Merge"])]),
          ]),
        ], h),
      ],
    },
    toParentMessage: (message) => Message.GotMergeDialogMessage({ message }),
  })
}

// PUSH TO GITHUB

export function canPublish(context: ColumnContext) {
  const publish = context.model.publish
  return Boolean(
    publish.info?.ghInstalled
    && publish.info.authenticated
    && publish.owner.trim()
    && publish.name.trim()
    && publish.availability?.available
    && !publish.isCheckingAvailability
    && !publish.isPublishing,
  )
}

const commandBox = (text: string, h: H) => h.div([h.Class("rounded-lg border border-border px-3 py-2 font-mono text-xs text-foreground")], [text])

export function publishDialogView(context: ColumnContext, h: H): Html {
  const { model } = context
  const publish = model.publish
  const info = publish.info
  const owners = info?.owners ?? []

  const fields = (): ReadonlyArray<Html> => [
    h.div([h.Class("space-y-2")], [
      h.submodel({
        slotId: "widgets-publish-owner",
        model: publish.ownerSelect,
        view: Select.view,
        viewInputs: {
          value: publish.owner,
          placeholder: "Select owner",
          items: owners.map((candidate) => ({ value: candidate })),
          renderItem: (value) => [h.span([h.Class("flex items-center gap-2")], [
            value === info?.activeAccountLogin ? UserRound({ class: "size-4 text-muted-foreground" }, h) : Building2({ class: "size-4 text-muted-foreground" }, h),
            h.span([h.Class("pl-[1px]")], [value]),
          ])],
          toView: ({ trigger, value, portal }) => Select.selectTrigger({ attributes: trigger, class: "pl-[11px] [&>span]:flex [&>span]:items-center [&>span]:gap-2" }, [value], portal, h),
        },
        toParentMessage: (message) => Message.GotOwnerSelectMessage({ message }),
      }),
    ]),
    h.div([h.Class("space-y-2")], [
      h.div([h.Class("relative")], [
        input({ value: publish.name, placeholder: "my-repo", class: "pl-9 pr-10", onInput: (value) => Message.ChangedPublishName({ value }) }, h),
        PencilLine({ class: "pointer-events-none absolute inset-y-0 left-3 my-auto size-4 text-muted-foreground" }, h),
        publish.isCheckingAvailability
          ? h.div([h.Class("pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground")], [LoaderCircle({ class: "size-4 animate-spin" }, h)])
          : publish.availability
            ? h.div([h.Class("absolute inset-y-0 right-2 flex items-center")], [
              tooltip(model, "publish-availability", {
                content: () => [publish.availability!.message],
                toView: ({ trigger, portal }) => h.button([
                  h.Type("button"),
                  h.Tabindex(-1),
                  h.AriaLabel(publish.availability!.message),
                  ...trigger,
                  h.Class(cn("flex size-6 items-center justify-center rounded-md", publish.availability!.available ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")),
                ], [publish.availability!.available ? Check({ class: "size-4" }, h) : AlertTriangle({ class: "size-4" }, h), portal]),
              }, h, false),
            ])
            : null,
      ]),
    ]),
    h.div([h.Class("space-y-2")], [
      h.div([h.Class("relative")], [
        FileText({ class: "pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" }, h),
        textarea({
          value: publish.description,
          rows: 3,
          placeholder: "Optional description",
          class: "pl-9 outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0",
          onInput: (value) => Message.ChangedPublishDescription({ value }),
        }, h),
      ]),
    ]),
    h.div([h.Class("space-y-2")], [
      h.submodel({
        slotId: "widgets-publish-visibility",
        model: publish.visibilitySelect,
        view: Select.view,
        viewInputs: {
          value: publish.visibility,
          placeholder: "Select visibility",
          items: [{ value: "private" }, { value: "public" }],
          renderItem: (value) => [h.span([h.Class("flex items-center gap-2")], value === "private"
            ? [Lock({ class: "size-4 text-muted-foreground" }, h), h.span([h.Class("pl-[1px]")], ["Private"])]
            : [Globe({ class: "size-4 text-muted-foreground" }, h), h.span([h.Class("pl-[1px]")], ["Public"])])],
          toView: ({ trigger, value, portal }) => Select.selectTrigger({ attributes: trigger, class: "pl-[11px] [&>span]:flex [&>span]:items-center [&>span]:gap-2" }, [value], portal, h),
        },
        toParentMessage: (message) => Message.GotVisibilitySelectMessage({ message }),
      }),
    ]),
  ]

  const body = (): ReadonlyArray<Html> => {
    if (publish.isLoadingInfo) {
      return [h.div([h.Class("flex items-center gap-2 text-sm text-muted-foreground")], [LoaderCircle({ class: "size-4 animate-spin" }, h), h.span([], ["Checking GitHub CLI…"])])]
    }
    if (info && !info.ghInstalled) {
      return [h.div([h.Class("space-y-2 text-sm text-muted-foreground")], [
        h.p([], ["GitHub CLI is not installed."]),
        commandBox("brew install gh", h),
        h.p([], ["Then run:"]),
        commandBox("gh auth login", h),
      ])]
    }
    if (info && !info.authenticated) {
      return [h.div([h.Class("space-y-2 text-sm text-muted-foreground")], [h.p([], ["GitHub CLI is installed but not signed in."]), commandBox("gh auth login", h)])]
    }
    return fields()
  }

  return h.submodel({
    slotId: "widgets-publish-dialog",
    model: publish.dialog,
    view: Dialog.view,
    viewInputs: {
      size: "sm",
      className: "max-w-[min(92vw,475px)]",
      content: ({ titleId, descriptionId }) => [
        Dialog.dialogBody({ class: "space-y-2 px-4 pb-4 pt-4" }, [
          h.div([h.Class("space-y-1")], [
            Dialog.dialogTitle({ id: titleId }, ["Push to GitHub"], h),
            Dialog.dialogDescription({ id: descriptionId }, ["Create a GitHub repository from this local project using GitHub CLI."], h),
          ]),
          ...body(),
        ], h),
        Dialog.dialogFooter({}, [
          h.button([h.Class(buttonClass({ variant: "ghost", size: "sm" })), h.OnClick(Message.ClickedPublishCancel())], ["Cancel"]),
          h.button([
            h.Class(buttonClass({ size: "sm" })),
            ...(!canPublish(context) ? [h.Disabled(true)] : []),
            h.OnClick(Message.ClickedPublish()),
          ], publish.isPublishing ? [LoaderCircle({ class: "mr-1.5 size-3.5 animate-spin" }, h), "Publishing…"] : ["Push to GitHub"]),
        ], h),
      ],
    },
    toParentMessage: (message) => Message.GotPublishDialogMessage({ message }),
  })
}
