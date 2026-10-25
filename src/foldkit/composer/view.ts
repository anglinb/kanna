import { Submodel } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder, TextareaAttribute } from "foldkit/html"
import { isEscapeClaimed, isViewerPaneOpen, resolveEscapePress } from "../../client/lib/escape-key"
import { formatPathWithTilde } from "../../client/lib/pathUtils"
import { delegatorDisplayTitle } from "../../client/lib/delegators"
import type { UploadErrorReport } from "../../client/lib/uploadError"
import { cn } from "../../client/lib/utils"
import { chatModeFromFlags, type ChatMode } from "../../shared/types"
import type { SliceViewInputs } from "../app/slice"
import type { ChatPageContext, ChatPageRequests } from "../chat/pageInputs"
import * as ContextWindowMeter from "../chat/contextWindowMeter"
import * as ProviderAuth from "../core/stores/providerAuth"
import * as Sidebar from "../core/stores/sidebar"
import { signInDialogView, type SignInDialogMessage } from "../settings/auth-cards"
import { attachmentFileCard, attachmentImageCard } from "../transcript/messages/attachments"
import { button } from "../ui/button"
import * as Icons from "../ui/icons"
import type * as Popover from "../ui/popover"
import { scrollArea } from "../ui/scroll-area"
import { textarea } from "../ui/textarea"
import type * as Tooltip from "../ui/tooltip"
import { fileInputSelector, holdArcSelector } from "./commands"
import {
  accountsOf,
  activeContextWindow,
  canSubmit,
  composerViewOf,
  contextFromApp,
  delegateSettingsOf,
  hasPendingUploads,
  menusOf,
  placeholderOf,
  uploadedAttachments,
  type ComposerProps,
  type Context,
  type PageComposerInputs,
} from "./context"
import { delegateControl } from "./delegateControl"
import { onBridged, BridgeComposerEvents, DrawWaveform, TextareaLifecycle } from "./effects"
import { Message } from "./message"
import type { ComposerAttachment, Model, PopoverName } from "./model"
import { getClipboardImageFiles, hasClipboardTextPayload, replaceTextSelection, trimTrailingPastedNewlines } from "./paste"
import { inputPopover, popoverMenuItem, preferenceControls, type PreferencePicker } from "./preferenceControls"
import { reconcile } from "./update"

// ChatInput's JSX. The view draws the composer the page shows now: a Model
// still holding the last chat's composer is drawn as the fresh one it is
// about to become (`reconcile`), as React's remount under a new key did.

type H = HtmlBuilder<Message>

/**
 * What the composer is drawn from: the root Model, and the chat page's own
 * inputs when it is the chat page's composer (`page`, `requests`), or a
 * whole set of props (a gallery).
 */
export interface ViewInputs extends SliceViewInputs {
  page?: ChatPageContext
  requests?: ChatPageRequests
  props?: ComposerProps
}

/** The chat page's inputs for its composer: ChatInputDock's props. */
export function pageComposerInputs(page: ChatPageContext): PageComposerInputs {
  return {
    hasSelectedProject: page.composer.hasSelectedProject,
    canCancel: page.composer.canCancel,
    projectPath: page.composer.projectPath,
    projectRepoLabel: page.composer.projectRepoLabel,
    contextWindowSnapshot: page.composer.contextWindowSnapshot,
    delegate: page.delegate,
  }
}

export function contextFromInputs(inputs: ViewInputs): Context {
  if (inputs.props) return { props: inputs.props, stores: inputs.app.stores }
  return contextFromApp(inputs.app, inputs.page ? pageComposerInputs(inputs.page) : undefined)
}

/** Stable default, so a chat with no delegated work doesn't re-render on it. */
const NO_ATTRIBUTES: ReadonlyArray<ChildAttribute> = []

