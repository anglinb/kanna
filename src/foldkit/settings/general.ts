import { Effect, Schema } from "effect"
import { Command, Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { requestChatBrowserNotificationPermission } from "../../client/lib/chatBrowserNotifications"
import { playChatNotificationSound } from "../../client/lib/chatSounds"
import { cn } from "../../client/lib/utils"
import { ANALYTICS_STATIC_EVENT_NAMES, ANALYTICS_STATIC_PROPERTY_NAMES } from "../../shared/analytics"
import type { EditorPreset } from "../../shared/protocol"
import {
  DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES,
  MAX_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES,
  MIN_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES,
} from "../../shared/transcript-window"
import {
  DEFAULT_NEW_PROJECTS_DIRECTORY,
  isNightlyVersion,
  type AppSettingsPatch,
  type ChatBrowserNotificationPreference,
  type ChatSoundId,
  type ChatSoundPreference,
  type PaneVisibilityScope,
  type SubmitWhileRunning,
} from "../../shared/types"
import { AppAction } from "../app/action"
import * as Stores from "../app/stores"
import { themePreference, type ThemePreference } from "../app/theme"
import * as ChatSoundPreferences from "../core/stores/chatSoundPreferences"
import * as TerminalPreferences from "../core/stores/terminalPreferences"
import { button } from "../ui/button"
import * as Dialog from "../ui/dialog"
import { DownloadCloud } from "../ui/icons"
import { input } from "../ui/input"
import * as Select from "../ui/select"
import { switchControl } from "../ui/switch"
import { EDITOR_OPTIONS, editorIcon } from "./icons"
import { SETTINGS_ROWS } from "./registry"
import { makeSectionMount } from "./activeSection"
import { liftChild, requestActions, sectionSubtitle, type AppModel, type SectionReturn, type SectionViewInputs } from "./section"
import {
  BlurActiveElement,
  Draft,
  draftText,
  resolveChatBrowserNotificationPreferenceAfterPermission,
  sectionContainer,
  SETTINGS_CONTROL_CLASS,
  SETTINGS_INLINE_ACTION_CLASS,
  SETTINGS_NUMBER_INPUT_CLASS,
  settingsActionButton,
  settingsErrorBanner,
  settingsField,
  settingsGroup,
  settingsGroups,
  settingsRow,
  settingsSelect,
  shouldPreviewChatSoundChange,
} from "./shared"

// Settings › General (app/settings/GeneralSection.tsx).

const themeOptions: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
]

const chatSoundPreferenceOptions: { value: ChatSoundPreference; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "unfocused", label: "When Unfocused" },
  { value: "always", label: "Always" },
]

const paneVisibilityScopeOptions: { value: PaneVisibilityScope; label: string }[] = [
  { value: "chat", label: "Per Chat" },
  { value: "project", label: "Per Project" },
]

const chatBrowserNotificationPreferenceOptions: { value: ChatBrowserNotificationPreference; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "unfocused", label: "When Unfocused" },
  { value: "always", label: "Always" },
]

const submitWhileRunningOptions: { value: SubmitWhileRunning; label: string }[] = [
  { value: "queue", label: "Queue message" },
  { value: "steer", label: "Steer now" },
]

// MODEL

const SELECT_IDS = [
  "theme",
  "chatSounds",
  "chatSound",
  "chatBrowserNotifications",
  "submitWhileRunning",
  "widgetsVisibility",
  "terminalVisibility",
  "defaultEditor",
] as const
const SelectId = Schema.Literals(SELECT_IDS)
type SelectId = typeof SelectId.Type

const FIELD_IDS = ["transcriptWindow", "editorCommand", "newProjectsDirectory", "scrollback", "minColumnWidth"] as const
const FieldId = Schema.Literals(FIELD_IDS)
type FieldId = typeof FieldId.Type

