import { Effect, Schema } from "effect"
import { Command, Submodel } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { editorPresetFromOpenAppValue, resolveEffectiveEditorPreset } from "../../client/lib/effective-editor"
import { formatKeybindingInput, getResolvedKeybindings, KEYBINDING_ACTION_LABELS, parseKeybindingInput } from "../../client/lib/keybindings"
import { cn } from "../../client/lib/utils"
import { getKeybindingsFilePathDisplay } from "../../shared/branding"
import { getEditorPresetLabel } from "../../shared/editor-presets"
import { DEFAULT_KEYBINDINGS, type KeybindingAction } from "../../shared/types"
import { AppAction } from "../app/action"
import { errorMessage, sendCommand } from "../core/socket"
import { Code } from "../ui/icons"
import { input } from "../ui/input"
import { makeSectionMount } from "./activeSection"
import { requestActions, sectionLabel, type AppModel, type SectionReturn, type SectionViewInputs } from "./section"
import {
  BlurActiveElement,
  Draft,
  draftText,
  getKeybindingsSubtitle,
  sectionContainer,
  SETTINGS_CONTROL_CLASS,
  SETTINGS_INLINE_ACTION_CLASS,
  settingsActionButton,
  settingsErrorBanner,
  settingsGroup,
  settingsNotice,
  settingsRow,
} from "./shared"

// Settings › Keybindings (app/settings/KeybindingsSection.tsx), with the
// page header's "Open in …" (SettingsPage).

const KEYBINDING_ACTIONS = Object.keys(KEYBINDING_ACTION_LABELS) as KeybindingAction[]
const KeybindingActionSchema = Schema.Literals(KEYBINDING_ACTIONS as [KeybindingAction, ...KeybindingAction[]])

function buildKeybindingPayload(source: Record<string, string>): Record<KeybindingAction, string[]> {
  return {
    toggleEmbeddedTerminal: parseKeybindingInput(source.toggleEmbeddedTerminal ?? ""),
    toggleRightSidebar: parseKeybindingInput(source.toggleRightSidebar ?? ""),
    openInFinder: parseKeybindingInput(source.openInFinder ?? ""),
    openInEditor: parseKeybindingInput(source.openInEditor ?? ""),
    addSplitTerminal: parseKeybindingInput(source.addSplitTerminal ?? ""),
    jumpToSidebarChat: parseKeybindingInput(source.jumpToSidebarChat ?? ""),
    createChatInCurrentProject: parseKeybindingInput(source.createChatInCurrentProject ?? ""),
    openAddProject: parseKeybindingInput(source.openAddProject ?? ""),
    openCommandPalette: parseKeybindingInput(source.openCommandPalette ?? ""),
    toggleFocusMode: parseKeybindingInput(source.toggleFocusMode ?? ""),
  }
}

/** Where the keybindings live, as the header names and opens it. */
export function keybindingsFilePathDisplay(app: AppModel) {
  return getResolvedKeybindings(app.keybindings).filePathDisplay || getKeybindingsFilePathDisplay()
}

/**
 * useKannaState's editorLabel: every plain "Open in X" names the editor the
 * navbar button would open.
 */
export function editorLabel(app: AppModel) {
  return getEditorPresetLabel(resolveEffectiveEditorPreset({
    preferred: app.stores.terminalPreferences.editorPreset,
    remembered: editorPresetFromOpenAppValue(app.stores.openDestination.value),
    installedEditors: app.stores.appSettings.settings?.installedEditors ?? null,
  }))
}

function currentValue(app: AppModel, action: KeybindingAction) {
  return formatKeybindingInput(getResolvedKeybindings(app.keybindings).bindings[action])
}

// MODEL

