import { Duration, Effect, Schema } from "effect"
import { Command, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { cn } from "../../client/lib/utils"
import type { AccountInput, ProviderAccount } from "../../shared/accounts"
import {
  chatModeFromFlags,
  chatModeToFlags,
  DEFAULT_OPENAI_SDK_MODEL,
  DEFAULT_OPENROUTER_SDK_MODEL,
  PROVIDERS,
  withPiFaveModels,
  type AgentProvider,
  type ChatMode,
  type ClaudeContextWindow,
  type FaveModel,
  type LlmProviderKind,
  type LlmProviderSnapshot,
  type LlmProviderValidationResult,
  type ProviderCatalogEntry,
} from "../../shared/types"
import { AppAction } from "../app/action"
import * as Stores from "../app/stores"
import * as ChatSession from "../core/chatSession"
import { opaque } from "../core/schema"
import { errorMessage, sendCommand } from "../core/socket"
import * as ChatPreferences from "../core/stores/chatPreferences"
import * as ProviderAuth from "../core/stores/providerAuth"
import { button } from "../ui/button"
import * as Dialog from "../ui/dialog"
import { History, Loader2, Plus, RefreshCw } from "../ui/icons"
import { input } from "../ui/input"
import * as Popover from "../ui/popover"
import { PROVIDER_ICONS } from "../ui/provider-icons"
import * as Select from "../ui/select"
import { makeSectionMount } from "./activeSection"
import * as AuthCard from "./auth-cards"
import { applyModelToComposerState } from "./composer"
import * as DefaultModelsDialog from "./defaultModelsDialog"
import { PREFERENCE_PICKERS, preferenceControls, type PreferencePicker } from "./preferenceControls"
import { SETTINGS_ROWS } from "./registry"
import { liftChild, requestActions, sectionLabel, sectionSubtitle, type AppModel, type SectionReturn, type SectionViewInputs } from "./section"
import {
  BlurActiveElement,
  sectionContainer,
  SETTINGS_CONTROL_CLASS,
  settingsActionButton,
  settingsErrorBanner,
  settingsGroup,
  settingsGroups,
  settingsNotice,
  settingsRow,
  settingsSelect,
  updateSettingsSelect,
} from "./shared"

// Settings › Providers (app/settings/ProvidersSection.tsx, with
// AccountsSection.tsx, the AuthCard rows and DefaultModelsDialog).

const QUICK_RESPONSE_PROVIDER_OPTIONS: Array<{ value: LlmProviderKind; label: string }> = [
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "custom", label: "Custom" },
]

const DEFAULT_ROW_PROVIDERS = ["claude", "codex", "cursor", "grok", "pi"] as const satisfies ReadonlyArray<AgentProvider>
const AgentProviderSchema = Schema.Literals(DEFAULT_ROW_PROVIDERS)
const PickerSchema = Schema.Literals(PREFERENCE_PICKERS)

const SELECT_IDS = ["defaultProvider", "llmProvider", "accountProvider", "accountApiProvider"] as const
const SelectId = Schema.Literals(SELECT_IDS)
type SelectId = typeof SelectId.Type

const LLM_FIELDS = ["apiKey", "model", "baseUrl"] as const
const LlmField = Schema.Literals(LLM_FIELDS)
type LlmField = typeof LlmField.Type

const LlmDraft = Schema.Struct({
  provider: opaque<LlmProviderKind>("LlmProviderKind"),
  apiKey: Schema.String,
  model: Schema.String,
  baseUrl: Schema.String,
})
type LlmDraft = typeof LlmDraft.Type

type LlmProviderValue = Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">

/** The draft React kept in step with the snapshot: reset whenever the snapshot's values change. */
function snapshotDraft(snapshot: LlmProviderSnapshot | null): LlmDraft {
  return snapshot
    ? { provider: snapshot.provider, apiKey: snapshot.apiKey, model: snapshot.model, baseUrl: snapshot.baseUrl }
    : { provider: "openai", apiKey: "", model: "", baseUrl: "" }
}

function draftSignature(draft: LlmDraft) {
  return JSON.stringify([draft.provider, draft.apiKey, draft.model, draft.baseUrl])
}

// MODEL

const ValidationStatus = Schema.Literals(["idle", "valid", "invalid"])

const PreferencePopovers = Schema.Struct(Object.fromEntries(PREFERENCE_PICKERS.map((name) => [name, Popover.Model])) as Record<PreferencePicker, typeof Popover.Model>)

export const Model = Schema.Struct({
  providersError: Schema.NullOr(Schema.String),
  selects: Schema.Struct(Object.fromEntries(SELECT_IDS.map((id) => [id, Select.Model])) as Record<SelectId, typeof Select.Model>),
  /** One set of pickers per default row. */
  popovers: Schema.Struct(Object.fromEntries(DEFAULT_ROW_PROVIDERS.map((provider) => [provider, PreferencePopovers])) as Record<(typeof DEFAULT_ROW_PROVIDERS)[number], typeof PreferencePopovers>),
  modelQueries: Schema.Record(Schema.String, Schema.String),
  /** The Model Registry fields as typed, against the snapshot values they were typed over. */
  llmDraft: Schema.NullOr(Schema.Struct({ draft: LlmDraft, base: Schema.String })),
  llmProviderError: Schema.NullOr(Schema.String),
  /** The last check of the credentials, for the draft values it checked. */
  llmValidation: Schema.Struct({ status: ValidationStatus, errorText: Schema.String, hasError: Schema.Boolean, values: Schema.String }),
  validationDialog: Dialog.Model,
  defaultModels: DefaultModelsDialog.Model,
  /** One per auth card row, by AuthCard.cardId. */
  authCards: Schema.Record(Schema.String, AuthCard.Model),

  // AccountsSection
  accountDraft: Schema.NullOr(opaque<AccountInput>("AccountInput")),
  connecting: Schema.NullOr(Schema.String),
  keyAccount: Schema.NullOr(opaque<ProviderAccount>("ProviderAccount")),
  replacementKey: Schema.String,
  accountsBusy: Schema.Boolean,
  accountsError: Schema.NullOr(Schema.String),
  addAccountDialog: Dialog.Model,
  replaceKeyDialog: Dialog.Model,
  connectDialog: Dialog.Model,
  connectCard: AuthCard.Model,
})
export type Model = typeof Model.Type

