import { Option } from "effect"
import { Mount } from "foldkit"
import type { Html } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import type { ChatBranchListEntry } from "../../shared/types"
import type { Child } from "../ui/attributes"
import { GitBranchPlus, Search } from "../ui/icons"
import { skeleton } from "../ui/skeleton"
import { type ColumnContext, type H } from "./context"
import { branchHoverCard, HOVER_LISTS } from "./git"
import {
  PICKER_LIST_ID,
  pickerCreateId,
  pickerOptionId,
  pickerState,
  PREFETCHED_PULL_REQUEST_LIMIT,
  UNSEARCHED_BRANCH_LIMIT,
} from "./gitLogic"
import { branchRowContent, checksIcon, labelledIcon, pullRequestStateIcon } from "./gitParts"
import { listHoverAttributes } from "./hoverCard"
import { Message } from "./message"
import type { PickerSection } from "./model"
import { RequestBranchDetails } from "./mounts"
import {
  ROW_HIGHLIGHT_CLASS,
  ROW_HOVER_CLASS,
  StopEscapePropagation,
  WIDGET_ROW_REVEAL_CLASS,
  WIDGET_STRIP_INPUT_CLASS,
  widgetError,
  widgetIconColumn,
  widgetList,
  widgetListLabel,
  widgetMoreRow,
  widgetRow,
  widgetStrip,
} from "./parts"

// BranchPicker (git/BranchPicker.tsx) and BranchList.tsx's sections and
// skeleton: find or create a branch, inline in the Branch card. One search
// over one list: Recent, Pull requests, Local, Remote. ↑/↓ move, Enter
// checks out or creates, Esc closes.

const toHover = (message: Parameters<typeof Message.GotHoverMessage>[0]["message"]) => Message.GotHoverMessage({ message })
const stopped = (message: Parameters<typeof Message.GotPartsMessage>[0]["message"]) => Message.GotPartsMessage({ message })

// Fixed, uneven widths: branch names vary in length.
const SKELETON_NAME_WIDTHS = ["58%", "42%", "70%", "36%", "52%"]

/** The branch list while it loads, in WidgetRow's geometry. */
export function branchListSkeleton<M>(h: import("foldkit/html").HtmlBuilder<M>, rows = 5): Html {
  return h.div([h.AriaBusy(true), h.AriaLabel("Loading branches"), h.Class("flex flex-col gap-px")], [
    h.div([h.Class("flex h-5 items-center px-1.5 pb-1 pt-1 box-content")], [skeleton({ class: "h-3 w-14" }, h)]),
    ...Array.from({ length: rows }, (_, index) => h.keyed("div")(String(index), [h.Class("flex items-center gap-2 rounded-lg border border-transparent px-[5px] py-1.5")], [
      widgetIconColumn({}, [skeleton({ class: "size-3.5 rounded-full" }, h)], h),
      skeleton({ class: "h-3 flex-none", style: { width: SKELETON_NAME_WIDTHS[index % SKELETON_NAME_WIDTHS.length]! } }, h),
      skeleton({ class: "ml-auto h-2.5 w-7" }, h),
    ])),
  ])
}

/**
 * A section of branch rows (BranchListSection): its label and rows,
 * directly in the List. Nothing when it has no rows and no empty label.
 */
export function branchListSection<M>(
  options: {
    title: string
    count?: number
    entries: ReadonlyArray<ChatBranchListEntry>
    emptyLabel?: string
    selectedName?: string | null
    activeOptionId?: string | null
    optionId?: (entry: ChatBranchListEntry) => string
    optionClassName?: (isActive: boolean) => string
    disabled?: boolean
    footer?: Html | null
    expanded?: boolean
    onToggle?: M
    revealFrom?: number
    subMetaFor?: (entry: ChatBranchListEntry) => Html | undefined
    iconFor?: (entry: ChatBranchListEntry) => Html | undefined
    attributesFor?: (entry: ChatBranchListEntry) => ReadonlyArray<import("foldkit/html").Attribute<M>>
    onSelect: (entry: ChatBranchListEntry) => M
  },
  h: import("foldkit/html").HtmlBuilder<M>,
): ReadonlyArray<Child> {
  if (options.entries.length === 0 && !options.emptyLabel) return []
  const expanded = options.expanded ?? true
  return [
    widgetListLabel({
      label: options.title,
      ...(options.count !== undefined ? { count: options.count } : {}),
      expanded,
      ...(options.onToggle !== undefined ? { onToggle: options.onToggle } : {}),
    }, h),
    ...(!expanded
      ? []
      : options.entries.length === 0
        ? [h.keyed("div")(`empty-${options.title}`, [h.Class("px-1.5 pb-1 text-xs text-muted-foreground")], [options.emptyLabel ?? ""])]
        : options.entries.map((entry, index) => {
          const id = options.optionId?.(entry)
          const isActive = id !== undefined && id === options.activeOptionId
          const content = branchRowContent(entry, h)
          const icon = options.iconFor?.(entry) ?? content.icon
          const subMeta = options.subMetaFor?.(entry)
          return widgetRow({
            key: entry.id,
            icon,
            title: content.title,
            ...(content.subtitle ? { subtitle: content.subtitle } : {}),
            ...(content.meta ? { meta: content.meta } : {}),
            ...(id !== undefined ? { id, role: "option", ariaSelected: isActive, tabIndex: -1 } : {}),
            rowKey: entry.id,
            ...(subMeta ? { subMeta } : {}),
            active: options.selectedName === entry.name,
            ...(options.optionClassName ? { highlightClassName: options.optionClassName(isActive) } : {}),
            disabled: options.disabled ?? false,
            ...(options.revealFrom !== undefined && index >= options.revealFrom ? { class: WIDGET_ROW_REVEAL_CLASS } : {}),
            onActivate: options.onSelect(entry),
            ...(options.attributesFor ? { attributes: options.attributesFor(entry) } : {}),
          }, h)
        })),
    expanded ? options.footer ?? null : null,
  ]
}

