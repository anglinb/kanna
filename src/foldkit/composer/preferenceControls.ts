import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import {
  DEFAULT_CLAUDE_MODEL_OPTIONS,
  resolveModelLabel,
  type AgentProvider,
  type ChatMode,
  type ClaudeContextWindow,
  type CodexModelOptions,
  type ProviderCatalogEntry,
  type ProviderModelOption,
} from "../../shared/types"
import { cn } from "../../client/lib/utils"
import type { ComposerState } from "../core/stores/chatPreferences"
import type { Child } from "../ui/attributes"
import type { Icon } from "../ui/icon"
import * as Icons from "../ui/icons"
import * as Popover from "../ui/popover"
import { PROVIDER_ICONS } from "../ui/provider-icons"
import { CHAT_MODE_LABELS, deriveComposerOptionControls } from "./controls"

// ChatPreferenceControls.tsx: the options row's pickers (harness, model,
// effort, context window, speed, mode), each an InputPopover of
// PopoverMenuItems. The parent holds one Popover.Model per picker and hears
// the picks as its own Messages.

/** Flush table-like row inside an InputPopover: flat edges, divider-separated. */
export function popoverMenuItem<Message>(options: {
  /** What a click says; or `attributes`, a click handled elsewhere (the page's). */
  onClick?: Message
  attributes?: ReadonlyArray<ChildAttribute>
  selected: boolean
  icon: Html
  label: ReadonlyArray<Child>
  description?: string
  disabled?: boolean
  /** Right-aligned adornment (e.g. a "Sign In" pill). */
  trailing?: Html
  key: string
}, h: HtmlBuilder<Message>): Html {
  return h.keyed("button")(options.key, [
    ...(options.onClick !== undefined ? [h.OnClick(options.onClick)] : []),
    ...(options.attributes ?? []),
    ...(options.disabled ? [h.Disabled(true)] : []),
    h.Class(cn(
      "w-full flex items-center gap-2 text-left [&>svg]:shrink-0 px-3 py-2 transition-colors",
      options.selected ? "bg-muted" : "hover:bg-muted/50",
      options.disabled && "opacity-40 cursor-not-allowed",
    )),
  ], [
    options.icon,
    h.div([h.Class("min-w-0 flex-1")], [
      h.div([h.Class("text-sm font-medium")], options.label),
      options.description ? h.div([h.Class("text-xs text-muted-foreground")], [options.description]) : null,
    ]),
    options.trailing ?? null,
  ])
}

export interface InputPopoverOptions<Message> {
  /** The picker's Popover.Model (the parent's), and how its Messages come back. */
  popover: Popover.Model
  slotId: string
  toParentMessage: (message: Popover.Message) => Message
  trigger: ReadonlyArray<Child>
  triggerClassName?: string
  disabled?: boolean
  /** Why it is disabled, as the control's tooltip. */
  disabledTitle?: string
  /** Where the panel lines up with the trigger. */
  align?: "start" | "center" | "end"
  content: () => ReadonlyArray<Child>
}

export function inputPopover<Message>(options: InputPopoverOptions<Message>, h: HtmlBuilder<Message>): Html {
  if (options.disabled) {
    return h.button([
      h.Disabled(true),
      ...(options.disabledTitle !== undefined ? [h.Title(options.disabledTitle)] : []),
      h.Class(cn(
        "flex items-center gap-1.5 px-2 py-1 text-sm rounded-md text-muted-foreground [&>svg]:shrink-0 opacity-70 cursor-default [&>span]:whitespace-nowrap",
        options.triggerClassName,
      )),
    ], options.trigger)
  }
  return h.submodel({
    slotId: options.slotId,
    model: options.popover,
    view: Popover.view,
    viewInputs: {
      align: options.align ?? "center",
      className: "w-64 overflow-hidden p-0",
      // Runtime-discovered model lists (e.g. Cursor) can be long: scroll
      // instead of overflowing the viewport.
      content: () => [h.div([h.Class("max-h-80 overflow-y-auto divide-y divide-border/60")], options.content())],
      toView: ({ trigger, portal }) => h.button([
        ...trigger,
        h.Class(cn(
          "flex items-center gap-1.5 px-2 py-1 text-sm rounded-md transition-colors text-muted-foreground [&>svg]:shrink-0 [&>span]:whitespace-nowrap",
          "hover:bg-muted/50",
          options.triggerClassName,
        )),
      ], [...options.trigger, portal]),
    },
    toParentMessage: options.toParentMessage,
  })
}