export function init(): Model {
  return {
    providersError: null,
    selects: Object.fromEntries(SELECT_IDS.map((id) => [id, Select.init({ id: `settings-providers-${id}` })])) as Model["selects"],
    popovers: Object.fromEntries(DEFAULT_ROW_PROVIDERS.map((provider) => [
      provider,
      Object.fromEntries(PREFERENCE_PICKERS.map((name) => [name, Popover.init({ id: `settings-${provider}-defaults-${name}` })])),
    ])) as Model["popovers"],
    modelQueries: {},
    llmDraft: null,
    llmProviderError: null,
    llmValidation: { status: "idle", errorText: "", hasError: false, values: "" },
    validationDialog: Dialog.init({ id: "settings-llm-validation" }),
    defaultModels: DefaultModelsDialog.init({ id: "settings-default-models" }),
    authCards: {},
    accountDraft: null,
    connecting: null,
    keyAccount: null,
    replacementKey: "",
    accountsBusy: false,
    accountsError: null,
    addAccountDialog: Dialog.init({ id: "settings-add-account" }),
    replaceKeyDialog: Dialog.init({ id: "settings-replace-key" }),
    connectDialog: Dialog.init({ id: "settings-connect-account" }),
    connectCard: AuthCard.init("settings-connect-account-card"),
  }
}

// MESSAGE

export const Message = defineMessageUnion({
  MountedSection: {},
  UnmountedSection: {},
  GotSelectMessage: { id: SelectId, message: Select.Message },
  GotPopoverMessage: { provider: AgentProviderSchema, picker: PickerSchema, message: Popover.Message },
  ChangedModelQuery: { provider: AgentProviderSchema, query: Schema.String },
  PickedDefaultModel: { provider: AgentProviderSchema, model: Schema.String },
  PickedReasoningEffort: { provider: AgentProviderSchema, effort: Schema.String },
  PickedContextWindow: { provider: AgentProviderSchema, contextWindow: Schema.String },
  PickedFastMode: { provider: AgentProviderSchema, fastMode: Schema.Boolean },
  PickedMode: { provider: AgentProviderSchema, mode: Schema.Literals(["full-access", "plan", "auto-plan"]) },
  ClickedAddModels: {},
  ChangedLlmField: { field: LlmField, value: Schema.String },
  BlurredLlmField: {},
  PressedLlmFieldKey: { key: Schema.String },
  ReceivedLlmValidation: { values: Schema.String, ok: Schema.Boolean, errorText: Schema.String, hasError: Schema.Boolean },
  FailedLlmCommit: { values: Schema.String, message: Schema.String, errorText: Schema.String },
  ClickedSeeValidationError: {},
  ClickedCloseValidationError: {},
  GotValidationDialogMessage: { message: Dialog.Message },
  ClickedEditModels: {},
  GotDefaultModelsMessage: { message: DefaultModelsDialog.Message },
  GotAuthCardMessage: { id: Schema.String, message: AuthCard.Message },
  CompletedBlurActiveElement: {},

  // AccountsSection
  ClickedRefreshAccounts: {},
  ClickedAddAccount: {},
  ClickedUseByDefault: { provider: AgentProviderSchema, accountId: Schema.String },
  ClickedAccountSignIn: { accountId: Schema.String },
  ClickedReplaceKey: { account: opaque<ProviderAccount>("ProviderAccount") },
  ClickedRemoveAccount: { accountId: Schema.String },
  ChangedAccountLabel: { value: Schema.String },
  ChangedAccountApiKey: { value: Schema.String },
  ChangedAccountBaseUrl: { value: Schema.String },
  SubmittedAddAccount: {},
  ClickedCancelAddAccount: {},
  ChangedReplacementKey: { value: Schema.String },
  SubmittedReplaceKey: {},
  ClickedCancelReplaceKey: {},
  ClickedConnectSignIn: { accountId: Schema.String },
  GotAddAccountDialogMessage: { message: Dialog.Message },
  GotReplaceKeyDialogMessage: { message: Dialog.Message },
  GotConnectDialogMessage: { message: Dialog.Message },
  GotConnectCardMessage: { message: AuthCard.Message },
  SucceededAccountsCommand: { then: Schema.Literals(["none", "closeAddAccount", "closeReplaceKey"]) },
  CreatedAccount: { accountId: Schema.String, login: Schema.Boolean },
  FailedAccountsCommand: { error: Schema.String },
})
export type Message = typeof Message.Type

type Return = SectionReturn<Model, Message>

// COMMANDS

/**
 * The credentials check after a Model Registry write. The write is the
 * root's (it holds the snapshot); this runs after it, as React awaited the
 * write before validating, by letting the root's command go out first.
 */
const ValidateLlmProvider = Command.define("ValidateLlmProvider", {
  args: { value: opaque<LlmProviderValue>("LlmProviderValue"), values: Schema.String },
  messages: [Message.ReceivedLlmValidation, Message.FailedLlmCommit],
  execute: ({ value, values }) => Effect.sleep(Duration.zero).pipe(
    Effect.andThen(sendCommand<LlmProviderValidationResult>({
      type: "settings.validateLlmProvider",
      provider: value.provider,
      apiKey: value.apiKey,
      model: value.model,
      baseUrl: value.baseUrl,
    })),
    Effect.map((validation) => Message.ReceivedLlmValidation({
      values,
      ok: validation.ok,
      hasError: Boolean(validation.error),
      errorText: validation.error ? JSON.stringify(validation.error, null, 2) : "",
    })),
    Effect.catch((error) => Effect.succeed(Message.FailedLlmCommit({
      values,
      message: error instanceof Error ? error.message : "Unable to save Model Registry settings.",
      errorText: JSON.stringify(error instanceof Error ? { name: error.name, message: error.message } : error, null, 2),
    }))),
  ),
})

type AccountsThen = "none" | "closeAddAccount" | "closeReplaceKey"

const AccountsCommand = Command.define("SendAccountsCommand", {
  args: { command: opaque<Parameters<typeof sendCommand>[0]>("ClientCommand"), then: Schema.Literals(["none", "closeAddAccount", "closeReplaceKey"]) },
  messages: [Message.SucceededAccountsCommand, Message.FailedAccountsCommand],
  execute: ({ command, then }) => sendCommand(command).pipe(
    Effect.as(Message.SucceededAccountsCommand({ then })),
    Effect.catch((error) => Effect.succeed(Message.FailedAccountsCommand({ error: errorMessage(error) }))),
  ),
})

const CreateAccount = Command.define("CreateAccount", {
  args: { account: opaque<AccountInput>("AccountInput"), login: Schema.Boolean },
  messages: [Message.CreatedAccount, Message.FailedAccountsCommand],
  execute: ({ account, login }) => sendCommand<{ accountId: string }>({ type: "accounts.create", account }).pipe(
    Effect.map((result) => Message.CreatedAccount({ accountId: result.accountId, login })),
    Effect.catch((error) => Effect.succeed(Message.FailedAccountsCommand({ error: errorMessage(error) }))),
  ),
})