export const Model = Schema.Struct({
  selects: Schema.Struct(Object.fromEntries(SELECT_IDS.map((id) => [id, Select.Model])) as Record<SelectId, typeof Select.Model>),
  drafts: Schema.Struct(Object.fromEntries(FIELD_IDS.map((id) => [id, Schema.NullOr(Draft)])) as Record<FieldId, Schema.NullOr<typeof Draft>>),
  error: Schema.NullOr(Schema.String),
  analyticsDialog: Dialog.Model,
})
export type Model = typeof Model.Type

export function init(): Model {
  return {
    selects: Object.fromEntries(SELECT_IDS.map((id) => [id, Select.init({ id: `settings-general-${id}` })])) as Model["selects"],
    drafts: Object.fromEntries(FIELD_IDS.map((id) => [id, null])) as Model["drafts"],
    error: null,
    analyticsDialog: Dialog.init({ id: "settings-tracked-events" }),
  }
}

// MESSAGE

export const Message = defineMessageUnion({
  MountedSection: {},
  UnmountedSection: {},
  GotSelectMessage: { id: SelectId, message: Select.Message },
  GotAnalyticsDialogMessage: { message: Dialog.Message },
  ClickedChangelog: {},
  ClickedInstallUpdate: {},
  ClickedCheckForUpdates: {},
  ToggledProjectIconsInChats: { checked: Schema.Boolean },
  ToggledChatTabs: { checked: Schema.Boolean },
  ToggledWidgetsPeek: { checked: Schema.Boolean },
  ToggledAnalytics: { checked: Schema.Boolean },
  ChangedField: { id: FieldId, text: Schema.String, base: Schema.String },
  BlurredField: { id: FieldId },
  PressedFieldKey: { id: FieldId, key: Schema.String },
  ClickedViewTrackedEvents: {},
  ClickedCloseTrackedEvents: {},
  ResolvedNotificationPermission: { requested: Schema.String, permission: Schema.String },
  CompletedPreviewChatSound: {},
  CompletedBlurActiveElement: {},
})
export type Message = typeof Message.Type

type Return = SectionReturn<Model, Message>

// COMMANDS

const PreviewChatSound = Command.define("PreviewChatSound", {
  args: { soundId: Schema.String },
  messages: [Message.CompletedPreviewChatSound],
  execute: ({ soundId }) => Effect.promise(() => playChatNotificationSound(soundId as ChatSoundId, 1).catch(() => undefined)).pipe(
    Effect.as(Message.CompletedPreviewChatSound()),
  ),
})

// The permission prompt is the browser's, and it only appears here, on the
// user's own click.
const RequestNotificationPermission = Command.define("RequestChatNotificationPermission", {
  args: { requested: Schema.String },
  messages: [Message.ResolvedNotificationPermission],
  execute: ({ requested }) => Effect.promise(async () => {
    try {
      const permission = requested === "never" ? "granted" : await requestChatBrowserNotificationPermission()
      return Message.ResolvedNotificationPermission({ requested, permission })
    } catch {
      return Message.ResolvedNotificationPermission({ requested, permission: "unsupported" })
    }
  }),
})

const blurActiveElement = Command.mapMessage(BlurActiveElement(), () => Message.CompletedBlurActiveElement())

// UPDATE

const write = (patch: AppSettingsPatch) => AppAction.WriteAppSettings({ patch })
const terminalPreferences = (message: TerminalPreferences.Message) =>
  AppAction.Store({ message: Stores.Message.GotTerminalPreferencesMessage({ message }) })
const chatSoundPreferences = (message: ChatSoundPreferences.Message) =>
  AppAction.Store({ message: Stores.Message.GotChatSoundPreferencesMessage({ message }) })