export function pickerView(context: ColumnContext, h: H): ReadonlyArray<Child> {
  const { model, diffs } = context
  const picker = model.git.picker
  const state = pickerState(picker, diffs.branchName)
  const { sections, createOptions, searching, isExpanded, resolvedActiveId } = state
  const repoSlug = diffs.originRepoSlug
  const mode = picker.mode

  // The PRs on screen read their state up front, at most ten.
  const prefetched = new Set(sections.pullRequests.slice(0, PREFETCHED_PULL_REQUEST_LIMIT).map((entry) => entry.id))
  const prDetails = (entry: ChatBranchListEntry) =>
    model.branchDetails[`${entry.id}\u0000${entry.updatedAt ?? ""}`]?.pullRequest
  const pullRequestChecks = (entry: ChatBranchListEntry) => {
    const checks = prDetails(entry)?.checks
    return checks ? checksIcon(checks, { onOpen: (url) => Message.ClickedOpenUrl({ url }), stopped }, h) : undefined
  }
  const pullRequestIcon = (entry: ChatBranchListEntry) => {
    const pr = prDetails(entry)
    return pr ? labelledIcon(pullRequestStateIcon(pr, h), h) : undefined
  }

  /**
   * A row's highlight. Keyboard mode: only the cursor. Pointer mode: :hover,
   * plus Enter's target whenever the pointer isn't over the list.
   */
  const optionClassName = (isActive: boolean) => {
    if (mode === "keyboard") return isActive ? ROW_HIGHLIGHT_CLASS : ""
    return isActive
      ? cn(ROW_HIGHLIGHT_CLASS, "group-hover/list:border-transparent group-hover/list:bg-transparent hover:!border-border hover:!bg-muted")
      : ROW_HOVER_CLASS
  }
  const sectionFold = (section: PickerSection) => ({
    expanded: isExpanded(section),
    ...(searching ? {} : { onToggle: Message.ToggledPickerSection({ section }) }),
  })
  const countOf = (total: number) => (total > 0 ? total : undefined)
  const revealFrom = (showAll: boolean) => (showAll && !searching ? UNSEARCHED_BRANCH_LIMIT : undefined)
  const sectionMore = (section: PickerSection, total: number, showAll: boolean, githubHref?: string) => {
    if (searching || total <= UNSEARCHED_BRANCH_LIMIT) return null
    return githubHref
      ? widgetMoreRow({ key: `more-${section}`, count: total - UNSEARCHED_BRANCH_LIMIT, total, href: githubHref, onClick: Message.ClickedOpenUrl({ url: githubHref }), tabIndex: -1, suppressHover: mode === "keyboard" }, h)
      : widgetMoreRow({
        key: `more-${section}`,
        count: total - UNSEARCHED_BRANCH_LIMIT,
        shown: showAll,
        toParts: stopped,
        onClick: Message.ClickedPickerShowAll({ section, shown: !showAll }),
        tabIndex: -1,
        suppressHover: mode === "keyboard",
      }, h)
  }
  const sectionProps = {
    disabled: picker.isMutating,
    activeOptionId: resolvedActiveId,
    optionId: pickerOptionId,
    optionClassName,
    onSelect: (entry: ChatBranchListEntry) => Message.ChoseBranch({ entry }),
  }
  const hasBranchRows = sections.recent.length + sections.pullRequests.length + sections.local.length + sections.remote.length > 0
  const list = HOVER_LISTS.picker
  const hoveredId = model.hovered[list]
  const shownEntries = [...sections.recent, ...sections.pullRequests, ...sections.local, ...sections.remote]
  const hoveredEntry = hoveredId ? shownEntries.find((entry) => entry.id === hoveredId) : undefined

  return [
    // BranchSearchRow: a Strip over the list, and a combobox over it.
    widgetStrip({ leading: Search({}, h) }, [
      h.input([
        h.Id(`${PICKER_LIST_ID}-search`),
        h.Value(picker.query),
        h.OnInput((value) => Message.ChangedPickerQuery({ value })),
        h.OnKeyDownPreventDefault((key) => (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(key) ? Option.some(Message.PressedPickerKey({ key })) : Option.none())),
        // The page listens for Esc on window; this one means only "leave the picker".
        h.OnMount(Mount.mapMessage(StopEscapePropagation(), stopped)),
        h.Placeholder("Find or create a branch…"),
        h.Role("combobox"),
        h.AriaExpanded(true),
        h.AriaControls(PICKER_LIST_ID),
        ...(resolvedActiveId ? [h.AriaActiveDescendant(resolvedActiveId)] : []),
        h.AriaAutocomplete("list"),
        h.Autocomplete("off"),
        h.Spellcheck(false),
        h.DataAttribute("1p-ignore", "true"),
        h.Class(WIDGET_STRIP_INPUT_CLASS),
      ]),
    ], h),
    widgetList({
      class: "group/list",
      attributes: [
        h.Id(PICKER_LIST_ID),
        h.Role("listbox"),
        h.AriaLabel("Branches"),
        h.AriaBusy(picker.isLoading),
        h.DataAttribute("mode", mode),
        h.OnPointerMove(() => (mode === "keyboard" ? Option.some(Message.MovedPointerOverPicker()) : Option.none())),
        ...listHoverAttributes(list, toHover, h),
      ],
    }, picker.isLoading
      ? [branchListSkeleton(h)]
      : picker.error
        ? [widgetError(picker.error, h)]
        : [
          !hasBranchRows && createOptions.length === 0
            ? h.keyed("div")("none", [h.Class("px-1.5 py-1 text-xs text-muted-foreground")], [searching ? "No matching branches." : "No other branches."])
            : null,
          ...branchListSection({ title: "Recent", ...(countOf(sections.recent.length) !== undefined ? { count: countOf(sections.recent.length)! } : {}), entries: sections.recent, ...sectionFold("recent"), ...sectionProps }, h),
          ...branchListSection({
            title: "Pull requests",
            ...sectionFold("pullRequests"),
            ...(countOf(sections.allPullRequestCount) !== undefined ? { count: countOf(sections.allPullRequestCount)! } : {}),
            entries: sections.pullRequests,
            subMetaFor: pullRequestChecks,
            iconFor: pullRequestIcon,
            attributesFor: (entry) => (prefetched.has(entry.id) ? [h.OnMount(RequestBranchDetails({ entry }))] : []),
            // Said only when PRs could not be read.
            ...(picker.branchList?.pullRequestsStatus === "error" && !searching
              ? { emptyLabel: picker.branchList.pullRequestsError ?? "Could not load pull requests." }
              : {}),
            ...(revealFrom(picker.showAllPullRequests) !== undefined ? { revealFrom: revealFrom(picker.showAllPullRequests)! } : {}),
            footer: sectionMore("pullRequests", sections.allPullRequestCount, picker.showAllPullRequests, repoSlug ? `https://github.com/${repoSlug}/pulls` : undefined),
            ...sectionProps,
          }, h),
          ...branchListSection({
            title: "Local",
            ...sectionFold("local"),
            ...(countOf(sections.allLocalCount) !== undefined ? { count: countOf(sections.allLocalCount)! } : {}),
            entries: sections.local,
            ...(revealFrom(picker.showAllLocal) !== undefined ? { revealFrom: revealFrom(picker.showAllLocal)! } : {}),
            footer: sectionMore("local", sections.allLocalCount, picker.showAllLocal),
            ...sectionProps,
          }, h),
          ...branchListSection({
            title: "Remote",
            ...sectionFold("remote"),
            ...(countOf(sections.allRemoteCount) !== undefined ? { count: countOf(sections.allRemoteCount)! } : {}),
            entries: sections.remote,
            ...(revealFrom(picker.showAllRemote) !== undefined ? { revealFrom: revealFrom(picker.showAllRemote)! } : {}),
            footer: sectionMore("remote", sections.allRemoteCount, picker.showAllRemote, repoSlug ? `https://github.com/${repoSlug}/branches/all` : undefined),
            ...sectionProps,
          }, h),
          createOptions.length > 0
            // Directly under the last section's rows, touching them.
            ? h.keyed("div")("create", [h.Role("group"), h.AriaLabel("Create branch"), h.Class("flex flex-col gap-px")], createOptions.map((option) => {
              const id = pickerCreateId(option)
              const isActive = id === resolvedActiveId
              return widgetRow({
                key: id,
                id,
                role: "option",
                ariaSelected: isActive,
                tabIndex: -1,
                icon: GitBranchPlus({}, h),
                title: [
                  "Create ",
                  h.span([h.Class("font-mono text-[13px]")], [option.name]),
                  option.baseBranchName ? h.span([h.Class("text-muted-foreground")], [" from ", option.baseBranchName]) : null,
                ],
                disabled: picker.isMutating,
                highlightClassName: optionClassName(isActive),
                onActivate: Message.ChoseCreateBranch({ name: option.name, baseBranchName: option.baseBranchName ?? null }),
              }, h)
            }))
            : null,
        ], h),
    hoveredEntry ? branchHoverCard(context, list, hoveredEntry, h) : null,
  ]
}