const blurActiveElement = Command.mapMessage(BlurActiveElement(), () => Message.CompletedBlurActiveElement())

// UPDATE

const write = (patch: Parameters<typeof AppAction.WriteAppSettings>[0]["patch"]) => AppAction.WriteAppSettings({ patch })
const chatPreferences = (message: ChatPreferences.Message) =>
  AppAction.Store({ message: Stores.Message.GotChatPreferencesMessage({ message }) })

/** useKannaState's availableProviders, off a chat: the app's catalog with pi's Default Models. */
export function availableProviders(app: AppModel): ProviderCatalogEntry[] {
  const fallback = withPiFaveModels(app.stores.appSettings.settings?.availableProviders ?? PROVIDERS, app.llmProvider?.faveModels ?? [])
  return app.chat ? ChatSession.availableProviders(app.chat, fallback) : fallback
}

function currentDraft(model: Model, app: AppModel): LlmDraft {
  const fromSnapshot = snapshotDraft(app.llmProvider)
  const base = draftSignature(fromSnapshot)
  return model.llmDraft && model.llmDraft.base === base ? model.llmDraft.draft : fromSnapshot
}

function withDraft(model: Model, app: AppModel, draft: LlmDraft): Model {
  return { ...model, llmDraft: { draft, base: draftSignature(snapshotDraft(app.llmProvider)) } }
}

function commitLlmProvider(model: Model, app: AppModel, draft: LlmDraft): Return {
  const value = { provider: draft.provider, apiKey: draft.apiKey, model: draft.model, baseUrl: draft.baseUrl }
  return requestActions(
    { ...withDraft(model, app, draft), llmProviderError: null },
    [AppAction.WriteLlmProvider({ value })],
    [ValidateLlmProvider({ value, values: draftSignature(draft) })],
  )
}

/** The value a select shows (as the view passes it). */
function selectValue(model: Model, id: SelectId, app: AppModel): string {
  switch (id) {
    case "defaultProvider":
      return app.stores.chatPreferences.defaultProvider
    case "llmProvider":
      return currentDraft(model, app).provider
    case "accountProvider":
      return model.accountDraft?.provider ?? ""
    case "accountApiProvider":
      return model.accountDraft?.apiProvider ?? "openai"
  }
}

function foldSelect(model: Model, id: SelectId, child: Select.Message, app: AppModel): Return {
  const lifted = liftChild(
    updateSettingsSelect(model.selects[id], child, selectValue(model, id, app)),
    (select) => ({ ...model, selects: { ...model.selects, [id]: select } }),
    (selectMessage) => Message.GotSelectMessage({ id, message: selectMessage }),
  )
  if (!lifted.outMessage) return { model: lifted.model, commands: lifted.commands }
  const selected = selectedValue(lifted.model, id, lifted.outMessage.value, app)
  return { ...selected, commands: [...lifted.commands, ...(selected.commands ?? [])] }
}

function selectedValue(model: Model, id: SelectId, value: string, app: AppModel): Return {
  switch (id) {
    case "defaultProvider": {
      const provider = value as "last_used" | AgentProvider
      return requestActions(model, [
        chatPreferences(ChatPreferences.Message.ChangedDefaultProvider({ provider })),
        write({ defaultProvider: provider }),
      ])
    }
    case "llmProvider": {
      const nextProvider = value as LlmProviderKind
      const draft = currentDraft(model, app)
      const nextDraft = {
        ...draft,
        provider: nextProvider,
        model: nextProvider === "openai"
          ? DEFAULT_OPENAI_SDK_MODEL
          : nextProvider === "openrouter"
            ? DEFAULT_OPENROUTER_SDK_MODEL
            : draft.model,
        baseUrl: nextProvider === "custom" ? draft.baseUrl : "",
      }
      return commitLlmProvider(model, app, nextDraft)
    }
    case "accountProvider":
      return model.accountDraft
        ? { model: { ...model, accountDraft: { provider: value as AccountInput["provider"], label: model.accountDraft.label, apiProvider: "openai" } } }
        : { model }
    case "accountApiProvider":
      return model.accountDraft
        ? { model: { ...model, accountDraft: { ...model.accountDraft, apiProvider: value as AccountInput["apiProvider"], baseUrl: "" } } }
        : { model }
  }
}

function foldPopover(model: Model, provider: (typeof DEFAULT_ROW_PROVIDERS)[number], picker: PreferencePicker, result: ReturnType<typeof Popover.update>): Return {
  const lifted = liftChild(
    result,
    (popover) => ({ ...model, popovers: { ...model.popovers, [provider]: { ...model.popovers[provider], [picker]: popover } } }),
    (message) => Message.GotPopoverMessage({ provider, picker, message }),
  )
  // The model list's filter lived in the list, which unmounted with the panel.
  const closedModelPicker = picker === "model" && lifted.outMessage?._tag === "Closed"
  return {
    model: closedModelPicker ? { ...lifted.model, modelQueries: { ...lifted.model.modelQueries, [provider]: "" } } : lifted.model,
    commands: lifted.commands,
  }
}

/** A pick closes its picker (InputPopover's `close()`), then asks for the change. */
function picked(model: Model, provider: (typeof DEFAULT_ROW_PROVIDERS)[number], picker: PreferencePicker, actions: ReadonlyArray<AppAction>): Return {
  const closed = foldPopover(model, provider, picker, Popover.close(model.popovers[provider][picker]))
  return requestActions(closed.model, actions, closed.commands)
}

function modelOptionsChange(provider: AgentProvider, modelOptions: ChatPreferences.ComposerState["modelOptions"] | Record<string, unknown>) {
  return [
    chatPreferences(ChatPreferences.Message.ChangedProviderDefaultModelOptions({ provider, modelOptions: modelOptions as never })),
    write({ providerDefaults: { [provider]: { modelOptions } } }),
  ]
}

function foldDialog(
  model: Model,
  key: "validationDialog" | "addAccountDialog" | "replaceKeyDialog" | "connectDialog",
  result: ReturnType<typeof Dialog.update> | ReturnType<typeof Dialog.open>,
  wrap: (message: Dialog.Message) => Message,
) {
  const lifted = liftChild(result, (dialog) => ({ ...model, [key]: dialog }), wrap)
  return { model: lifted.model as Model, commands: lifted.commands, closed: "outMessage" in result && result.outMessage !== undefined }
}