function selectedValue(model: Model, id: SelectId, value: string, app: AppModel): Return {
  switch (id) {
    case "theme":
      return requestActions(model, [write({ theme: value as ThemePreference })])
    case "chatSounds": {
      const current = app.stores.chatSoundPreferences.chatSoundPreference
      if (!shouldPreviewChatSoundChange(current, value)) return { model }
      return requestActions(
        model,
        [chatSoundPreferences(ChatSoundPreferences.Message.ChangedChatSoundPreference({ value })), write({ chatSoundPreference: value as ChatSoundPreference })],
        [PreviewChatSound({ soundId: app.stores.chatSoundPreferences.chatSoundId })],
      )
    }
    case "chatSound": {
      const current = app.stores.chatSoundPreferences.chatSoundId
      if (!shouldPreviewChatSoundChange(current, value)) return { model }
      return requestActions(
        model,
        [chatSoundPreferences(ChatSoundPreferences.Message.ChangedChatSoundId({ value })), write({ chatSoundId: value as ChatSoundId })],
        [PreviewChatSound({ soundId: value })],
      )
    }
    case "chatBrowserNotifications":
      if (app.stores.chatSoundPreferences.chatBrowserNotificationPreference === value) return { model }
      return { model, commands: [RequestNotificationPermission({ requested: value })] }
    case "submitWhileRunning":
      return requestActions(model, [write({ submitWhileRunning: value as SubmitWhileRunning })])
    case "widgetsVisibility":
      return requestActions(model, [write({ paneVisibility: { widgets: value as PaneVisibilityScope } })])
    case "terminalVisibility":
      return requestActions(model, [write({ paneVisibility: { terminal: value as PaneVisibilityScope } })])
    case "defaultEditor": {
      const nextPreset = value as EditorPreset
      const commandTemplate = nextPreset === "custom"
        ? app.stores.terminalPreferences.editorCommandTemplate
        : TerminalPreferences.getDefaultEditorCommandTemplate(nextPreset)
      return requestActions(model, [
        terminalPreferences(TerminalPreferences.Message.ChangedEditorPreset({ editorPreset: nextPreset })),
        write({ editor: { preset: nextPreset, commandTemplate } }),
      ])
    }
  }
}

/** The stored value each field mirrors, as the text it shows when there is no draft. */
export function fieldValue(id: FieldId, app: AppModel): string {
  const settings = app.stores.appSettings.settings
  const terminal = app.stores.terminalPreferences
  switch (id) {
    case "transcriptWindow":
      return String(settings?.transcript?.windowAssistantMessages ?? DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES)
    case "editorCommand":
      return terminal.editorCommandTemplate
    case "newProjectsDirectory":
      return settings?.newProjectsDirectory ?? DEFAULT_NEW_PROJECTS_DIRECTORY
    case "scrollback":
      return String(terminal.scrollbackLines)
    case "minColumnWidth":
      return String(terminal.minColumnWidth)
  }
}

function withDraft(model: Model, id: FieldId, draft: Draft | null): Model {
  return { ...model, drafts: { ...model.drafts, [id]: draft } }
}

function commitField(model: Model, id: FieldId, app: AppModel): Return {
  const current = fieldValue(id, app)
  const text = draftText(model.drafts[id], current)
  switch (id) {
    case "transcriptWindow": {
      const nextValue = Math.round(Number(text))
      if (!Number.isFinite(nextValue)) return { model: withDraft(model, id, null) }
      return requestActions(model, [write({ transcript: { windowAssistantMessages: nextValue } })])
    }
    case "scrollback": {
      const nextValue = Number(text)
      if (!Number.isFinite(nextValue)) return { model: withDraft(model, id, null) }
      return requestActions(model, [
        terminalPreferences(TerminalPreferences.Message.ChangedScrollbackLines({ scrollbackLines: nextValue })),
        write({ terminal: { scrollbackLines: nextValue } }),
      ])
    }
    case "minColumnWidth": {
      const nextValue = Number(text)
      if (!Number.isFinite(nextValue)) return { model: withDraft(model, id, null) }
      return requestActions(model, [
        terminalPreferences(TerminalPreferences.Message.ChangedMinColumnWidth({ minColumnWidth: nextValue })),
        write({ terminal: { minColumnWidth: nextValue } }),
      ])
    }
    case "editorCommand":
      return requestActions(model, [
        terminalPreferences(TerminalPreferences.Message.ChangedEditorCommandTemplate({ editorCommandTemplate: text })),
        write({ editor: { commandTemplate: text } }),
      ])
    case "newProjectsDirectory": {
      const trimmed = text.trim()
      if (trimmed === current) return { model: withDraft(model, id, null) }
      // The server normalizes an empty value back to the default; the
      // snapshot round-trips into the field.
      return requestActions(model, [write({ newProjectsDirectory: trimmed || DEFAULT_NEW_PROJECTS_DIRECTORY })])
    }
  }
}