export const view = Submodel.defineView<Model, Message, ViewInputs>((stored, inputs, h) => {
  const ctx = contextFromInputs(inputs)
  const model = reconcile(stored, ctx).model
  return composerView(model, ctx, inputs.requests?.editModels ?? (ctx.props.editModels ? NO_ATTRIBUTES : undefined), h)
})

function composerView(model: Model, ctx: Context, editModels: ReadonlyArray<ChildAttribute> | undefined, h: H): Html {
  const { props } = ctx
  const instance = model.instance!
  const domId = instance.domId
  const composer = composerViewOf(ctx)
  const prefs = composer.effectiveState
  const selectedProvider = composer.selectedProvider
  const showModePicker = composer.supportsPlanMode
  const delegateSettings = delegateSettingsOf(props)
  const menus = menusOf(model, ctx, selectedProvider)
  const { providerAccounts, pinnedAccountId, selectedAccountId } = accountsOf(model, ctx, selectedProvider)
  const selectedAccount = providerAccounts.find((entry) => entry.id === selectedAccountId)
  const contextWindow = activeContextWindow(ctx, prefs)
  const placeholder = placeholderOf(props)
  const isStandalone = model.isStandalone
  // Leading/trailing gutter *inside* the controls scroller, standing in for the
  // horizontal padding its wrapper can't have. Standalone keeps the same 32px
  // net inset the old wrapper produced (20px padding + 12px spacer).
  const controlsScrollSpacer = cn("min-w-3", isStandalone && "min-w-8")

  const sendable = canSubmit(model)
  const pendingUploads = hasPendingUploads(model)
  const holdEngaged = model.hold.phase === "holding" || model.hold.phase === "confirmed"
  // The round button is Send while there is something to send and Stop
  // otherwise. Under a hold it is Stop either way: the ring is drawn round
  // it, and it has to say what the ring is counting down to.
  const showStop = props.canCancel && (!sendable || holdEngaged)
  const recording = model.recording
  const transcribing = model.transcribing
  // The mic only shows with an empty composer; with a draft the send
  // button is the sole action, the same as iOS. Mid-turn it stays: the
  // transcript queues behind the running turn.
  const showMic = !sendable && !recording && !transcribing
  const orderedAttachments = [...model.attachments].sort((left, right) => {
    if (left.kind === right.kind) return 0
    return left.kind === "image" ? -1 : 1
  })

  function handleKeyDown(event: KeyboardEvent): Message | null {
    const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
    if (menus.skillMenuOpen) {
      // Best match renders at the bottom: ArrowUp walks toward worse matches,
      // ArrowDown back toward the input.
      if (event.key === "ArrowUp" && plain) {
        event.preventDefault()
        return Message.MovedSkillSelection({ towardWorse: true })
      }
      if (event.key === "ArrowDown" && plain) {
        event.preventDefault()
        return Message.MovedSkillSelection({ towardWorse: false })
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && menus.skillItems[menus.selectedSkillIndex]) {
        event.preventDefault()
        return Message.AcceptedSkill({ index: menus.selectedSkillIndex })
      }
      if (event.key === "Escape") {
        event.preventDefault()
        return Message.DismissedSkillMenu()
      }
    }

    if (menus.projectMenuOpen) {
      if (event.key === "ArrowUp" && plain) {
        event.preventDefault()
        return Message.MovedProjectSelection({ towardWorse: true })
      }
      if (event.key === "ArrowDown" && plain) {
        event.preventDefault()
        return Message.MovedProjectSelection({ towardWorse: false })
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && menus.projectItems[menus.selectedProjectIndex]) {
        event.preventDefault()
        return Message.AcceptedProject({ index: menus.selectedProjectIndex })
      }
      if (event.key === "Escape") {
        event.preventDefault()
        return Message.DismissedProjectMenu()
      }
    }

    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault()
      return Message.PressedTab()
    }

    // Cycles the provider's modes in picker order: two for codex
    // (Full Access → Plan Mode), three for claude (… → Auto Plan).
    if (event.key === "Tab" && event.shiftKey && showModePicker && !delegateSettings) {
      event.preventDefault()
      return Message.PressedShiftTab()
    }

    // Escape stops the turn only when held, and only once nothing nearer has
    // a use for the key (`resolveEscapePress`). With the viewer's pane open
    // the key never gets here: the pane hears it first and closes. A repeat
    // is swallowed, so a key still down from closing the pane, from the hold
    // running, or from a hold whose turn has just stopped, neither starts
    // one nor leaks to what is behind.
    if (event.key === "Escape") {
      const action = resolveEscapePress({
        repeat: event.repeat,
        claimed: isEscapeClaimed(event),
        paneOpen: isViewerPaneOpen(),
        canInterrupt: props.canCancel,
      })
      if (action === "hold-to-interrupt") {
        event.preventDefault()
        return Message.PressedEscapeToStop()
      }
      if (action === "ignore") {
        event.preventDefault()
        return Message.IgnoredKey()
      }
    }

    // The text as it is now, not as this render drew it: a key can land
    // before the frame that shows the last one.
    const value = (event.target as HTMLTextAreaElement).value
    if (event.key === "ArrowUp" && plain && value.length === 0 && props.previousPrompt) {
      event.preventDefault()
      return Message.RecalledPreviousPrompt()
    }

    const isTouchDevice = typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0)
    const sendableNow = value.trim().length > 0 || uploadedAttachments(model).length > 0
    if (event.key === "Enter" && !event.shiftKey && !isTouchDevice && !props.disabled && sendableNow && !pendingUploads) {
      event.preventDefault()
      return Message.PressedEnter({ withModifier: event.metaKey || event.ctrlKey })
    }
    return null
  }

  function handlePaste(event: ClipboardEvent): Message | null {
    const clipboardData = event.clipboardData
    if (!clipboardData) return null
    const files = getClipboardImageFiles(clipboardData.items, Date.now())
    const pastedText = clipboardData.getData("text/plain")
    const trimmedText = trimTrailingPastedNewlines(pastedText)
    const shouldTrimTrailingNewlines = pastedText.length > 0 && trimmedText !== pastedText

    if (files.length === 0 && !shouldTrimTrailingNewlines) return null

    if (shouldTrimTrailingNewlines) {
      event.preventDefault()
      const element = event.target as HTMLTextAreaElement
      const nextValue = replaceTextSelection({
        value: element.value,
        insertedText: trimmedText,
        selectionStart: element.selectionStart,
        selectionEnd: element.selectionEnd,
      })
      return Message.Pasted({ files, text: { value: nextValue, caret: element.selectionStart + trimmedText.length } })
    }

    if (!hasClipboardTextPayload(clipboardData)) event.preventDefault()
    return Message.Pasted({ files, text: null })
  }

  const popover = (name: PopoverName): Popover.Model => model.popovers[name]
  const meter = (name: "inlineMeter" | "dockedMeter", usage: NonNullable<typeof contextWindow>) => h.submodel({
    slotId: `meter-${name}`,
    model: model.tooltips[name],
    view: ContextWindowMeter.view,
    viewInputs: { usage },
    toParentMessage: (message: Tooltip.Message) => Message.GotTooltipMessage({ name, message }),
  })

  // THE INPUT ROW

  const textBox = recording
    ? h.div([h.Class("flex min-w-0 flex-1 items-center px-4 py-[6px] md:py-[10px]")], [
      h.canvas([
        h.Class("h-9 w-full text-muted-foreground"),
        h.Role("img"),
        h.AriaLabel("Recording"),
        h.OnMount(DrawWaveform({ key: domId })),
      ]),
    ])
    : textarea({
      placeholder,
      value: model.value,
      rows: 1,
      disabled: props.disabled,
      class: "min-w-0 flex-1 text-base p-3 md:p-4 !pr-2 md:pl-6 resize-none max-h-[200px] outline-none bg-transparent border-0 shadow-none placeholder:truncate",
      attributes: [
        h.DataAttribute("chat-input", ""),
        h.DataAttribute("composer", domId),
        h.OnMount(TextareaLifecycle({ autoFocus: !props.secondary })),
        ...([
          onBridged(h, "input", (event) => {
            const element = event.target as HTMLTextAreaElement
            return Message.ChangedInput({ value: element.value, caret: element.selectionStart ?? element.value.length })
          }),
          onBridged(h, "keydown", handleKeyDown),
          onBridged(h, "paste", handlePaste),
        ] as ReadonlyArray<TextareaAttribute<Message>>),
      ],
    }, h)

  const discardButton = recording
    ? button({
      type: "button",
      variant: "ghost",
      size: "icon",
      class: "flex-shrink-0 rounded-full cursor-pointer h-10 w-10 md:h-11 md:w-11 mb-1 mr-1 md:mb-1.5 text-muted-foreground touch-manipulation",
      attributes: [
        h.Title("Discard recording"),
        onBridged(h, "pointerdown", (event) => {
          event.preventDefault()
          return Message.PressedDiscardRecording()
        }),
      ],
    }, [Icons.Trash2({ class: "h-5 w-5" }, h)], h)
    : null

  const micButton = showMic || recording || transcribing
    ? button({
      type: "button",
      variant: recording ? "default" : "ghost",
      size: "icon",
      disabled: props.disabled || transcribing,
      class: cn(
        "flex-shrink-0 rounded-full cursor-pointer h-10 w-10 md:h-11 md:w-11 mb-1 md:mb-1.5 touch-manipulation",
        recording
          ? "bg-slate-600 text-white dark:bg-white dark:text-slate-900 -mr-0.5 md:mr-0"
          : "text-muted-foreground",
        showMic && (props.canCancel ? "mr-1" : "-mr-0.5 md:mr-0"),
      ),
      attributes: [
        h.Title(recording ? "Transcribe and send" : transcribing ? "Transcribing..." : "Record voice message"),
        onBridged(h, "pointerdown", (event) => {
          event.preventDefault()
          return recording || !transcribing ? Message.PressedMic() : null
        }),
      ],
    }, [
      recording
        ? Icons.Check({ class: "h-5 w-5 md:h-6 md:w-6" }, h)
        : transcribing
          ? Icons.Loader2({ class: "h-5 w-5 animate-spin" }, h)
          : Icons.AudioLines({ class: "h-5 w-5" }, h),
    ], h)
    : null

  const primary = recording || transcribing || (showMic && !props.canCancel)
    ? null
    // A box that hugs the button and carries its margins, for the hold's
    // ring and hint to be placed against.
    : h.span([h.Class("relative flex flex-shrink-0 mb-1 -mr-0.5 md:mr-0 md:mb-1.5")], [
      button({
        type: "button",
        size: "icon",
        disabled: props.disabled || (!props.canCancel && !sendable) || pendingUploads,
        class: "flex-shrink-0 bg-slate-600 text-white dark:bg-white dark:text-slate-900 rounded-full cursor-pointer h-10 w-10 md:h-11 md:w-11 touch-manipulation disabled:bg-white/60 disabled:text-slate-700",
        attributes: [
          h.AriaLabel(showStop ? "Stop" : "Send message"),
          ...(showStop ? [h.Title("Stop (hold Esc)")] : []),
          // The pointer acts on the way down. A click that no pointer made
          // (Enter or Space on the button, a screen reader's activation)
          // acts on the click. Stop stays one press there.
          onBridged(h, "pointerdown", (event) => {
            event.preventDefault()
            return Message.PressedPrimaryAction({ withModifier: event.metaKey || event.ctrlKey })
          }),
          onBridged(h, "click", (event) => (event.detail === 0 ? Message.PressedPrimaryAction({ withModifier: event.metaKey || event.ctrlKey }) : null)),
        ],
      }, [
        showStop
          ? h.div([h.Class("w-3 h-3 md:w-4 md:h-4 rounded-xs bg-current")], [])
          : Icons.ArrowUp({ class: "h-5 w-5 md:h-6 md:w-6" }, h),
      ], h),
      holdToStopRing(domId, model.hold.ringShown, h),
      ...holdToStopHint(model.hold.phase === "released", h),
    ])

  // THE MENUS

  const menuBox = (label: string, items: ReadonlyArray<Html>) => h.div([
    h.Class("absolute bottom-full left-0 right-0 mb-2 z-30 max-h-64 overflow-y-auto rounded-2xl border border-border bg-popover/95 backdrop-blur-lg shadow-lg py-1"),
    h.Role("listbox"),
    h.AriaLabel(label),
    // Counted as an open layer by everything that asks whether Escape is
    // spoken for (`hasOpenLayer`): it closes this first.
    h.DataAttribute("state", "open"),
  ], items)

  const menuItem = (key: string, selected: boolean, hovered: Message, accepted: Message, children: ReadonlyArray<Html | null>) => h.keyed("button")(key, [
    h.Type("button"),
    h.Role("option"),
    h.AriaSelected(selected),
    h.Class(cn("flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm", selected ? "bg-accent text-accent-foreground" : "text-foreground")),
    h.OnMouseEnter(hovered),
    // mousedown (not click) so the textarea never loses focus.
    onBridged(h, "mousedown", (event) => {
      event.preventDefault()
      return accepted
    }),
  ], children)

  const skillMenu = menus.skillMenuOpen
    ? menuBox("Skills", menus.skillItems.map((skill, index) => menuItem(
      `${skill.source}:${skill.name}`,
      index === menus.selectedSkillIndex,
      Message.HoveredSkill({ index }),
      Message.AcceptedSkill({ index }),
      [
        h.span([h.Class("shrink-0 font-mono text-[13px]")], [`/${skill.name}`]),
        skill.argumentHint ? h.span([h.Class("shrink-0 font-mono text-[12px] text-muted-foreground")], [skill.argumentHint]) : null,
        skill.description ? h.span([h.Class("min-w-0 truncate text-xs text-muted-foreground")], [skill.description]) : null,
      ],
    )))
    : null

  const projectMenu = menus.projectMenuOpen
    ? menuBox("Projects", menus.projectItems.map((project, index) => menuItem(
      project.projectId,
      index === menus.selectedProjectIndex,
      Message.HoveredProject({ index }),
      Message.AcceptedProject({ index }),
      [
        h.span([h.Class("shrink-0 text-[13px]")], [`@${project.title}`]),
        h.span([h.Class("min-w-0 truncate font-mono text-xs text-muted-foreground")], [formatPathWithTilde(project.localPath)]),
      ],
    )))
    : null

  // THE ATTACHMENTS

  const attachmentRow = model.attachments.length > 0
    ? scrollArea({ class: "overflow-x-auto overflow-y-hidden whitespace-nowrap px-2 pb-2" }, [
      h.div([h.Class("flex items-end gap-2 pt-2")], orderedAttachments.map((attachment) => attachmentTile(attachment, h))),
    ], h)
    : null

  // THE OPTIONS ROW

  const accountPicker = !delegateSettings && providerAccounts.length > 1
    ? inputPopover({
      popover: popover("account"),
      slotId: "account",
      toParentMessage: (message) => Message.GotPopoverMessage({ name: "account", message }),
      disabled: Boolean(pinnedAccountId),
      disabledTitle: "This chat keeps its selected account. Start a new chat to change accounts.",
      trigger: [Icons.UserRound({ class: "size-3.5" }, h), h.span([], [selectedAccount?.label ?? "Account unavailable"])],
      content: () => providerAccounts.map((account) => popoverMenuItem({
        key: account.id,
        onClick: Message.PickedAccount({ accountId: account.id }),
        selected: account.id === selectedAccountId,
        icon: Icons.UserRound({ class: "size-4" }, h),
        label: [account.label],
        description: account.identity ?? account.authStatus.replaceAll("_", " "),
      }, h)),
    }, h)
    : null

  const pickers: Record<PreferencePicker, Popover.Model> = {
    provider: popover("provider"),
    model: popover("model"),
    reasoning: popover("reasoning"),
    contextWindow: popover("contextWindow"),
    fastMode: popover("fastMode"),
    mode: popover("mode"),
  }

  const options = preferenceControls({
    availableProviders: props.availableProviders,
    selectedProvider,
    providerSwitchPending: composer.providerSwitchPending,
    model: prefs.model,
    modelOptions: prefs.modelOptions,
    mode: chatModeFromFlags(prefs.planMode, prefs.autoPlan),
    includeMode: showModePicker,
    hideDefaults: true,
    className: "max-w-[840px] mx-auto",
    leading: props.delegate
      ? delegateControl({ delegate: props.delegate, sidebar: Sidebar.sidebarData(ctx.stores.sidebar), popover: popover("delegate") }, h)
      : undefined,
    readOnly: Boolean(delegateSettings),
    ...(delegateSettings ? { readOnlyTitle: `${delegatorDisplayTitle(delegateSettings.title)}'s setting. Change it in that chat.` } : {}),
    unauthenticated: ProviderAuth.unauthenticatedHarnesses(ctx.stores.providerAuth),
    popovers: pickers,
    modelQuery: model.modelQuery,
    ...(editModels ? { editModels } : {}),
    toPopoverMessage: (name, message) => Message.GotPopoverMessage({ name, message }),
    onProviderChange: (provider) => Message.PickedProvider({ provider }),
    onModelChange: (modelId) => Message.PickedModel({ model: modelId }),
    onModelQueryChange: (query) => Message.ChangedModelQuery({ query }),
    onReasoningEffortChange: (effort) => Message.PickedReasoningEffort({ effort }),
    onContextWindowChange: (value) => Message.PickedContextWindow({ contextWindow: value }),
    onFastModeChange: (fastMode) => Message.PickedFastMode({ fastMode }),
    onModeChange: (mode: ChatMode) => Message.PickedMode({ mode }),
  }, h)

  const attachLabel = h.label([
    h.AriaLabel("Add attachment"),
    h.Class(cn(
      "relative md:hidden shrink-0 self-center overflow-hidden mr-0.5 cursor-pointer",
      "flex items-center gap-1.5 px-2 py-1 text-sm rounded-md transition-colors text-muted-foreground [&>svg]:shrink-0 [&>span]:whitespace-nowrap hover:bg-muted/50",
      props.disabled && "pointer-events-none opacity-70",
    )),
  ], [
    Icons.Paperclip({ class: "h-3.5 w-3.5" }, h),
    h.span([], ["Attach"]),
    h.input([
      h.Type("file"),
      h.Multiple(true),
      ...(props.disabled ? [h.Disabled(true)] : []),
      h.AriaLabel("Add attachment"),
      h.Class("absolute inset-0 h-full w-full cursor-pointer opacity-0"),
      h.DataAttribute("composer-file", `${domId}-attach`),
      h.OnFileChange((files) => Message.PickedFiles({ files })),
    ]),
  ])

  return h.keyed("div")(`composer-${instance.chatKey}`, [h.OnMount(BridgeComposerEvents())], [
    h.div([h.Class(cn("px-3 pt-0", isStandalone && "px-5"))], [
      h.div([h.Class("relative max-w-[840px] mx-auto rounded-[32px]")], [
        skillMenu,
        projectMenu,
        attachmentRow,
        model.recorderError
          ? h.div([h.Class("max-w-[840px] mx-auto px-4 pb-1.5 text-xs text-destructive")], [model.recorderError])
          : null,
        // Opaque on purpose. A backdrop blur here re-samples and re-blurs
        // everything under the composer on every transcript repaint, which
        // during a streaming turn is every frame.
        h.div([h.Class("flex items-end max-w-[840px] mx-auto border bg-background dark:bg-card border-border rounded-[29px] pr-1.5")], [
          textBox,
          discardButton,
          micButton,
          primary,
        ]),
      ]),
      model.uploadError ? uploadErrorNotice(model.uploadError, model.uploadErrorCopied, h) : null,
    ]),

    // Hidden picker for the command palette's "Attach Files" action.
    h.input([
      h.Type("file"),
      h.Multiple(true),
      ...(props.disabled ? [h.Disabled(true)] : []),
      h.AriaHidden(true),
      h.Tabindex(-1),
      h.Class("hidden"),
      h.DataAttribute("composer-file", `${domId}-palette`),
      h.OnFileChange((files) => Message.PickedFiles({ files })),
    ]),

    // Vertical padding only: horizontal padding here would clip the scroller
    // and stop the controls row from bleeding to the screen edge. The inset is
    // applied as leading/trailing spacers *inside* the scroller instead (see
    // controlsScrollSpacer), so the net gutter is unchanged but content can
    // scroll under the edge.
    h.div([h.Class(cn("relative py-3 max-w-[840px] mx-auto", isStandalone && "pt-3 pb-5"))], [
      h.div([h.Class("overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex flex-row")], [
        h.div([h.Class(controlsScrollSpacer)], []),
        attachLabel,
        accountPicker,
        options,
        contextWindow
          ? h.div([h.Class("mx-[13px] flex items-center gap-2 md:hidden")], [meter("inlineMeter", contextWindow)])
          : null,
        h.div([h.Class(controlsScrollSpacer)], []),
      ]),
      // right-[17px] is where the dial has always sat: right-[29px] pulled
      // back by translate-x-1/2 of its own 24px.
      contextWindow
        ? h.div([h.Class(cn(
          "absolute inset-y-0 right-[17px] hidden items-center gap-2 md:flex",
          // Mirror the parent's own padding so this spans its *content* box,
          // which centres the dial on the row itself in both modes.
          isStandalone ? "pt-3 pb-5" : "py-3",
        ))], [meter("dockedMeter", contextWindow)])
        : null,
    ]),

    h.submodel({
      slotId: "sign-in",
      model: model.signIn,
      view: signInDialogView,
      viewInputs: { providerAuth: ctx.stores.providerAuth },
      toParentMessage: (message: SignInDialogMessage) => Message.GotSignInMessage({ message }),
    }),
  ])
}