function performAccounts(model: Model, command: Parameters<typeof sendCommand>[0], then: AccountsThen = "none"): Return {
  return { model: { ...model, accountsBusy: true, accountsError: null }, commands: [AccountsCommand({ command, then })] }
}

function closeAddAccount(model: Model): Return {
  const closed = foldDialog({ ...model, accountDraft: null }, "addAccountDialog", Dialog.close(model.addAccountDialog), (message) => Message.GotAddAccountDialogMessage({ message }))
  return { model: closed.model, commands: closed.commands }
}

function closeReplaceKey(model: Model): Return {
  const closed = foldDialog({ ...model, keyAccount: null, replacementKey: "" }, "replaceKeyDialog", Dialog.close(model.replaceKeyDialog), (message) => Message.GotReplaceKeyDialogMessage({ message }))
  return { model: closed.model, commands: closed.commands }
}

/** The account a sign-in is connecting, while the snapshot still has it and its service. */
function connectingAccount(model: Model, app: AppModel) {
  const snapshot = app.stores.providerAuth.snapshot
  const account = snapshot?.accounts?.find((entry) => entry.id === model.connecting)
  const service = account ? snapshot?.services.find((entry) => entry.service === account.provider) ?? null : null
  return { account: account ?? null, service }
}

function startConnecting(model: Model, accountId: string): Return {
  const opened = foldDialog({ ...model, connecting: accountId }, "connectDialog", Dialog.open(model.connectDialog), (message) => Message.GotConnectDialogMessage({ message }))
  return { model: opened.model, commands: opened.commands }
}

function accountLabel(entry: ProviderAccount) {
  return `${PROVIDERS.find((provider) => provider.id === entry.provider)?.label ?? entry.provider} · ${entry.label}`
}