function foldDialog(model: Model, result: ReturnType<typeof Dialog.update>): Return {
  const lifted = liftChild(result, (analyticsDialog) => ({ ...model, analyticsDialog }), (message) => Message.GotAnalyticsDialogMessage({ message }))
  return { model: lifted.model, commands: lifted.commands }
}

export function update(model: Model, message: Message, app: AppModel): Return {
  return Message.match<Return>(message, {
    MountedSection: () => ({ model }),
    // The next visit starts over, as a remounted React section did.
    UnmountedSection: () => ({ model: init() }),
    GotSelectMessage: ({ id, message: child }) => {
      const lifted = liftChild(
        Select.update(model.selects[id], child),
        (select) => ({ ...model, selects: { ...model.selects, [id]: select } }),
        (selectMessage) => Message.GotSelectMessage({ id, message: selectMessage }),
      )
      if (!lifted.outMessage) return { model: lifted.model, commands: lifted.commands }
      const selected = selectedValue(lifted.model, id, lifted.outMessage.value, app)
      return { ...selected, commands: [...lifted.commands, ...(selected.commands ?? [])] }
    },
    GotAnalyticsDialogMessage: ({ message: child }) => foldDialog(model, Dialog.update(model.analyticsDialog, child)),
    ClickedChangelog: () => requestActions(model, [AppAction.Navigate({ path: "/settings/changelog", replace: false })]),
    ClickedInstallUpdate: () => requestActions(model, [AppAction.InstallUpdate()]),
    ClickedCheckForUpdates: () => requestActions(model, [AppAction.CheckForUpdates({ force: true })]),
    ToggledProjectIconsInChats: ({ checked }) => requestActions({ ...model, error: null }, [write({ projectIconsInChats: checked })]),
    ToggledChatTabs: ({ checked }) => requestActions({ ...model, error: null }, [write({ chatTabsEnabled: checked })]),
    ToggledWidgetsPeek: ({ checked }) => requestActions({ ...model, error: null }, [write({ widgetsPeekEnabled: checked })]),
    ToggledAnalytics: ({ checked }) => requestActions({ ...model, error: null }, [write({ analyticsEnabled: checked })]),
    ChangedField: ({ id, text, base }) => ({ model: withDraft(model, id, { text, base }) }),
    BlurredField: ({ id }) => commitField(model, id, app),
    PressedFieldKey: ({ id, key }) => {
      if (key !== "Enter") return { model }
      const committed = commitField(model, id, app)
      return { ...committed, commands: [...(committed.commands ?? []), blurActiveElement] }
    },
    ClickedViewTrackedEvents: () => foldDialog(model, Dialog.open(model.analyticsDialog)),
    ClickedCloseTrackedEvents: () => foldDialog(model, Dialog.close(model.analyticsDialog)),
    // A denied or unsupported prompt drops the setting back to Never rather
    // than saving an option that would never fire.
    ResolvedNotificationPermission: ({ requested, permission }) => {
      const resolved = resolveChatBrowserNotificationPreferenceAfterPermission(
        requested as ChatBrowserNotificationPreference,
        permission as NotificationPermission | "unsupported",
      )
      const blocked = requested !== "never" && resolved === "never"
      return requestActions(
        { ...model, error: blocked ? "Browser notifications are blocked or unsupported in this browser." : model.error },
        [chatSoundPreferences(ChatSoundPreferences.Message.ChangedChatBrowserNotificationPreference({ value: resolved })), write({ chatBrowserNotificationPreference: resolved })],
      )
    },
    CompletedPreviewChatSound: () => ({ model }),
    CompletedBlurActiveElement: () => ({ model }),
  })
}

// VIEW

function optionLabel(options: ReadonlyArray<{ value: string; label: string }>) {
  return (value: string) => [options.find((option) => option.value === value)?.label ?? value]
}