function attachmentTile(attachment: ComposerAttachment, h: H): Html {
  const onClick = attachment.status === "uploaded" ? Message.ClickedAttachment({ id: attachment.id }) : undefined
  const onRemove = Message.ClickedRemoveAttachment({ id: attachment.id })
  return h.keyed("div")(attachment.id, [
    h.Class(cn("flex shrink-0 flex-col justify-end", attachment.status === "failed" && "text-destructive")),
  ], [
    attachment.kind === "image"
      ? attachmentImageCard(attachment, {
        ...(attachment.previewUrl ? { previewUrl: attachment.previewUrl } : {}),
        size: "composer",
        ...(onClick ? { onClick } : {}),
        onRemove,
      }, h)
      : attachmentFileCard(attachment, { ...(onClick ? { onClick } : {}), onRemove }, h),
  ])
}

/**
 * Upload failures often happen on a phone, where there is no console and no
 * devtools. The full report goes on screen and behind a copy button so the user
 * can hand it over whole.
 */
function uploadErrorNotice(report: UploadErrorReport, copied: boolean, h: H): Html {
  const hasDetail = report.detail !== report.message
  return h.div([h.Class("max-w-[840px] mx-auto mt-2 px-1 text-sm text-destructive")], [
    h.div([h.Class("flex items-start gap-2")], [
      h.span([h.Class("min-w-0 flex-1 break-words")], [report.message]),
      hasDetail
        ? h.button([
          h.Type("button"),
          h.OnClick(Message.ClickedCopyUploadError()),
          h.Class("shrink-0 inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-0.5 text-xs transition-colors hover:bg-destructive/10"),
        ], [
          copied ? Icons.Check({ class: "h-3 w-3" }, h) : Icons.Copy({ class: "h-3 w-3" }, h),
          copied ? "Copied" : "Copy details",
        ])
        : null,
    ]),
    hasDetail
      ? h.pre([h.Class("mt-2 max-h-48 select-text overflow-auto rounded-md bg-destructive/10 p-2 text-[11px] leading-snug whitespace-pre-wrap break-words text-destructive/90")], [report.detail])
      : null,
  ])
}