export function update(model: Model, message: Message, app: AppModel): Return {
  const providerDefaults = app.stores.chatPreferences.providerDefaults
  return Message.match<Return>(message, {
    // The section only mounts while its tab is selected and the socket is
    // connected, so a mount matches the old page-gated read.
    MountedSection: () => requestActions(model, [AppAction.SendCommand({ command: { type: "settings.readLlmProvider" } })]),
    UnmountedSection: () => ({ model: init() }),
    GotSelectMessage: ({ id, message: child }) => foldSelect(model, id, child, app),
    GotPopoverMessage: ({ provider, picker, message: child }) => foldPopover(model, provider, picker, Popover.update(model.popovers[provider][picker], child)),
    ChangedModelQuery: ({ provider, query }) => ({ model: { ...model, modelQueries: { ...model.modelQueries, [provider]: query } } }),
    PickedDefaultModel: ({ provider, model: modelId }) => {
      // The step the chat composer takes when a model is picked: options that
      // depend on the model are checked against the live catalog entry, so a
      // Codex effort the new model does not offer moves to one it does. The
      // store's own normalizer knows only the static list, which has no row
      // for a model the account gained at runtime.
      const next = applyModelToComposerState(
        { provider, ...providerDefaults[provider] } as ChatPreferences.ComposerState,
        modelId,
        availableProviders(app).find((entry) => entry.id === provider),
      )
      return picked(model, provider, "model", [
        chatPreferences(ChatPreferences.Message.ChangedProviderDefaultModel({ provider, model: next.model })),
        chatPreferences(ChatPreferences.Message.ChangedProviderDefaultModelOptions({ provider, modelOptions: next.modelOptions })),
        write({ providerDefaults: { [provider]: { model: next.model, modelOptions: next.modelOptions } } }),
      ])
    },
    PickedReasoningEffort: ({ provider, effort }) => picked(model, provider, "reasoning", provider === "cursor" ? [] : modelOptionsChange(provider, { reasoningEffort: effort })),
    PickedContextWindow: ({ provider, contextWindow }) => picked(model, provider, "contextWindow", provider === "claude" ? modelOptionsChange(provider, { contextWindow: contextWindow as ClaudeContextWindow }) : []),
    PickedFastMode: ({ provider, fastMode }) => picked(model, provider, "fastMode", provider === "claude" || provider === "codex" || provider === "cursor" ? modelOptionsChange(provider, { fastMode }) : []),
    PickedMode: ({ provider, mode }) => {
      const flags = chatModeToFlags(mode as ChatMode, providerDefaults[provider].autoPlan)
      return picked(model, provider, "mode", [
        chatPreferences(ChatPreferences.Message.ChangedProviderDefaultMode({ provider, mode })),
        write({ providerDefaults: { [provider]: flags } }),
      ])
    },
    ClickedAddModels: () => {
      const closed = foldPopover(model, "pi", "model", Popover.close(model.popovers.pi.model))
      const opened = DefaultModelsDialog.open(closed.model.defaultModels, app.llmProvider?.faveModels ?? [])
      return {
        model: { ...closed.model, defaultModels: opened.model },
        commands: [...(closed.commands ?? []), ...Command.mapMessages(opened.commands ?? [], (child) => Message.GotDefaultModelsMessage({ message: child }))],
      }
    },
    ChangedLlmField: ({ field, value }) => ({ model: withDraft(model, app, { ...currentDraft(model, app), [field]: value }) }),
    BlurredLlmField: () => commitLlmProvider(model, app, currentDraft(model, app)),
    PressedLlmFieldKey: ({ key }) => {
      if (key !== "Enter") return { model }
      const committed = commitLlmProvider(model, app, currentDraft(model, app))
      return { ...committed, commands: [...(committed.commands ?? []), blurActiveElement] }
    },
    ReceivedLlmValidation: ({ values, ok, errorText, hasError }) => ({
      model: { ...model, llmValidation: { status: ok ? "valid" : "invalid", errorText, hasError, values } },
    }),
    FailedLlmCommit: ({ values, message: failure, errorText }) => ({
      model: { ...model, llmProviderError: failure, llmValidation: { status: "invalid", errorText, hasError: true, values } },
    }),
    ClickedSeeValidationError: () => {
      const opened = foldDialog(model, "validationDialog", Dialog.open(model.validationDialog), (child) => Message.GotValidationDialogMessage({ message: child }))
      return { model: opened.model, commands: opened.commands }
    },
    ClickedCloseValidationError: () => {
      const closed = foldDialog(model, "validationDialog", Dialog.close(model.validationDialog), (child) => Message.GotValidationDialogMessage({ message: child }))
      return { model: closed.model, commands: closed.commands }
    },
    GotValidationDialogMessage: ({ message: child }) => {
      const result = foldDialog(model, "validationDialog", Dialog.update(model.validationDialog, child), (next) => Message.GotValidationDialogMessage({ message: next }))
      return { model: result.model, commands: result.commands }
    },
    ClickedEditModels: () => {
      const opened = DefaultModelsDialog.open(model.defaultModels, app.llmProvider?.faveModels ?? [])
      return {
        model: { ...model, defaultModels: opened.model },
        commands: Command.mapMessages(opened.commands ?? [], (child) => Message.GotDefaultModelsMessage({ message: child })),
      }
    },
    GotDefaultModelsMessage: ({ message: child }) => {
      const lifted = liftChild(
        DefaultModelsDialog.update(model.defaultModels, child),
        (defaultModels) => ({ ...model, defaultModels }),
        (next) => Message.GotDefaultModelsMessage({ message: next }),
      )
      if (!lifted.outMessage) return { model: lifted.model, commands: lifted.commands }
      return requestActions(lifted.model, [AppAction.WriteFaveModels({ faveModels: lifted.outMessage.faveModels as FaveModel[] })], lifted.commands)
    },
    GotAuthCardMessage: ({ id, message: child }) => {
      const lifted = liftChild(
        AuthCard.update(model.authCards[id] ?? AuthCard.init(id), child),
        (card) => ({ ...model, authCards: { ...model.authCards, [id]: card } }),
        (next) => Message.GotAuthCardMessage({ id, message: next }),
      )
      return { model: lifted.model, commands: lifted.commands }
    },
    CompletedBlurActiveElement: () => ({ model }),

    // AccountsSection
    ClickedRefreshAccounts: () => performAccounts(model, { type: "auth.refresh", force: true }),
    ClickedAddAccount: () => {
      const opened = foldDialog(
        { ...model, accountsError: null, accountDraft: { provider: "claude", label: "", apiProvider: "openai" } },
        "addAccountDialog",
        Dialog.open(model.addAccountDialog),
        (child) => Message.GotAddAccountDialogMessage({ message: child }),
      )
      return { model: opened.model, commands: opened.commands }
    },
    ClickedUseByDefault: ({ provider, accountId }) => performAccounts(model, { type: "accounts.setDefault", provider, accountId }),
    ClickedAccountSignIn: ({ accountId }) => {
      const connecting = startConnecting(model, accountId)
      const performed = performAccounts(connecting.model, { type: "accounts.login", accountId })
      return { model: performed.model, commands: [...(connecting.commands ?? []), ...(performed.commands ?? [])] }
    },
    ClickedReplaceKey: ({ account }) => {
      const opened = foldDialog(
        { ...model, replacementKey: "", keyAccount: account, accountsError: null },
        "replaceKeyDialog",
        Dialog.open(model.replaceKeyDialog),
        (child) => Message.GotReplaceKeyDialogMessage({ message: child }),
      )
      return { model: opened.model, commands: opened.commands }
    },
    ClickedRemoveAccount: ({ accountId }) => performAccounts(model, { type: "accounts.remove", accountId }),
    ChangedAccountLabel: ({ value }) => ({ model: model.accountDraft ? { ...model, accountDraft: { ...model.accountDraft, label: value } } : model }),
    ChangedAccountApiKey: ({ value }) => ({ model: model.accountDraft ? { ...model, accountDraft: { ...model.accountDraft, apiKey: value } } : model }),
    ChangedAccountBaseUrl: ({ value }) => ({ model: model.accountDraft ? { ...model, accountDraft: { ...model.accountDraft, baseUrl: value } } : model }),
    SubmittedAddAccount: () => {
      const draft = model.accountDraft
      if (!draft) return { model }
      const isKey = draft.provider === "cursor" || draft.provider === "pi"
      return { model: { ...model, accountsBusy: true, accountsError: null }, commands: [CreateAccount({ account: draft, login: !isKey })] }
    },
    ClickedCancelAddAccount: () => closeAddAccount(model),
    ChangedReplacementKey: ({ value }) => ({ model: { ...model, replacementKey: value } }),
    SubmittedReplaceKey: () => model.keyAccount
      ? performAccounts(model, { type: "accounts.updateKey", accountId: model.keyAccount.id, apiKey: model.replacementKey }, "closeReplaceKey")
      : { model },
    ClickedCancelReplaceKey: () => closeReplaceKey(model),
    ClickedConnectSignIn: ({ accountId }) => performAccounts(model, { type: "accounts.login", accountId }),
    GotAddAccountDialogMessage: ({ message: child }) => {
      const result = foldDialog(model, "addAccountDialog", Dialog.update(model.addAccountDialog, child), (next) => Message.GotAddAccountDialogMessage({ message: next }))
      // React's onOpenChange: a dismissal while busy keeps it open.
      if (result.closed && model.accountsBusy) {
        const reopened = foldDialog(result.model, "addAccountDialog", Dialog.open(result.model.addAccountDialog), (next) => Message.GotAddAccountDialogMessage({ message: next }))
        return { model: reopened.model, commands: [...result.commands, ...reopened.commands] }
      }
      return { model: result.closed ? { ...result.model, accountDraft: null } : result.model, commands: result.commands }
    },
    GotReplaceKeyDialogMessage: ({ message: child }) => {
      const result = foldDialog(model, "replaceKeyDialog", Dialog.update(model.replaceKeyDialog, child), (next) => Message.GotReplaceKeyDialogMessage({ message: next }))
      if (result.closed && model.accountsBusy) {
        const reopened = foldDialog(result.model, "replaceKeyDialog", Dialog.open(result.model.replaceKeyDialog), (next) => Message.GotReplaceKeyDialogMessage({ message: next }))
        return { model: reopened.model, commands: [...result.commands, ...reopened.commands] }
      }
      return { model: result.closed ? { ...result.model, keyAccount: null, replacementKey: "" } : result.model, commands: result.commands }
    },
    GotConnectDialogMessage: ({ message: child }) => {
      const result = foldDialog(model, "connectDialog", Dialog.update(model.connectDialog, child), (next) => Message.GotConnectDialogMessage({ message: next }))
      return { model: result.closed ? { ...result.model, connecting: null } : result.model, commands: result.commands }
    },
    GotConnectCardMessage: ({ message: child }) => {
      const lifted = liftChild(AuthCard.update(model.connectCard, child), (connectCard) => ({ ...model, connectCard }), (next) => Message.GotConnectCardMessage({ message: next }))
      return { model: lifted.model, commands: lifted.commands }
    },
    SucceededAccountsCommand: ({ then }) => {
      const done = { ...model, accountsBusy: false }
      return then === "closeAddAccount" ? closeAddAccount(done) : then === "closeReplaceKey" ? closeReplaceKey(done) : { model: done }
    },
    CreatedAccount: ({ accountId, login }) => {
      const closed = closeAddAccount(model)
      if (!login) return { ...closed, model: { ...closed.model, accountsBusy: false } }
      const connecting = startConnecting(closed.model, accountId)
      return {
        model: connecting.model,
        commands: [...(closed.commands ?? []), ...(connecting.commands ?? []), AccountsCommand({ command: { type: "accounts.login", accountId }, then: "none" })],
      }
    },
    FailedAccountsCommand: ({ error }) => ({ model: { ...model, accountsBusy: false, accountsError: error } }),
  })
}