const renderTheme = optionLabel(themeOptions)
const renderChatSoundPreference = optionLabel(chatSoundPreferenceOptions)
const renderChatSound = optionLabel(ChatSoundPreferences.CHAT_SOUND_OPTIONS)
const renderBrowserNotification = optionLabel(chatBrowserNotificationPreferenceOptions)
const renderSubmitWhileRunning = optionLabel(submitWhileRunningOptions)
const renderPaneVisibility = optionLabel(paneVisibilityScopeOptions)

function updateStatusLabel(app: AppModel) {
  const updateSnapshot = app.updateSnapshot
  return updateSnapshot?.status === "checking"
    ? "Checking for updates…"
    : updateSnapshot?.status === "updating"
      ? "Installing update…"
      : updateSnapshot?.status === "restart_pending"
        ? "Restarting Kanna…"
        : updateSnapshot?.status === "available"
          ? `Update available${updateSnapshot.latestVersion ? `: ${updateSnapshot.latestVersion}` : ""}`
          : updateSnapshot?.status === "up_to_date"
            ? isNightlyVersion(updateSnapshot.currentVersion) ? "No newer stable release" : "Up to date"
            : updateSnapshot?.status === "error"
              ? "Update check failed"
              : "Not checked yet"
}

const SectionMount = makeSectionMount("SettingsGeneralSection", Message.MountedSection, () => Message.MountedSection())