// HOLD TO STOP (HoldToStop.tsx)

/**
 * The ring. Lies 2px clear of the button it is placed over and 4px beyond
 * its edge, whatever the button's size: it is sized from its positioned
 * parent, which should be a box that hugs the button and nothing else.
 *
 * Drawn as an SVG stroke with the path's length normalised to 1, so the
 * offset is the fraction still to go. The retreat is a CSS transition, so
 * letting go mid-hold reverses from the value on screen. The arc itself is
 * written to directly while a hold runs (subscriptions.ts).
 */
function holdToStopRing(domId: string, shown: boolean, h: H): Html {
  return h.svg([
    h.AriaHidden(true),
    h.Attribute("viewBox", "0 0 48 48"),
    // Turned a quarter back so the arc starts at twelve o'clock. The colour
    // is the Stop button's own fill, so the ring reads as part of it.
    h.Class("pointer-events-none absolute -left-1 -top-1 size-[calc(100%+8px)] -rotate-90 text-slate-600 dark:text-white"),
    h.Style({ visibility: shown ? "visible" : "hidden" }),
  ], [
    // The whole ring, faint, so the arc has somewhere to be going.
    h.circle([
      h.Attribute("cx", "24"),
      h.Attribute("cy", "24"),
      h.Attribute("r", "23"),
      h.Attribute("fill", "none"),
      h.Attribute("stroke", "currentColor"),
      h.Attribute("stroke-opacity", "0.2"),
      h.Attribute("stroke-width", "2"),
    ]),
    h.circle([
      h.Attribute("cx", "24"),
      h.Attribute("cy", "24"),
      h.Attribute("r", "23"),
      h.Attribute("fill", "none"),
      h.Attribute("stroke", "currentColor"),
      h.Attribute("stroke-width", "2"),
      h.Attribute("pathLength", "1"),
      h.Attribute("stroke-dasharray", "1"),
      h.DataAttribute("hold-arc", domId),
      // The release. Reduced motion keeps the ring (it is the only sign a
      // hold is running) and drops the eased run back for an instant one.
      h.Class("transition-[stroke-dashoffset] duration-[120ms] ease-snappy motion-reduce:transition-none"),
      h.Style({ "stroke-dashoffset": "1" }),
    ]),
  ])
}

/**
 * Says the key has to be held, for a moment after a tap. Without it a tap
 * that used to stop the turn now seems to do nothing. The spoken copy is
 * always in the tree, so that filling it in is announced.
 */
function holdToStopHint(shown: boolean, h: H): ReadonlyArray<Html> {
  return [
    h.span([h.Role("status"), h.Class("sr-only")], [shown ? "Hold Escape to stop" : ""]),
    shown
      ? h.span([
        h.AriaHidden(true),
        h.Class("pointer-events-none absolute bottom-full right-0 z-30 mb-2.5 whitespace-nowrap rounded-md border border-border bg-card px-2.5 py-1 text-xs text-card-foreground"),
      ], ["Hold ", h.kbd([h.Class("font-sans font-medium")], ["Esc"]), " to stop"])
      : null,
  ].filter((node): node is Html => node !== null)
}

export { fileInputSelector, holdArcSelector }