// VIEW

function providerLogo(provider: AgentProvider, h: HtmlBuilder<Message>): Html {
  return PROVIDER_ICONS[provider]({ class: "h-4 w-4 shrink-0" }, h)
}

const SectionMount = makeSectionMount("SettingsProvidersSection", Message.MountedSection, () => Message.MountedSection())

const renderLlmProvider = (value: string) => [QUICK_RESPONSE_PROVIDER_OPTIONS.find((option) => option.value === value)?.label ?? value]
const renderAccountProvider = (value: string) => [PROVIDERS.find((provider) => provider.id === value)?.label ?? value]
const API_PROVIDER_LABELS: Record<string, string> = { openai: "OpenAI", openrouter: "OpenRouter", custom: "Custom" }
const renderApiProvider = (value: string) => [API_PROVIDER_LABELS[value] ?? value]

export const view = Submodel.defineView<Model, Message, SectionViewInputs>((model, { app, switched }, h) => {
  const llmProvider = app.llmProvider
  const snapshot = app.stores.providerAuth.snapshot
  const prefs = app.stores.chatPreferences
  const providers = availableProviders(app)
  const unauthenticated = ProviderAuth.unauthenticatedHarnesses(app.stores.providerAuth)
  const draft = currentDraft(model, app)
  const validation = model.llmValidation.values === draftSignature(draft) ? model.llmValidation : { status: "idle" as const, errorText: "", hasError: false }

  const select = (id: SelectId, value: string, items: ReadonlyArray<Select.SelectItemConfig>, renderItem: (value: string) => ReadonlyArray<string | Html>, extra: { ariaLabel?: string; inForm?: boolean; container?: (children: ReadonlyArray<Html>) => Html } = {}) =>
    settingsSelect({
      slotId: `select-${id}`,
      model: model.selects[id],
      value,
      items,
      renderItem,
      ...extra,
      toParentMessage: (message) => Message.GotSelectMessage({ id, message }),
    }, h)

  const renderDefaultProvider = (value: string): ReadonlyArray<Html> => value === "last_used"
    ? [h.span([h.Class("flex items-center gap-2")], [History({ class: "h-4 w-4 shrink-0" }, h), "Last Used"])]
    : [h.span([h.Class("flex items-center gap-2")], [
      providerLogo(value as AgentProvider, h),
      PROVIDERS.find((provider) => provider.id === value)?.label ?? value,
    ])]

  const defaultsRow = (provider: (typeof DEFAULT_ROW_PROVIDERS)[number], options: { includeMode: boolean }) => {
    const defaults = prefs.providerDefaults[provider]
    return settingsRow({
      def: SETTINGS_ROWS[`${provider}Defaults`],
      description: null,
      icon: providerLogo(provider, h),
      wideControl: true,
    }, [
      preferenceControls({
        id: `${provider}-defaults`,
        availableProviders: providers,
        selectedProvider: provider,
        showProviderPicker: false,
        providerLocked: true,
        model: defaults.model,
        modelOptions: defaults.modelOptions,
        mode: chatModeFromFlags(defaults.planMode, defaults.autoPlan),
        includeMode: options.includeMode,
        className: "justify-start flex-wrap",
        unauthenticated,
        popovers: model.popovers[provider],
        modelQuery: model.modelQueries[provider] ?? "",
        ...(provider === "pi" ? { editModels: Message.ClickedAddModels() } : {}),
        toPopoverMessage: (picker, message) => Message.GotPopoverMessage({ provider, picker, message }),
        onModelChange: (modelId) => Message.PickedDefaultModel({ provider, model: modelId }),
        onModelQueryChange: (query) => Message.ChangedModelQuery({ provider, query }),
        onReasoningEffortChange: (effort) => Message.PickedReasoningEffort({ provider, effort }),
        onContextWindowChange: (contextWindow) => Message.PickedContextWindow({ provider, contextWindow }),
        onFastModeChange: (fastMode) => Message.PickedFastMode({ provider, fastMode }),
        ...(options.includeMode ? { onModeChange: (mode: ChatMode) => Message.PickedMode({ provider, mode }) } : {}),
      }, h),
    ], h)
  }

  const llmField = (field: LlmField, options: { type?: string; placeholder: string; spellcheck: boolean }) =>
    input({
      ...(options.type ? { type: options.type } : {}),
      value: draft[field],
      onInput: (value) => Message.ChangedLlmField({ field, value }),
      placeholder: options.placeholder,
      class: cn(SETTINGS_CONTROL_CLASS, "font-mono"),
      attributes: [
        h.OnBlur(Message.BlurredLlmField()),
        h.OnKeyDown((key) => Message.PressedLlmFieldKey({ key })),
        ...(options.spellcheck ? [] : [h.Spellcheck(false)]),
        h.Autocomplete("off"),
      ],
    }, h)

  // No subtitle, only the result of checking the credentials once there is one.
  const llmValidationDescription = validation.status === "valid"
    ? [h.span([h.Class("font-medium text-emerald-600 dark:text-emerald-400")], ["Credentials valid & saved"])]
    : validation.status === "invalid"
      ? [h.span([h.Class("font-medium text-destructive")], [
        "Credentials invalid.",
        ...(validation.hasError
          ? [" ", h.button([
            h.Type("button"),
            h.OnClick(Message.ClickedSeeValidationError()),
            h.Class("underline underline-offset-2 transition-colors hover:opacity-70"),
          ], ["See error"])]
          : []),
      ])]
      : null

  const authCard = (service: NonNullable<typeof snapshot>["services"][number], viewInputs: Omit<AuthCard.ViewInputs, "service"> = {}) => {
    const id = AuthCard.cardId(service)
    return h.submodel({
      slotId: `auth-card-${id}`,
      model: model.authCards[id] ?? AuthCard.init(id),
      view: AuthCard.view,
      viewInputs: { service, ...viewInputs },
      toParentMessage: (message) => Message.GotAuthCardMessage({ id, message }),
    })
  }

  // AccountsSection
  const busy = model.accountsBusy
  const accountDraft = model.accountDraft
  const isKey = accountDraft?.provider === "cursor" || accountDraft?.provider === "pi"
  const connecting = connectingAccount(model, app)
  const accountsGroup = settingsGroup({
    title: ["Saved accounts"],
    trailing: h.div([h.Class("flex items-center gap-3")], [
      settingsActionButton({ disabled: busy, icon: RefreshCw({}, h), onClick: Message.ClickedRefreshAccounts() }, ["Refresh"], h),
      settingsActionButton({ disabled: busy, icon: Plus({}, h), onClick: Message.ClickedAddAccount() }, ["Add account"], h),
    ]),
  }, (snapshot?.accounts ?? []).map((entry) => {
    const isDefault = snapshot?.defaultAccountIds?.[entry.provider] === entry.id
    return settingsRow({
      key: entry.id,
      title: accountLabel(entry),
      description: [entry.identity ?? (entry.mode === "existing" ? "Uses the current CLI or API connection" : entry.statusDetail ?? entry.authStatus.replaceAll("_", " "))],
    }, [
      h.div([h.Class("flex flex-wrap items-center gap-3")], [
        settingsActionButton({ disabled: busy || isDefault, onClick: Message.ClickedUseByDefault({ provider: entry.provider, accountId: entry.id }) }, [isDefault ? "Default" : "Use by default"], h),
        entry.mode === "native"
          ? settingsActionButton({ disabled: busy, onClick: Message.ClickedAccountSignIn({ accountId: entry.id }) }, [entry.authStatus === "signed_in" ? "Reconnect" : "Sign in"], h)
          : null,
        entry.mode === "apiKey"
          ? settingsActionButton({ disabled: busy, onClick: Message.ClickedReplaceKey({ account: entry }) }, ["Replace key"], h)
          : null,
        entry.mode !== "existing"
          ? settingsActionButton({ disabled: busy, onClick: Message.ClickedRemoveAccount({ accountId: entry.id }) }, ["Remove"], h)
          : null,
      ]),
    ], h)
  }), h)

  const formButtons = (submitLabel: string, cancel: Message) => h.div([h.Class("flex justify-end gap-2 pt-4")], [
    button({ type: "button", variant: "outline", disabled: busy, attributes: [h.OnClick(cancel)] }, ["Cancel"], h),
    button({ type: "submit", disabled: busy }, [submitLabel], h),
  ])

  const addAccountDialog = h.submodel({
    slotId: "add-account",
    model: model.addAccountDialog,
    view: Dialog.view,
    viewInputs: {
      size: "md",
      content: ({ titleId, descriptionId }: Dialog.ContentParts) => [
        Dialog.dialogHeader({}, [
          Dialog.dialogTitle({ id: titleId }, ["Add account"], h),
          Dialog.dialogDescription({ id: descriptionId }, ["Choose an account for new chats. Existing chats keep their selected account."], h),
        ], h),
        Dialog.dialogBody({}, [
          accountDraft
            ? h.form([h.OnSubmit(Message.SubmittedAddAccount())], [
              settingsGroup({}, [
                settingsRow({
                  title: "Provider",
                  control: (wrap) => select(
                    "accountProvider",
                    accountDraft.provider,
                    PROVIDERS.filter((provider) => provider.id !== "grok").map((provider) => ({ value: provider.id })),
                    renderAccountProvider,
                    { ariaLabel: "Account provider", inForm: true, container: wrap },
                  ),
                }, [], h),
                settingsRow({ title: "Name", wideControl: true }, [
                  input({
                    value: accountDraft.label,
                    onInput: (value) => Message.ChangedAccountLabel({ value }),
                    placeholder: "Work",
                    attributes: [h.AriaLabel("Account name"), h.Required(true), h.Maxlength(80)],
                  }, h),
                ], h),
                accountDraft.provider === "pi"
                  ? settingsRow({
                    title: "API provider",
                    control: (wrap) => select(
                      "accountApiProvider",
                      accountDraft.apiProvider ?? "openai",
                      [{ value: "openai" }, { value: "openrouter" }, { value: "custom" }],
                      renderApiProvider,
                      { ariaLabel: "Account API provider", inForm: true, container: wrap },
                    ),
                  }, [], h)
                  : null,
                isKey
                  ? settingsRow({ title: "API key", wideControl: true }, [
                    input({
                      type: "password",
                      value: accountDraft.apiKey ?? "",
                      onInput: (value) => Message.ChangedAccountApiKey({ value }),
                      attributes: [h.AriaLabel("Account API key"), h.Autocomplete("new-password"), h.Required(true)],
                    }, h),
                  ], h)
                  : null,
                accountDraft.provider === "pi"
                  ? settingsRow({ title: "API URL", wideControl: true }, [
                    input({
                      type: "url",
                      value: accountDraft.baseUrl ?? "",
                      onInput: (value) => Message.ChangedAccountBaseUrl({ value }),
                      placeholder: accountDraft.apiProvider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1",
                      attributes: [h.AriaLabel("Account API URL"), ...(accountDraft.apiProvider === "custom" ? [h.Required(true)] : [])],
                    }, h),
                  ], h)
                  : null,
              ], h),
              model.accountsError ? settingsErrorBanner(model.accountsError, h) : null,
              formButtons("Add account", Message.ClickedCancelAddAccount()),
            ])
            : null,
        ], h),
      ],
    },
    toParentMessage: (message) => Message.GotAddAccountDialogMessage({ message }),
  })

  const replaceKeyDialog = h.submodel({
    slotId: "replace-key",
    model: model.replaceKeyDialog,
    view: Dialog.view,
    viewInputs: {
      size: "md",
      content: ({ titleId, descriptionId }: Dialog.ContentParts) => [
        Dialog.dialogHeader({}, [
          Dialog.dialogTitle({ id: titleId }, ["Replace API key"], h),
          Dialog.dialogDescription({ id: descriptionId }, [model.keyAccount ? accountLabel(model.keyAccount) : "Account", " keeps its saved chats."], h),
        ], h),
        Dialog.dialogBody({}, [
          h.form([h.OnSubmit(Message.SubmittedReplaceKey())], [
            settingsGroup({}, [
              settingsRow({ title: "New API key", wideControl: true }, [
                input({
                  type: "password",
                  value: model.replacementKey,
                  onInput: (value) => Message.ChangedReplacementKey({ value }),
                  attributes: [h.AriaLabel("Replacement API key"), h.Autocomplete("new-password"), h.Required(true)],
                }, h),
              ], h),
            ], h),
            model.accountsError ? settingsErrorBanner(model.accountsError, h) : null,
            formButtons("Save key", Message.ClickedCancelReplaceKey()),
          ]),
        ], h),
      ],
    },
    toParentMessage: (message) => Message.GotReplaceKeyDialogMessage({ message }),
  })

  const { account, service: connectService } = connecting
  const connectDialog = account && connectService
    ? h.submodel({
      slotId: "connect-account",
      model: model.connectDialog,
      view: Dialog.view,
      viewInputs: {
        size: "md",
        content: ({ titleId, descriptionId }: Dialog.ContentParts) => [
          Dialog.dialogHeader({}, [
            Dialog.dialogTitle({ id: titleId }, [accountLabel(account)], h),
            Dialog.dialogDescription({ id: descriptionId }, ["Sign in to this account’s separate profile."], h),
          ], h),
          Dialog.dialogBody({}, [
            model.accountsError ? settingsErrorBanner(model.accountsError, h) : null,
            h.submodel({
              slotId: "connect-card",
              model: model.connectCard,
              view: AuthCard.view,
              viewInputs: {
                service: {
                  ...connectService,
                  accountId: account.id,
                  label: accountLabel(account),
                  account: account.identity,
                  authStatus: account.authStatus,
                  login: account.login,
                  statusDetail: account.statusDetail,
                },
              },
              toParentMessage: (message) => Message.GotConnectCardMessage({ message }),
            }),
            connectService.installed && account.login.phase === "idle"
              ? button({ class: "mt-4", disabled: busy, attributes: [h.OnClick(Message.ClickedConnectSignIn({ accountId: account.id }))] }, [account.authStatus === "signed_in" ? "Sign in again" : "Sign in"], h)
              : null,
          ], h),
        ],
      },
      toParentMessage: (message) => Message.GotConnectDialogMessage({ message }),
    })
    : null

  return sectionContainer({
    sectionId: "providers",
    switched,
    mount: SectionMount(),
    unmounted: Message.UnmountedSection(),
    label: sectionLabel("providers"),
    subtitle: sectionSubtitle("providers"),
  }, [
    model.providersError ? settingsErrorBanner(model.providersError, h) : null,
    settingsGroups([
      model.accountsError ? settingsErrorBanner(model.accountsError, h) : null,
      accountsGroup,
      settingsGroup({ title: ["Provider setup"] }, snapshot
        // One surface for every account: each card drops its own box and
        // becomes a row of the group's card, with its actions drawn as text
        // like every other row's.
        ? snapshot.services.map((service) => authCard(service, { row: true, textActions: true }))
        : [h.div([h.Class("flex items-center gap-3 px-4 py-3 text-sm text-muted-foreground")], [
          Loader2({ class: "h-4 w-4 shrink-0 animate-spin" }, h),
          "Checking provider sign-in status…",
        ])], h),
      settingsGroup({ title: ["Defaults"] }, [
        settingsRow({ def: SETTINGS_ROWS.defaultProvider, description: null }, [
          select(
            "defaultProvider",
            prefs.defaultProvider,
            [{ value: "last_used", textValue: "Last Used" }, ...PROVIDERS.map((provider) => ({ value: provider.id, textValue: provider.label }))],
            renderDefaultProvider,
          ),
        ], h),
        defaultsRow("claude", { includeMode: true }),
        defaultsRow("codex", { includeMode: true }),
        defaultsRow("cursor", { includeMode: false }),
        defaultsRow("grok", { includeMode: true }),
        defaultsRow("pi", { includeMode: false }),
      ], h),
      settingsGroup({ title: ["Model Registry"] }, [
        model.llmProviderError || llmProvider?.warning
          ? h.div([h.Class("space-y-3 p-4")], [
            model.llmProviderError ? settingsNotice({}, [model.llmProviderError], h) : null,
            llmProvider?.warning ? settingsNotice({ tone: "warning" }, [llmProvider.warning], h) : null,
          ])
          : null,
        // Provider, endpoint, key and model each get a titled row, as in iOS
        // Settings: with no field frames, a stack of bare inputs in one row
        // left nothing to say which was which once filled.
        settingsRow({ def: SETTINGS_ROWS.modelRegistry, description: llmValidationDescription }, [
          select("llmProvider", draft.provider, QUICK_RESPONSE_PROVIDER_OPTIONS.map((option) => ({ value: option.value })), renderLlmProvider),
        ], h),
        draft.provider === "custom"
          ? settingsRow({ nested: true, wideControl: true, title: "Base URL" }, [
            llmField("baseUrl", { placeholder: "https://your-provider.example/v1", spellcheck: false }),
          ], h)
          : null,
        settingsRow({ nested: true, wideControl: true, title: "API Key" }, [
          llmField("apiKey", { type: "password", placeholder: "Required", spellcheck: true }),
        ], h),
        settingsRow({ nested: true, wideControl: true, title: "Quick Response Model" }, [
          llmField("model", { placeholder: "Model id", spellcheck: false }),
        ], h),
        settingsRow({ def: SETTINGS_ROWS.defaultModels, description: null }, [
          settingsActionButton({ onClick: Message.ClickedEditModels() }, ["Edit models"], h),
        ], h),
      ], h),
    ], h),
    h.submodel({
      slotId: "validation-error",
      model: model.validationDialog,
      view: Dialog.view,
      viewInputs: {
        size: "lg",
        content: ({ titleId }: Dialog.ContentParts) => [
          Dialog.dialogBody({ class: "space-y-4" }, [
            Dialog.dialogTitle({ id: titleId }, ["Validation Error"], h),
            h.pre([h.Class("max-h-[60vh] overflow-auto rounded-lg border border-border bg-muted p-3 text-xs font-mono whitespace-pre-wrap break-words")], [validation.errorText]),
          ], h),
          Dialog.dialogFooter({}, [
            button({ variant: "secondary", size: "sm", attributes: [h.OnClick(Message.ClickedCloseValidationError())] }, ["Close"], h),
          ], h),
        ],
      },
      toParentMessage: (message) => Message.GotValidationDialogMessage({ message }),
    }),
    h.submodel({
      slotId: "default-models",
      model: model.defaultModels,
      view: DefaultModelsDialog.view,
      toParentMessage: (message) => Message.GotDefaultModelsMessage({ message }),
    }),
    addAccountDialog,
    replaceKeyDialog,
    connectDialog,
  ], h)
})