export const Model = Schema.Struct({
  drafts: Schema.Record(Schema.String, Draft),
  error: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export function init(): Model {
  return { drafts: {}, error: null }
}

// MESSAGE

export const Message = defineMessageUnion({
  MountedSection: {},
  UnmountedSection: {},
  ClickedOpenInEditor: {},
  ChangedBinding: { action: KeybindingActionSchema, text: Schema.String, base: Schema.String },
  BlurredBinding: {},
  PressedBindingKey: { key: Schema.String },
  ClickedRestoreDefault: { action: KeybindingActionSchema },
  SucceededWriteKeybindings: {},
  FailedWriteKeybindings: { error: Schema.String },
  CompletedBlurActiveElement: {},
})
export type Message = typeof Message.Type

type Return = SectionReturn<Model, Message>

export const WriteKeybindings = Command.define("WriteKeybindings", {
  args: { bindings: Schema.Record(Schema.String, Schema.Array(Schema.String)) },
  messages: [Message.SucceededWriteKeybindings, Message.FailedWriteKeybindings],
  execute: ({ bindings }) => sendCommand({ type: "settings.writeKeybindings", bindings: bindings as Record<KeybindingAction, string[]> }).pipe(
    Effect.as(Message.SucceededWriteKeybindings()),
    Effect.catch((error) => Effect.succeed(Message.FailedWriteKeybindings({ error: errorMessage(error) || "Unable to save keybindings." }))),
  ),
})

const blurActiveElement = Command.mapMessage(BlurActiveElement(), () => Message.CompletedBlurActiveElement())

function draftTexts(model: Model, app: AppModel): Record<string, string> {
  return Object.fromEntries(KEYBINDING_ACTIONS.map((action) => [action, draftText(model.drafts[action] ?? null, currentValue(app, action))]))
}

function commit(model: Model, app: AppModel): Return {
  return {
    model: { ...model, error: null },
    commands: [WriteKeybindings({ bindings: buildKeybindingPayload(draftTexts(model, app)) })],
  }
}

export function update(model: Model, message: Message, app: AppModel): Return {
  return Message.match<Return>(message, {
    MountedSection: () => ({ model }),
    UnmountedSection: () => ({ model: init() }),
    ClickedOpenInEditor: () => requestActions(model, [AppAction.OpenExternalPath({ action: "open_editor", localPath: keybindingsFilePathDisplay(app) })]),
    ChangedBinding: ({ action, text, base }) => ({ model: { ...model, drafts: { ...model.drafts, [action]: { text, base } } } }),
    BlurredBinding: () => commit(model, app),
    PressedBindingKey: ({ key }) => {
      if (key !== "Enter") return { model }
      const committed = commit(model, app)
      return { ...committed, commands: [...(committed.commands ?? []), blurActiveElement] }
    },
    ClickedRestoreDefault: ({ action }) => {
      const next = { ...model, drafts: { ...model.drafts, [action]: { text: formatKeybindingInput(DEFAULT_KEYBINDINGS[action]), base: currentValue(app, action) } } }
      return commit(next, app)
    },
    SucceededWriteKeybindings: () => ({ model }),
    FailedWriteKeybindings: ({ error }) => ({ model: { ...model, error } }),
    CompletedBlurActiveElement: () => ({ model }),
  })
}

// VIEW

const SectionMount = makeSectionMount("SettingsKeybindingsSection", Message.MountedSection, () => Message.MountedSection())

export const view = Submodel.defineView<Model, Message, SectionViewInputs>((model, { app, switched }, h) => {
  const resolvedKeybindings = getResolvedKeybindings(app.keybindings)
  const texts = draftTexts(model, app)
  return sectionContainer({
    sectionId: "keybindings",
    switched,
    mount: SectionMount(),
    unmounted: Message.UnmountedSection(),
    label: sectionLabel("keybindings"),
    subtitle: getKeybindingsSubtitle(keybindingsFilePathDisplay(app)),
    action: settingsActionButton({ onClick: Message.ClickedOpenInEditor(), icon: Code({}, h) }, [`Open in ${editorLabel(app)}`], h),
  }, [
    model.error ? settingsErrorBanner(model.error, h) : null,
    resolvedKeybindings.warning
      ? settingsNotice({ tone: "warning", class: "mb-6" }, [resolvedKeybindings.warning], h)
      : null,
    settingsGroup({}, KEYBINDING_ACTIONS.map((action) => {
      const defaultValue = formatKeybindingInput(DEFAULT_KEYBINDINGS[action])
      const value = texts[action] ?? ""
      const showRestore = value !== defaultValue
      const base = currentValue(app, action)
      return settingsRow({
        key: action,
        wideControl: true,
        title: KEYBINDING_ACTION_LABELS[action],
        description: [
          h.span([], ["Comma-separated shortcuts."]),
          ...(showRestore
            ? [
              " ",
              h.button([
                h.Type("button"),
                h.OnClick(Message.ClickedRestoreDefault({ action })),
                h.Class(SETTINGS_INLINE_ACTION_CLASS),
              ], [`Reset to ${defaultValue}`]),
            ]
            : []),
        ],
      }, [
        input({
          type: "text",
          value,
          class: cn(SETTINGS_CONTROL_CLASS, "font-mono"),
          onInput: (text) => Message.ChangedBinding({ action, text, base }),
          attributes: [
            h.OnBlur(Message.BlurredBinding()),
            h.OnKeyDown((key) => Message.PressedBindingKey({ key })),
            h.Spellcheck(false),
            h.Autocomplete("off"),
          ],
        }, h),
      ], h)
    }), h),
  ], h)
})