export const view = Submodel.defineView<Model, Message, SectionViewInputs>((model, { app, appVersion, switched }, h) => {
  const appSettings = app.stores.appSettings.settings
  const updateSnapshot = app.updateSnapshot
  const terminal = app.stores.terminalPreferences
  const sounds = app.stores.chatSoundPreferences
  const installedEditors = appSettings?.installedEditors ?? null
  const submitWhileRunning = appSettings?.submitWhileRunning ?? "queue"
  const paneVisibility = appSettings?.paneVisibility ?? { widgets: "chat", terminal: "chat" }
  const transcriptWindow = appSettings?.transcript?.windowAssistantMessages ?? DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES
  const newProjectsDirectory = appSettings?.newProjectsDirectory ?? DEFAULT_NEW_PROJECTS_DIRECTORY
  const analyticsEnabled = appSettings?.analyticsEnabled !== false
  const isCheckingForUpdate = updateSnapshot?.status === "checking"
  const isInstallingUpdate = updateSnapshot?.status === "updating" || updateSnapshot?.status === "restart_pending"
  const currentVersionLabel = updateSnapshot?.currentVersion ?? appVersion

  const text = (id: FieldId) => draftText(model.drafts[id], fieldValue(id, app))
  const editorCommandDraft = text("editorCommand")
  const customEditorPreview = editorCommandDraft
    .replaceAll("{path}", "/Users/jake/Projects/kanna/src/client/app/App.tsx")
    .replaceAll("{line}", "12")
    .replaceAll("{column}", "1")

  const select = (id: SelectId, value: string, items: ReadonlyArray<Select.SelectItemConfig>, renderItem: (value: string) => ReadonlyArray<string | Html>, disabled = false) =>
    settingsSelect({
      slotId: `select-${id}`,
      model: model.selects[id],
      value,
      items,
      renderItem,
      disabled,
      toParentMessage: (message) => Message.GotSelectMessage({ id, message }),
    }, h)

  const field = (id: FieldId, options: { type: "text" | "number"; class: string; min?: number; max?: number; step?: number; mono?: boolean }) => {
    const base = fieldValue(id, app)
    return input({
      type: options.type,
      value: text(id),
      class: options.class,
      onInput: (value) => Message.ChangedField({ id, text: value, base }),
      attributes: [
        ...(options.min !== undefined ? [h.Min(String(options.min))] : []),
        ...(options.max !== undefined ? [h.Max(String(options.max))] : []),
        ...(options.step !== undefined ? [h.Step(String(options.step))] : []),
        ...(options.type === "text" ? [h.Spellcheck(false), h.Autocomplete("off")] : []),
        h.OnBlur(Message.BlurredField({ id })),
        h.OnKeyDown((key) => Message.PressedFieldKey({ id, key })),
      ],
    }, h)
  }

  // Listed but not selectable when it isn't on this machine — picking it
  // would only make every "Open in" fail later.
  const editorInstalled = (value: string) => !installedEditors || value === "custom" || installedEditors.includes(value as EditorPreset)
  const renderEditor = (value: string): ReadonlyArray<Html> => {
    const option = EDITOR_OPTIONS.find((entry) => entry.value === value)
    const installed = editorInstalled(value)
    return [h.span([h.Class("flex items-center gap-2")], [
      editorIcon(value as EditorPreset, { class: `h-4 w-4 shrink-0${installed ? "" : " opacity-40 grayscale"}` }, h),
      h.span(installed ? [] : [h.Class("text-muted-foreground")], [option?.label ?? value]),
      installed
        ? null
        : h.span([h.Class("ml-auto shrink-0 rounded-full border border-border/70 px-1.5 py-px text-[10px] leading-4 font-medium text-muted-foreground")], ["Not installed"]),
    ])]
  }

  const lastChecked = updateSnapshot?.lastCheckedAt
    ? h.span([], [` Last checked ${new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(updateSnapshot.lastCheckedAt)}.`])
    : null

  return sectionContainer({
    sectionId: "general",
    switched,
    mount: SectionMount(),
    unmounted: Message.UnmountedSection(),
    label: "General",
    subtitle: sectionSubtitle("general"),
  }, [
    model.error ? settingsErrorBanner(model.error, h) : null,
    settingsGroups([
      settingsGroup({}, [
        settingsRow({
          def: SETTINGS_ROWS.applicationUpdate,
          description: [
            h.span([], [`Kanna ${currentVersionLabel}. ${updateStatusLabel(app)}.`]),
            lastChecked,
            updateSnapshot?.error ? h.span([], [` ${updateSnapshot.error}`]) : null,
            " ",
            h.button([h.Type("button"), h.OnClick(Message.ClickedChangelog()), h.Class(SETTINGS_INLINE_ACTION_CLASS)], ["Changelog"]),
          ],
        }, [
          updateSnapshot?.updateAvailable
            ? settingsActionButton({
              prominent: true,
              onClick: Message.ClickedInstallUpdate(),
              disabled: isInstallingUpdate,
              icon: DownloadCloud({}, h),
            }, [isInstallingUpdate ? "Updating…" : `Update to ${updateSnapshot.latestVersion ?? "latest"}`], h)
            : settingsActionButton({
              onClick: Message.ClickedCheckForUpdates(),
              disabled: isCheckingForUpdate || isInstallingUpdate,
            }, [isCheckingForUpdate ? "Checking…" : "Check for updates"], h),
        ], h),
      ], h),

      settingsGroup({ title: ["Appearance"] }, [
        settingsRow({ def: SETTINGS_ROWS.theme }, [
          select("theme", themePreference(appSettings), themeOptions, renderTheme),
        ], h),
        settingsRow({ def: SETTINGS_ROWS.projectIconsInChats }, [
          switchControl({
            checked: appSettings?.projectIconsInChats !== false,
            onCheckedChange: (checked) => Message.ToggledProjectIconsInChats({ checked }),
            ariaLabel: SETTINGS_ROWS.projectIconsInChats.title,
          }, h),
        ], h),
        settingsRow({ def: SETTINGS_ROWS.chatTabs }, [
          switchControl({
            checked: appSettings?.chatTabsEnabled === true,
            onCheckedChange: (checked) => Message.ToggledChatTabs({ checked }),
            ariaLabel: SETTINGS_ROWS.chatTabs.title,
          }, h),
        ], h),
        settingsRow({ def: SETTINGS_ROWS.widgetsPeek }, [
          switchControl({
            checked: appSettings?.widgetsPeekEnabled === true,
            onCheckedChange: (checked) => Message.ToggledWidgetsPeek({ checked }),
            ariaLabel: SETTINGS_ROWS.widgetsPeek.title,
          }, h),
        ], h),
      ], h),

      settingsGroup({ title: ["Notifications"] }, [
        settingsRow({ def: SETTINGS_ROWS.chatSounds }, [
          select("chatSounds", sounds.chatSoundPreference, chatSoundPreferenceOptions, renderChatSoundPreference),
        ], h),
        // Which sound only matters while sounds can play at all.
        settingsRow({ def: SETTINGS_ROWS.chatSound }, [
          select("chatSound", sounds.chatSoundId, ChatSoundPreferences.CHAT_SOUND_OPTIONS, renderChatSound, sounds.chatSoundPreference === "never"),
        ], h),
        settingsRow({ def: SETTINGS_ROWS.chatBrowserNotifications }, [
          select("chatBrowserNotifications", sounds.chatBrowserNotificationPreference, chatBrowserNotificationPreferenceOptions, renderBrowserNotification),
        ], h),
      ], h),

      settingsGroup({ title: ["Chats"] }, [
        settingsRow({ def: SETTINGS_ROWS.submitWhileRunning }, [
          select("submitWhileRunning", submitWhileRunning, submitWhileRunningOptions, renderSubmitWhileRunning),
        ], h),
        settingsRow({ def: SETTINGS_ROWS.transcriptWindow, wideControl: true }, [
          settingsField(
            [`${MIN_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES}–${MAX_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES} messages${transcriptWindow === DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES ? " (default)" : ""}`],
            [field("transcriptWindow", {
              type: "number",
              min: MIN_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES,
              max: MAX_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES,
              step: 5,
              class: SETTINGS_NUMBER_INPUT_CLASS,
            })],
            h,
          ),
        ], h),
      ], h),

      settingsGroup({ title: ["Layout"] }, [
        settingsRow({ def: SETTINGS_ROWS.widgetsVisibility, key: "widgets" }, [
          select("widgetsVisibility", paneVisibility.widgets, paneVisibilityScopeOptions, renderPaneVisibility),
        ], h),
        settingsRow({ def: SETTINGS_ROWS.terminalVisibility, key: "terminal" }, [
          select("terminalVisibility", paneVisibility.terminal, paneVisibilityScopeOptions, renderPaneVisibility),
        ], h),
      ], h),

      settingsGroup({ title: ["Editor & Projects"] }, [
        settingsRow({ def: SETTINGS_ROWS.defaultEditor }, [
          select(
            "defaultEditor",
            terminal.editorPreset,
            EDITOR_OPTIONS.map((option) => ({ value: option.value, disabled: !editorInstalled(option.value), textValue: option.label })),
            renderEditor,
          ),
        ], h),
        terminal.editorPreset === "custom"
          ? settingsRow({
            nested: true,
            wideControl: true,
            title: "Command Template",
            description: ["Include ", "{path}", " and optionally ", "{line}", " and ", "{column}", " in your command."],
          }, [
            settingsField(["Preview: ", h.span([h.Class("font-mono")], [customEditorPreview])], [
              field("editorCommand", { type: "text", class: cn(SETTINGS_CONTROL_CLASS, "font-mono @2xl:w-80") }),
            ], h),
          ], h)
          : null,
        settingsRow({ def: SETTINGS_ROWS.newProjectsDirectory, wideControl: true }, [
          settingsField([`Created on first use${newProjectsDirectory === DEFAULT_NEW_PROJECTS_DIRECTORY ? " (default)" : ""}`], [
            field("newProjectsDirectory", { type: "text", class: cn(SETTINGS_CONTROL_CLASS, "font-mono") }),
          ], h),
        ], h),
      ], h),

      settingsGroup({ title: ["Terminal"] }, [
        settingsRow({ def: SETTINGS_ROWS.terminalScrollback, wideControl: true }, [
          settingsField([`${TerminalPreferences.MIN_TERMINAL_SCROLLBACK}–${TerminalPreferences.MAX_TERMINAL_SCROLLBACK} lines${terminal.scrollbackLines === TerminalPreferences.DEFAULT_TERMINAL_SCROLLBACK ? " (default)" : ""}`], [
            field("scrollback", {
              type: "number",
              min: TerminalPreferences.MIN_TERMINAL_SCROLLBACK,
              max: TerminalPreferences.MAX_TERMINAL_SCROLLBACK,
              step: 100,
              class: SETTINGS_NUMBER_INPUT_CLASS,
            }),
          ], h),
        ], h),
        settingsRow({ def: SETTINGS_ROWS.terminalMinColumnWidth, wideControl: true }, [
          settingsField([`${TerminalPreferences.MIN_TERMINAL_MIN_COLUMN_WIDTH}–${TerminalPreferences.MAX_TERMINAL_MIN_COLUMN_WIDTH} px${terminal.minColumnWidth === TerminalPreferences.DEFAULT_TERMINAL_MIN_COLUMN_WIDTH ? " (default)" : ""}`], [
            field("minColumnWidth", {
              type: "number",
              min: TerminalPreferences.MIN_TERMINAL_MIN_COLUMN_WIDTH,
              max: TerminalPreferences.MAX_TERMINAL_MIN_COLUMN_WIDTH,
              step: 10,
              class: SETTINGS_NUMBER_INPUT_CLASS,
            }),
          ], h),
        ], h),
      ], h),

      settingsGroup({ title: ["Privacy"] }, [
        settingsRow({
          def: SETTINGS_ROWS.anonymousAnalytics,
          description: [
            h.span([], [
              "Help improve Kanna with anonymous product analytics. Kanna sends tracked event names plus a small set of event properties like current version, environment, update version info, and launch flags. No message content, prompts, file paths, or provider credentials are sent.",
            ]),
            h.span([h.Class("mt-1 block")], [
              `Stored in ${appSettings?.filePathDisplay ?? "~/.kanna/data/settings.json"}.`,
              " ",
              h.button([h.Type("button"), h.OnClick(Message.ClickedViewTrackedEvents()), h.Class(SETTINGS_INLINE_ACTION_CLASS)], ["View tracked events"]),
            ]),
            appSettings?.warning ? h.span([h.Class("mt-1 block")], [appSettings.warning]) : null,
          ],
        }, [
          switchControl({
            checked: analyticsEnabled,
            onCheckedChange: (checked) => Message.ToggledAnalytics({ checked }),
            ariaLabel: SETTINGS_ROWS.anonymousAnalytics.title,
          }, h),
        ], h),
      ], h),
    ], h),
    h.submodel({
      slotId: "tracked-events",
      model: model.analyticsDialog,
      view: Dialog.view,
      viewInputs: {
        size: "lg",
        content: ({ titleId }: Dialog.ContentParts) => [
          Dialog.dialogBody({ class: "space-y-4" }, [
            Dialog.dialogTitle({ id: titleId }, ["Tracked Events"], h),
            h.div([h.Class("text-sm text-muted-foreground")], [
              "Kanna sends these event names plus the limited property keys below, depending on the event type.",
            ]),
            h.div([h.Class("max-h-[60vh] overflow-auto rounded-lg border border-border bg-muted/40 p-3")], [
              h.div([h.Class("text-xs font-medium uppercase tracking-wide text-muted-foreground")], ["Event Names"]),
              h.ul([h.Class("mt-3 space-y-2 text-sm")], ANALYTICS_STATIC_EVENT_NAMES.map((eventName) =>
                h.keyed("li")(eventName, [h.Class("font-mono text-foreground")], [eventName]))),
              h.div([h.Class("mt-6 text-xs font-medium uppercase tracking-wide text-muted-foreground")], ["Property Keys"]),
              h.ul([h.Class("mt-3 space-y-2 text-sm")], ANALYTICS_STATIC_PROPERTY_NAMES.map((propertyName) =>
                h.keyed("li")(propertyName, [h.Class("font-mono text-foreground")], [propertyName]))),
            ]),
          ], h),
          Dialog.dialogFooter({}, [
            button({ variant: "secondary", size: "sm", attributes: [h.OnClick(Message.ClickedCloseTrackedEvents())] }, ["Close"], h),
          ], h),
        ],
      },
      toParentMessage: (message) => Message.GotAnalyticsDialogMessage({ message }),
    }),
  ], h)
})