const MODE_ICONS: Record<ChatMode, Icon> = {
  "full-access": Icons.LockOpen,
  "plan": Icons.ListTodo,
  "auto-plan": Icons.Sparkles,
}

export type PreferencePicker = "provider" | "model" | "reasoning" | "contextWindow" | "fastMode" | "mode"

export interface PreferenceControlsInputs<Message> {
  availableProviders: ReadonlyArray<ProviderCatalogEntry>
  selectedProvider: AgentProvider
  showProviderPicker?: boolean
  providerLocked?: boolean
  /** A harness switch is staged for this chat and applies on the next send. */
  providerSwitchPending?: boolean
  model: string
  modelOptions: ComposerState["modelOptions"]
  mode?: ChatMode
  includeMode?: boolean
  /** Retires the context-window and mode pills while they hold the factory default. */
  hideDefaults?: boolean
  className?: string
  /** Drawn first in the row, before the harness. */
  leading?: Html
  /** The values shown are another chat's: every control is dimmed and opens nothing. */
  readOnly?: boolean
  readOnlyTitle?: string
  /** Harnesses to show "Sign In" against, sunk to the bottom of the picker. */
  unauthenticated: ReadonlySet<AgentProvider>
  popovers: Record<PreferencePicker, Popover.Model>
  /** The model picker's filter, for long lists. */
  modelQuery: string
  /** "Add models…" under pi's models, when given: the page's handler (`requests.editModels`). */
  editModels?: ReadonlyArray<ChildAttribute>
  toPopoverMessage: (name: PreferencePicker, message: Popover.Message) => Message
  onProviderChange?: (provider: AgentProvider) => Message
  onModelChange: (model: string) => Message
  onModelQueryChange: (query: string) => Message
  onReasoningEffortChange: (effort: string) => Message
  onContextWindowChange: (contextWindow: ClaudeContextWindow) => Message
  onFastModeChange: (fastMode: boolean) => Message
  onModeChange?: (mode: ChatMode) => Message
}

/**
 * Model picker body with an optional filter box. The box is shown only for
 * long lists (e.g. the runtime-discovered Cursor catalog) so short provider
 * lists stay a plain menu.
 */
function modelPickerList<Message>(options: {
  models: ReadonlyArray<ProviderModelOption>
  selectedModel: string
  query: string
  onQueryChange: (query: string) => Message
  onSelect: (modelId: string) => Message
  renderLabel: (candidate: ProviderModelOption) => ReadonlyArray<Child>
  footer: Html
  searchThreshold?: number
}, h: HtmlBuilder<Message>): ReadonlyArray<Child> {
  const showSearch = options.models.length > (options.searchThreshold ?? 12)
  const trimmed = options.query.trim().toLowerCase()
  const filtered = trimmed
    ? options.models.filter((model) => model.id.toLowerCase().includes(trimmed) || model.label.toLowerCase().includes(trimmed))
    : options.models
  return [
    showSearch
      ? h.div([h.Class("sticky top-0 z-10 flex items-center gap-2 bg-popover px-3 py-2")], [
        Icons.Search({ class: "h-4 w-4 shrink-0 text-muted-foreground" }, h),
        h.input([
          h.Value(options.query),
          h.OnInput(options.onQueryChange),
          h.Placeholder("Filter models…"),
          h.Spellcheck(false),
          h.Attribute("autocapitalize", "off"),
          h.Attribute("autocorrect", "off"),
          h.Class("w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"),
        ]),
      ])
      : null,
    ...(filtered.length === 0
      ? [h.div([h.Class("px-3 py-2 text-sm text-muted-foreground")], ["No matching models"])]
      : filtered.map((candidate) => popoverMenuItem({
        key: candidate.id,
        onClick: options.onSelect(candidate.id),
        selected: options.selectedModel === candidate.id,
        icon: Icons.Box({ class: "h-4 w-4 text-muted-foreground" }, h),
        label: options.renderLabel(candidate),
      }, h))),
    options.footer,
  ]
}

