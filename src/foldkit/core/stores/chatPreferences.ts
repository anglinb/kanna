import { Schema } from "effect"
import type { Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import {
  createDefaultProviderDefaults,
  normalizeClaudePreference,
  normalizeCodexPreference,
  normalizeCursorPreference,
  normalizePiPreference,
  normalizeProviderDefaults,
  normalizeProviderPreference,
  PROVIDER_NORMALIZERS,
  type ProviderModelOptionsInput,
  type ProviderPreferenceInput,
} from "../../../shared/provider-preferences"
import {
  chatModeToFlags,
  type AgentProvider,
  type ChatProviderPreferences,
  type ClaudeModelOptions,
  type CodexModelOptions,
  type CursorModelOptions,
  type DefaultProviderPreference,
  type PiModelOptions,
  type ProviderModelOptionsByProvider,
  type ProviderPreference,
  type SidebarData,
} from "../../../shared/types"
import { opaque } from "../schema"
import { findSidebarChatRow } from "./sidebar"

// Port of src/client/stores/chatPreferencesStore.ts: the composer's provider,
// model and mode, per chat, and the defaults new chats start from. Not
// persisted (the defaults come from the app settings; `syncProviderDefaults`).
//
// The store read the sidebar store directly to seed a chat with nothing
// stored (`seedForChat`). Here the sidebar snapshot is an update input
// (`Context`), passed by the root from its sidebar Model, and a selector
// argument. The `console.info` the store logged on `initializeComposerForChat`
// is dropped: a debugging aid, not state.

export type { ChatProviderPreferences, DefaultProviderPreference, ProviderPreference }
// The normalizers live in shared/provider-preferences (also used by the server's
// settings-file normalization); re-exported here for existing importers/tests.
export {
  createDefaultProviderDefaults,
  normalizeClaudePreference,
  normalizeCodexPreference,
  normalizeCursorPreference,
  normalizePiPreference,
  normalizeProviderDefaults,
  normalizeProviderPreference,
}

export type ComposerState = {
  [TProvider in AgentProvider]: {
    provider: TProvider
    model: string
    modelOptions: ProviderModelOptionsByProvider[TProvider]
    planMode: boolean
    autoPlan: boolean
  }
}[AgentProvider]

export const NEW_CHAT_COMPOSER_ID = "__new__"

export function normalizeDefaultProvider(value?: string): DefaultProviderPreference {
  if (value === "claude" || value === "codex" || value === "cursor" || value === "grok" || value === "pi") return value
  return "last_used"
}

function composerStateForProvider(provider: AgentProvider, value?: ProviderPreferenceInput): ComposerState {
  // The normalizer record is keyed by provider, so the provider tag always matches
  // its normalized modelOptions shape; TS can't prove that across the union.
  return { provider, ...normalizeProviderPreference(provider, value) } as ComposerState
}

type PersistedComposerState = ProviderPreferenceInput & { provider: AgentProvider }

type LegacyPersistedChatPreferencesState = Partial<{
  defaultProvider: string
  providerDefaults: Partial<Record<AgentProvider, ProviderPreferenceInput>>
  composerState: PersistedComposerState
  liveProvider: AgentProvider
  livePreferences: Partial<Record<"claude" | "codex", ProviderPreferenceInput>>
}>

type PersistedChatPreferencesState = LegacyPersistedChatPreferencesState & Partial<{
  chatStates: Record<string, PersistedComposerState | ComposerState>
  legacyComposerState: PersistedComposerState | ComposerState | null
}>

function composerFromProviderDefaults(
  provider: AgentProvider,
  providerDefaults: ChatProviderPreferences
): ComposerState {
  return composerStateForProvider(provider, providerDefaults[provider])
}

/**
 * What the server knows a chat last ran with — the sidebar row's provider and
 * model. Nothing else survives a reload on this side, so this is what an
 * existing chat is seeded from. Settings defaults are for chats that have
 * never run; a chat that has picks up where it left off, on every device.
 */
export interface ComposerSeed {
  provider: AgentProvider
  model?: string
}

function composerFromChatSeed(seed: ComposerSeed, providerDefaults: ChatProviderPreferences): ComposerState {
  // Options (effort, context window…) aren't recorded per chat, so those still
  // come from the provider's defaults; the model is the chat's own.
  return composerStateForProvider(seed.provider, {
    ...providerDefaults[seed.provider],
    ...(seed.model ? { model: seed.model } : {}),
  })
}

function cloneComposerState(state: ComposerState): ComposerState {
  return { ...state, modelOptions: { ...state.modelOptions } } as ComposerState
}

function sameComposerState(left: ComposerState | undefined, right: ComposerState): boolean {
  if (!left || left.provider !== right.provider) return false
  if (left.model !== right.model || left.planMode !== right.planMode) return false
  if (left.autoPlan !== right.autoPlan) return false

  const leftOptions: Record<string, unknown> = { ...left.modelOptions }
  const rightOptions: Record<string, unknown> = { ...right.modelOptions }
  const keys = new Set([...Object.keys(leftOptions), ...Object.keys(rightOptions)])
  return [...keys].every((key) => leftOptions[key] === rightOptions[key])
}

function normalizeComposerState(
  value: PersistedComposerState | undefined,
  providerDefaults: ChatProviderPreferences,
  legacyLiveProvider?: AgentProvider,
  legacyLivePreferences?: LegacyPersistedChatPreferencesState["livePreferences"]
): ComposerState {
  // Persisted data is untrusted: only dispatch on providers we actually know.
  const provider = value?.provider
  if (provider && provider in PROVIDER_NORMALIZERS) {
    return composerStateForProvider(provider, value)
  }

  if (legacyLiveProvider === "claude" || legacyLiveProvider === "codex") {
    return composerStateForProvider(legacyLiveProvider, legacyLivePreferences?.[legacyLiveProvider])
  }

  return composerFromProviderDefaults("claude", providerDefaults)
}

function normalizePersistedComposerState(
  value: PersistedComposerState | ComposerState | undefined,
  providerDefaults: ChatProviderPreferences
): ComposerState | null {
  if (!value) return null
  return normalizeComposerState(value, providerDefaults)
}

function normalizeChatStates(
  value: Record<string, PersistedComposerState | ComposerState> | undefined,
  providerDefaults: ChatProviderPreferences
): Record<string, ComposerState> {
  if (!value) return {}

  return Object.fromEntries(
    Object.entries(value).map(([chatId, composerState]) => [
      chatId,
      normalizeComposerState(composerState, providerDefaults),
    ])
  )
}

function createComposerStateForNewChat(args: {
  defaultProvider: DefaultProviderPreference
  providerDefaults: ChatProviderPreferences
  sourceState?: ComposerState | null
  legacyComposerState?: ComposerState | null
}): ComposerState {
  if (args.defaultProvider === "last_used") {
    if (args.sourceState) {
      return cloneComposerState(args.sourceState)
    }

    if (args.legacyComposerState) {
      return cloneComposerState(args.legacyComposerState)
    }

    return composerFromProviderDefaults("claude", args.providerDefaults)
  }

  return composerFromProviderDefaults(args.defaultProvider, args.providerDefaults)
}

/**
 * The seed for a chat with nothing stored, read from the sidebar snapshot.
 * Every path that materialises state for a chat — including the mutation
 * Messages, which carry no seed — must start from the chat's own record, or a
 * Shift+Tab on a chat you just reloaded would pin it to the default provider
 * on its way to toggling the mode.
 */
export function seedForChat(sidebar: SidebarData, chatId: string): ComposerSeed | null {
  if (chatId === NEW_CHAT_COMPOSER_ID) return null
  const row = findSidebarChatRow(sidebar, chatId)
  if (!row?.provider) return null
  return { provider: row.provider, ...(row.model ? { model: row.model } : {}) }
}

const ComposerStateSchema = opaque<ComposerState>("ComposerState")
const AgentProviderSchema = Schema.Literals(["claude", "codex", "cursor", "grok", "pi"])
const DefaultProviderSchema = Schema.Literals(["last_used", "claude", "codex", "cursor", "grok", "pi"])
const ChatProviderPreferencesSchema = opaque<ChatProviderPreferences>("ChatProviderPreferences")
const ChatModeSchema = Schema.Literals(["full-access", "plan", "auto-plan"])

export const Model = Schema.Struct({
  defaultProvider: DefaultProviderSchema,
  providerDefaults: ChatProviderPreferencesSchema,
  chatStates: Schema.Record(Schema.String, ComposerStateSchema),
  /**
   * Chats where the user explicitly picked a different harness than the
   * chat's current provider — the switch (with server-side handoff) applies
   * on the next send. Deliberately not persisted: chat states seeded from
   * defaults must never read as an intentional switch.
   */
  pendingProviderSwitches: Schema.Record(Schema.String, Schema.Literal(true)),
  legacyComposerState: Schema.NullOr(ComposerStateSchema),
})
export type Model = typeof Model.Type

export const initialModel: Model = {
  defaultProvider: "last_used",
  providerDefaults: createDefaultProviderDefaults(),
  chatStates: {},
  pendingProviderSwitches: {},
  legacyComposerState: null,
}

/** What update reads from outside: the sidebar snapshot, for `seedForChat`. */
export interface Context {
  sidebar: SidebarData
}

type StoredFields = Pick<Model, "chatStates" | "defaultProvider" | "providerDefaults" | "legacyComposerState">

function getStoredComposerState(state: StoredFields, chatId: string, seed: ComposerSeed | null): ComposerState {
  const existingState = state.chatStates[chatId]
  if (existingState) {
    return existingState
  }
  if (seed) {
    return composerFromChatSeed(seed, state.providerDefaults)
  }

  return createComposerStateForNewChat({
    defaultProvider: state.defaultProvider,
    providerDefaults: state.providerDefaults,
    legacyComposerState: state.legacyComposerState,
  })
}

function withChatComposerState(
  model: Model,
  context: Context,
  chatId: string,
  transform: (composerState: ComposerState) => ComposerState
): Model {
  const currentComposerState = getStoredComposerState(model, chatId, seedForChat(context.sidebar, chatId))
  return {
    ...model,
    chatStates: {
      ...model.chatStates,
      [chatId]: transform(currentComposerState),
    },
  }
}

export function migrateChatPreferencesState(
  persistedState: PersistedChatPreferencesState | undefined
): Pick<Model, "defaultProvider" | "providerDefaults" | "chatStates" | "legacyComposerState"> {
  const providerDefaults = normalizeProviderDefaults(persistedState?.providerDefaults)
  const legacyComposerState = normalizePersistedComposerState(
    persistedState?.legacyComposerState ?? persistedState?.composerState,
    providerDefaults
  )
  const legacyLiveComposerState = persistedState?.liveProvider
    ? normalizeComposerState(
      undefined,
      providerDefaults,
      persistedState.liveProvider,
      persistedState?.livePreferences
    )
    : null

  return {
    defaultProvider: normalizeDefaultProvider(persistedState?.defaultProvider),
    providerDefaults,
    chatStates: normalizeChatStates(persistedState?.chatStates, providerDefaults),
    legacyComposerState: legacyComposerState ?? legacyLiveComposerState,
  }
}

type ModelOptionsPatch = Partial<ClaudeModelOptions> | Partial<CodexModelOptions> | Partial<CursorModelOptions> | Partial<PiModelOptions>
const ModelOptionsPatchSchema = opaque<ModelOptionsPatch>("ModelOptionsPatch")

export const Message = defineMessageUnion({
  ChangedDefaultProvider: { provider: DefaultProviderSchema },
  /** The app settings' defaults arrived or changed (`syncProviderDefaults`). */
  SyncedProviderDefaults: { defaultProvider: DefaultProviderSchema, providerDefaults: ChatProviderPreferencesSchema },
  ChangedProviderDefaultModel: { provider: AgentProviderSchema, model: Schema.String },
  ChangedProviderDefaultModelOptions: { provider: AgentProviderSchema, modelOptions: ModelOptionsPatchSchema },
  ChangedProviderDefaultMode: { provider: AgentProviderSchema, mode: ChatModeSchema },
  InitializedComposerForChat: { chatId: Schema.String, sourceState: Schema.NullOr(ComposerStateSchema) },
  ChangedComposerState: { chatId: Schema.String, composerState: ComposerStateSchema },
  ChangedChatComposerProvider: { chatId: Schema.String, provider: AgentProviderSchema },
  ChangedChatComposerModel: { chatId: Schema.String, model: Schema.String },
  ChangedChatComposerModelOptions: { chatId: Schema.String, modelOptions: ModelOptionsPatchSchema },
  ChangedChatComposerMode: { chatId: Schema.String, mode: ChatModeSchema },
  /**
   * Clears plan mode while leaving `autoPlan` untouched — used when a plan is
   * approved, so an Auto Plan user returns to Auto Plan rather than dropping
   * to Full Access.
   */
  ClearedChatComposerPlanMode: { chatId: Schema.String },
  ResetChatComposerFromProvider: { chatId: Schema.String, provider: AgentProviderSchema },
  MarkedPendingProviderSwitch: { chatId: Schema.String },
  ClearedPendingProviderSwitch: { chatId: Schema.String },
})
export type Message = typeof Message.Type

export const update = (model: Model, message: Message, context: Context): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    ChangedDefaultProvider: ({ provider }) => ({ model: { ...model, defaultProvider: provider } }),
    SyncedProviderDefaults: ({ defaultProvider, providerDefaults }) => {
      const oldNewChatFallback = createComposerStateForNewChat({
        defaultProvider: model.defaultProvider,
        providerDefaults: model.providerDefaults,
        legacyComposerState: model.legacyComposerState,
      })
      const nextNewChatFallback = createComposerStateForNewChat({
        defaultProvider,
        providerDefaults,
        legacyComposerState: model.legacyComposerState,
      })
      // Only the new-chat composer follows a change of defaults, and only
      // while it is still untouched. A chat that has run keeps what it ran
      // with: defaults are for starting chats, not for changing them.
      const newChatState = model.chatStates[NEW_CHAT_COMPOSER_ID]
      const chatStates = newChatState && sameComposerState(newChatState, oldNewChatFallback)
        ? { ...model.chatStates, [NEW_CHAT_COMPOSER_ID]: nextNewChatFallback }
        : model.chatStates
      return { model: { ...model, defaultProvider, providerDefaults, chatStates } }
    },
    ChangedProviderDefaultModel: ({ provider, model: modelId }) => ({
      model: {
        ...model,
        providerDefaults: {
          ...model.providerDefaults,
          [provider]: normalizeProviderPreference(provider, { ...model.providerDefaults[provider], model: modelId }),
        },
      },
    }),
    ChangedProviderDefaultModelOptions: ({ provider, modelOptions }) => ({
      model: {
        ...model,
        providerDefaults: {
          ...model.providerDefaults,
          [provider]: normalizeProviderPreference(provider, {
            ...model.providerDefaults[provider],
            modelOptions: {
              ...model.providerDefaults[provider].modelOptions,
              ...modelOptions,
            } as ProviderModelOptionsInput,
          }),
        },
      },
    }),
    ChangedProviderDefaultMode: ({ provider, mode }) => ({
      model: {
        ...model,
        providerDefaults: {
          ...model.providerDefaults,
          [provider]: {
            ...model.providerDefaults[provider],
            ...chatModeToFlags(mode, model.providerDefaults[provider].autoPlan),
          },
        },
      },
    }),
    InitializedComposerForChat: ({ chatId, sourceState }) => {
      if (model.chatStates[chatId]) return { model }
      const composerState = createComposerStateForNewChat({
        defaultProvider: model.defaultProvider,
        providerDefaults: model.providerDefaults,
        sourceState,
        legacyComposerState: model.legacyComposerState,
      })
      return { model: { ...model, chatStates: { ...model.chatStates, [chatId]: composerState } } }
    },
    ChangedComposerState: ({ chatId, composerState }) => ({
      model: {
        ...model,
        chatStates: {
          ...model.chatStates,
          // Claude/Codex states are re-normalized (model aliases, effort clamps);
          // Cursor/Pi states are historically stored as provided.
          [chatId]: composerState.provider === "claude" || composerState.provider === "codex"
            ? composerStateForProvider(composerState.provider, composerState)
            : cloneComposerState(composerState),
        },
      },
    }),
    ChangedChatComposerProvider: ({ chatId, provider }) => ({
      model: withChatComposerState(model, context, chatId, () => composerFromProviderDefaults(provider, model.providerDefaults)),
    }),
    ChangedChatComposerModel: ({ chatId, model: modelId }) => ({
      model: withChatComposerState(model, context, chatId, (composerState) =>
        composerStateForProvider(composerState.provider, { ...composerState, model: modelId })
      ),
    }),
    ChangedChatComposerModelOptions: ({ chatId, modelOptions }) => ({
      model: withChatComposerState(model, context, chatId, (composerState) =>
        composerStateForProvider(composerState.provider, {
          ...composerState,
          modelOptions: { ...composerState.modelOptions, ...modelOptions } as ProviderModelOptionsInput,
        })
      ),
    }),
    ChangedChatComposerMode: ({ chatId, mode }) => ({
      model: withChatComposerState(model, context, chatId, (composerState) => ({
        ...composerState,
        ...chatModeToFlags(mode, composerState.autoPlan),
      })),
    }),
    ClearedChatComposerPlanMode: ({ chatId }) => ({
      model: withChatComposerState(model, context, chatId, (composerState) => ({
        ...composerState,
        planMode: false,
      })),
    }),
    ResetChatComposerFromProvider: ({ chatId, provider }) => ({
      model: {
        ...model,
        chatStates: { ...model.chatStates, [chatId]: composerFromProviderDefaults(provider, model.providerDefaults) },
      },
    }),
    MarkedPendingProviderSwitch: ({ chatId }) => ({
      model: model.pendingProviderSwitches[chatId]
        ? model
        : { ...model, pendingProviderSwitches: { ...model.pendingProviderSwitches, [chatId]: true as const } },
    }),
    ClearedPendingProviderSwitch: ({ chatId }) => {
      if (!model.pendingProviderSwitches[chatId]) return { model }
      const { [chatId]: _cleared, ...rest } = model.pendingProviderSwitches
      return { model: { ...model, pendingProviderSwitches: rest } }
    },
  })

/**
 * A chat's composer state: what is stored for it, else what it last ran with
 * (`seed`; when omitted, read from the sidebar snapshot as the store did),
 * else the defaults for a new chat. A copy, so a caller may change it freely.
 */
export function getComposerState(model: Model, sidebar: SidebarData, chatId: string, seed?: ComposerSeed | null): ComposerState {
  return cloneComposerState(getStoredComposerState(model, chatId, seed === undefined ? seedForChat(sidebar, chatId) : seed))
}

export function hasPendingProviderSwitch(model: Model, chatId: string): boolean {
  return Boolean(model.pendingProviderSwitches[chatId])
}