export function preferenceControls<Message>(inputs: PreferenceControlsInputs<Message>, h: HtmlBuilder<Message>): Html {
  const {
    availableProviders,
    selectedProvider,
    model,
    modelOptions,
    readOnly = false,
    readOnlyTitle,
    unauthenticated,
  } = inputs
  const mode = inputs.mode ?? "full-access"
  const providerConfig = availableProviders.find((provider) => provider.id === selectedProvider) ?? availableProviders[0]!
  // Keep the catalog's order, but sink disconnected harnesses to the bottom
  // of the picker so the ready-to-use ones are always the first reach.
  const pickerProviders = unauthenticated.size === 0
    ? availableProviders
    : [
      ...availableProviders.filter((provider) => !unauthenticated.has(provider.id)),
      ...availableProviders.filter((provider) => unauthenticated.has(provider.id)),
    ]
  const selectedProviderLabel = selectedProvider === "claude" ? "Claude" : providerConfig?.label ?? selectedProvider
  const ProviderIcon = PROVIDER_ICONS[selectedProvider]
  const codexModelOptions = selectedProvider === "codex" ? modelOptions as CodexModelOptions : null
  // Central availability registry (shared with the command palette): which
  // option controls exist for this provider/model and their current values.
  const controls = deriveComposerOptionControls(
    { provider: selectedProvider, model, modelOptions, planMode: mode === "plan", autoPlan: mode === "auto-plan" } as ComposerState,
    providerConfig,
  )
  const modeControl = (inputs.includeMode ?? true) && inputs.onModeChange && !(inputs.hideDefaults && controls.mode?.selected === "full-access")
    ? controls.mode
    : null
  const contextWindowControl = inputs.hideDefaults && controls.contextWindow?.selectedId === DEFAULT_CLAUDE_MODEL_OPTIONS.contextWindow
    ? null
    : controls.contextWindow
  const ContextWindowIcon = controls.contextWindow?.selectedId === "1m" ? Icons.SquareMenu : Icons.SquareMinus

  const picker = (name: PreferencePicker, rest: Omit<InputPopoverOptions<Message>, "popover" | "slotId" | "toParentMessage">) =>
    inputPopover({
      popover: inputs.popovers[name],
      slotId: `preference-${name}`,
      toParentMessage: (message) => inputs.toPopoverMessage(name, message),
      ...rest,
    }, h)

  return h.div([h.Class(cn("flex md:justify-center items-center gap-0.5", inputs.className))], [
    inputs.leading ?? null,
    (inputs.showProviderPicker ?? true)
      ? picker("provider", {
        disabled: readOnly || (inputs.providerLocked ?? false) || !inputs.onProviderChange,
        ...(readOnly && readOnlyTitle !== undefined ? { disabledTitle: readOnlyTitle } : {}),
        trigger: [ProviderIcon({ class: "h-3.5 w-3.5" }, h), h.span([], [selectedProviderLabel])],
        // Amber = staged harness switch (applies on the next message).
        ...(inputs.providerSwitchPending ? { triggerClassName: "text-amber-500 dark:text-amber-400" } : {}),
        content: () => pickerProviders.map((provider) => popoverMenuItem({
          key: provider.id,
          onClick: inputs.onProviderChange!(provider.id),
          selected: selectedProvider === provider.id,
          icon: PROVIDER_ICONS[provider.id]({ class: "h-4 w-4 text-muted-foreground" }, h),
          label: [provider.label],
          ...(unauthenticated.has(provider.id)
            ? { trailing: h.span([h.Class("shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground")], ["Sign In"]) }
            : {}),
        }, h)),
      })
      : null,

    picker("model", {
      disabled: readOnly,
      ...(readOnlyTitle !== undefined ? { disabledTitle: readOnlyTitle } : {}),
      trigger: [Icons.Box({ class: "h-3.5 w-3.5" }, h), h.span([], [resolveModelLabel(providerConfig.models, model)])],
      content: () => modelPickerList({
        models: providerConfig.models,
        selectedModel: model,
        query: inputs.modelQuery,
        onQueryChange: inputs.onModelQueryChange,
        onSelect: inputs.onModelChange,
        renderLabel: (candidate) => candidate.id === "gpt-5.6-luna" && codexModelOptions?.reasoningEffort === "ultra"
          ? [candidate.label, " ", h.span([h.Class("text-xs font-normal text-muted-foreground")], ["Ultra → Max"])]
          : [candidate.label],
        footer: selectedProvider === "pi" && inputs.editModels
          ? popoverMenuItem({
            key: "add-models",
            attributes: inputs.editModels,
            selected: false,
            icon: Icons.Plus({ class: "h-4 w-4 text-muted-foreground" }, h),
            label: ["Add models…"],
          }, h)
          : null,
      }, h),
    }),

    controls.reasoning
      ? picker("reasoning", {
        disabled: readOnly,
        ...(readOnlyTitle !== undefined ? { disabledTitle: readOnlyTitle } : {}),
        trigger: [
          Icons.Brain({ class: "h-3.5 w-3.5" }, h),
          h.span([], [
            controls.reasoning.options.find((effort) => effort.id === controls.reasoning?.selectedId)?.label
              ?? controls.reasoning.selectedId
              ?? "",
          ]),
        ],
        content: () => (controls.reasoning?.options ?? []).map((effort) => popoverMenuItem({
          key: effort.id,
          onClick: inputs.onReasoningEffortChange(effort.id),
          selected: controls.reasoning?.selectedId === effort.id,
          icon: Icons.Brain({ class: "h-4 w-4 text-muted-foreground" }, h),
          label: [effort.label],
          ...(effort.description ? { description: effort.description } : {}),
          ...(effort.disabled ? { disabled: true } : {}),
        }, h)),
      })
      : null,

    contextWindowControl
      ? picker("contextWindow", {
        disabled: readOnly,
        ...(readOnlyTitle !== undefined ? { disabledTitle: readOnlyTitle } : {}),
        trigger: [
          ContextWindowIcon({ class: "h-3.5 w-3.5" }, h),
          h.span([], [
            contextWindowControl.options.find((option) => option.id === contextWindowControl.selectedId)?.label
              ?? contextWindowControl.selectedId,
          ]),
        ],
        content: () => contextWindowControl.options.map((option) => popoverMenuItem({
          key: option.id,
          onClick: inputs.onContextWindowChange(option.id as ClaudeContextWindow),
          selected: contextWindowControl.selectedId === option.id,
          icon: option.id === "1m"
            ? Icons.SquareMenu({ class: "h-4 w-4 text-muted-foreground" }, h)
            : Icons.SquareMinus({ class: "h-4 w-4 text-muted-foreground" }, h),
          label: [option.label],
        }, h)),
      })
      : null,

    controls.fastMode
      ? (() => {
        const fastEnabled = controls.fastMode.enabled
        const fastLabel = selectedProvider === "cursor" ? "Fast" : "Fast Mode"
        return picker("fastMode", {
          disabled: readOnly,
          ...(readOnlyTitle !== undefined ? { disabledTitle: readOnlyTitle } : {}),
          trigger: [
            fastEnabled ? Icons.Gauge({ class: "h-3.5 w-3.5" }, h) : Icons.Gauge({ class: "h-3.5 w-3.5 -scale-x-100" }, h),
            h.span([], [fastEnabled ? fastLabel : "Standard"]),
          ],
          ...(fastEnabled ? { triggerClassName: "text-emerald-500 dark:text-emerald-400" } : {}),
          content: () => [
            popoverMenuItem({
              key: "standard",
              onClick: inputs.onFastModeChange(false),
              selected: !fastEnabled,
              icon: Icons.Gauge({ class: "h-4 w-4 text-muted-foreground -scale-x-100" }, h),
              label: ["Standard"],
            }, h),
            popoverMenuItem({
              key: "fast",
              onClick: inputs.onFastModeChange(true),
              selected: fastEnabled,
              icon: Icons.Gauge({ class: "h-4 w-4 text-muted-foreground" }, h),
              label: [fastLabel],
              ...(selectedProvider === "cursor" ? { description: "Faster responses, higher usage" } : {}),
            }, h),
          ],
        })
      })()
      : null,

    modeControl && inputs.onModeChange
      ? picker("mode", {
        disabled: readOnly,
        ...(readOnlyTitle !== undefined ? { disabledTitle: readOnlyTitle } : {}),
        trigger: [MODE_ICONS[modeControl.selected]({ class: "h-3.5 w-3.5" }, h), h.span([], [CHAT_MODE_LABELS[modeControl.selected].label])],
        ...(modeControl.selected === "plan" ? { triggerClassName: "text-blue-400 dark:text-blue-300" } : {}),
        content: () => modeControl.options.map((option) => popoverMenuItem({
          key: option,
          onClick: inputs.onModeChange!(option),
          selected: modeControl.selected === option,
          icon: MODE_ICONS[option]({ class: "h-4 w-4 text-muted-foreground" }, h),
          label: [CHAT_MODE_LABELS[option].label],
          description: CHAT_MODE_LABELS[option].description,
        }, h)),
      })
      : null,
  ])
}
