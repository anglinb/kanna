import { describe, expect, test } from "bun:test"
import type { SidebarData, SidebarProjectGroup } from "../../../shared/types"
import {
  getComposerState,
  initialModel,
  Message,
  migrateChatPreferencesState,
  NEW_CHAT_COMPOSER_ID,
  update as updateWith,
  type Model,
} from "./chatPreferences"
import { run } from "./testing"

const NO_SIDEBAR: SidebarData = { projectGroups: [] }
const update = (model: Model, message: Message) => updateWith(model, message, { sidebar: NO_SIDEBAR })
const composer = (model: Model, chatId: string, seed?: Parameters<typeof getComposerState>[3]) =>
  getComposerState(model, NO_SIDEBAR, chatId, seed)

describe("migrateChatPreferencesState", () => {
  test("state persisted before Auto Plan existed migrates to Full Access", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "last_used",
      providerDefaults: {
        // No autoPlan key at all — exactly what an older Kanna wrote.
        claude: {
          model: "opus",
          modelOptions: { reasoningEffort: "high", contextWindow: "1m", fastMode: false },
          planMode: false,
        },
      },
    } as never)

    expect(migrated.providerDefaults.claude.autoPlan).toBe(false)
    // Auto Plan is Claude-only; the other harnesses are pinned to false.
    expect(migrated.providerDefaults.codex.autoPlan).toBe(false)
    expect(migrated.providerDefaults.cursor.autoPlan).toBe(false)
    expect(migrated.providerDefaults.grok.autoPlan).toBe(false)
    expect(migrated.providerDefaults.pi.autoPlan).toBe(false)
  })

  test("preserves max effort for versioned Opus Claude models", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "last_used",
      providerDefaults: {
        claude: {
          model: "claude-opus-4-8",
          modelOptions: { reasoningEffort: "max", contextWindow: "1m", fastMode: false },
          planMode: false,
          autoPlan: false,
        },
      },
    })

    expect(migrated.providerDefaults.claude).toEqual({
      // The version-pinned id folds into the alias while keeping max effort.
      model: "opus",
      modelOptions: { reasoningEffort: "max", contextWindow: "1m", fastMode: false },
      planMode: false,
      autoPlan: false,
    })
  })

  test("normalizes provider defaults and legacy composer state", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "last_used",
      providerDefaults: {
        claude: {
          model: "opus",
          modelOptions: { reasoningEffort: "low", contextWindow: "1m", fastMode: false },
          planMode: true,
          autoPlan: false,
        },
        codex: {
          model: "gpt-5.3-codex",
          modelOptions: { reasoningEffort: "minimal", fastMode: true },
          planMode: false,
          autoPlan: false,
        },
      },
      composerState: {
        provider: "claude",
        model: "sonnet",
        modelOptions: { reasoningEffort: "max", contextWindow: "1m", fastMode: false },
        planMode: false,
        autoPlan: false,
      },
    })

    expect(migrated).toEqual({
      defaultProvider: "last_used",
      providerDefaults: {
        claude: {
          model: "opus",
          modelOptions: { reasoningEffort: "low", contextWindow: "1m", fastMode: false },
          planMode: true,
          autoPlan: false,
        },
        codex: {
          model: "gpt-5.3-codex",
          modelOptions: { reasoningEffort: "minimal", fastMode: true },
          planMode: false,
          autoPlan: false,
        },
        cursor: {
          model: "composer-2.5",
          modelOptions: { fastMode: false },
          planMode: false,
          autoPlan: false,
        },
        grok: {
          model: "grok-4.6",
          modelOptions: { reasoningEffort: "high" },
          planMode: false,
          autoPlan: false,
        },
        pi: {
          model: "~anthropic/claude-fable-latest",
          modelOptions: { reasoningEffort: "medium" },
          planMode: false,
          autoPlan: false,
        },
      },
      chatStates: {},
      legacyComposerState: {
        provider: "claude",
        model: "sonnet",
        modelOptions: { reasoningEffort: "high", contextWindow: "1m", fastMode: false },
        planMode: false,
        autoPlan: false,
      },
    })
  })

  // Models without a context window selector store the default *preference*
  // (the effective window is clamped at usage time via resolveClaudeContextWindow),
  // so a stale clamp never carries over when switching to a supporting model.
  test("resets Claude context window to the default preference for unsupported models during migration", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "last_used",
      providerDefaults: {
        claude: {
          model: "haiku",
          modelOptions: { reasoningEffort: "low", contextWindow: "1m" as never, fastMode: false },
          planMode: false,
          autoPlan: false,
        },
      },
      chatStates: {
        chatA: {
          provider: "claude",
          model: "haiku",
          modelOptions: { reasoningEffort: "high", contextWindow: "1m" as never, fastMode: false },
          planMode: false,
          autoPlan: false,
        },
      },
    })

    expect(migrated.providerDefaults.claude.modelOptions).toEqual({ reasoningEffort: "low", contextWindow: "1m", fastMode: false })
    expect(migrated.chatStates.chatA).toEqual({
      provider: "claude",
      model: "haiku",
      modelOptions: { reasoningEffort: "high", contextWindow: "1m", fastMode: false },
      planMode: false,
      autoPlan: false,
    })
  })

  test("preserves persisted legacy Codex defaults during migration", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "last_used",
      providerDefaults: {
        codex: {
          model: "gpt-5-codex",
          modelOptions: { reasoningEffort: "low", fastMode: true },
          planMode: false,
          autoPlan: false,
        },
      },
    })

    expect(migrated.providerDefaults.codex).toEqual({
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "low", fastMode: true },
      planMode: false,
      autoPlan: false,
    })
  })

  test("preserves supported persisted Codex composer models during migration", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "codex",
      providerDefaults: {
        codex: {
          model: "gpt-5.3-codex-spark",
          modelOptions: { reasoningEffort: "low", fastMode: true },
          planMode: true,
          autoPlan: false,
        },
      },
      chatStates: {
        chatA: {
          provider: "codex",
          model: "gpt-5.4",
          modelOptions: { reasoningEffort: "medium", fastMode: false },
          planMode: false,
          autoPlan: false,
        },
      },
      legacyComposerState: {
        provider: "codex",
        model: "gpt-5.3-codex",
        modelOptions: { reasoningEffort: "xhigh", fastMode: true },
        planMode: true,
        autoPlan: false,
      },
    })

    expect(migrated.providerDefaults.codex).toEqual({
      model: "gpt-5.3-codex-spark",
      modelOptions: { reasoningEffort: "low", fastMode: true },
      planMode: true,
      autoPlan: false,
    })
    expect(migrated.chatStates.chatA).toEqual({
      provider: "codex",
      model: "gpt-5.4",
      modelOptions: { reasoningEffort: "medium", fastMode: false },
      planMode: false,
      autoPlan: false,
    })
    expect(migrated.legacyComposerState).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "xhigh", fastMode: true },
      planMode: true,
      autoPlan: false,
    })
  })

  test("preserves persisted GPT-5.6 defaults and Ultra during migration", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "codex",
      providerDefaults: {
        codex: {
          model: "gpt-5.6-terra",
          modelOptions: { reasoningEffort: "ultra", fastMode: true },
          planMode: true,
          autoPlan: false,
        },
      },
    })

    expect(migrated.providerDefaults.codex).toEqual({
      model: "gpt-5.6-terra",
      modelOptions: { reasoningEffort: "ultra", fastMode: true },
      planMode: true,
      autoPlan: false,
    })
  })
})

describe("chat preferences", () => {
  test("starts with GPT-5.6 Sol and Medium as the default Codex configuration", () => {
    expect(initialModel.providerDefaults.codex).toEqual({
      model: "gpt-5.6-sol",
      modelOptions: { reasoningEffort: "medium", fastMode: false },
      planMode: false,
      autoPlan: false,
    })
  })

  test("normalizes legacy and unsupported GPT-5.6 reasoning levels", () => {
    const model = run(
      update,
      initialModel,
      Message.ChangedComposerState({
        chatId: "sol",
        composerState: {
          provider: "codex",
          model: "gpt-5.6-sol",
          modelOptions: { reasoningEffort: "minimal", fastMode: false },
          planMode: false,
          autoPlan: false,
        },
      }),
      Message.ChangedComposerState({
        chatId: "luna",
        composerState: {
          provider: "codex",
          model: "gpt-5.6-luna",
          modelOptions: { reasoningEffort: "ultra", fastMode: false },
          planMode: false,
          autoPlan: false,
        },
      }),
    )

    expect(composer(model, "sol").modelOptions).toMatchObject({ reasoningEffort: "low" })
    expect(composer(model, "luna").modelOptions).toMatchObject({ reasoningEffort: "max" })
  })

  test("downgrades Ultra to Max when switching from Sol to Luna", () => {
    const model = run(
      update,
      initialModel,
      Message.ChangedComposerState({
        chatId: "chat-a",
        composerState: {
          provider: "codex",
          model: "gpt-5.6-sol",
          modelOptions: { reasoningEffort: "ultra", fastMode: false },
          planMode: false,
          autoPlan: false,
        },
      }),
      Message.ChangedChatComposerModel({ chatId: "chat-a", model: "gpt-5.6-luna" }),
    )

    expect(composer(model, "chat-a")).toMatchObject({
      model: "gpt-5.6-luna",
      modelOptions: { reasoningEffort: "max" },
    })
  })

  test("editing provider defaults does not change existing chat state", () => {
    const model = run(
      update,
      initialModel,
      Message.ChangedComposerState({
        chatId: "chat-a",
        composerState: {
          provider: "codex",
          model: "gpt-5.3-codex",
          modelOptions: { reasoningEffort: "minimal", fastMode: true },
          planMode: true,
          autoPlan: false,
        },
      }),
      Message.ChangedProviderDefaultModel({ provider: "codex", model: "gpt-5.3-codex-spark" }),
      Message.ChangedProviderDefaultModelOptions({ provider: "codex", modelOptions: { reasoningEffort: "low", fastMode: false } }),
      Message.ChangedProviderDefaultMode({ provider: "codex", mode: "full-access" }),
    )

    expect(composer(model, "chat-a")).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
      autoPlan: false,
    })
    expect(model.providerDefaults.codex).toMatchObject({
      model: "gpt-5.3-codex-spark",
      modelOptions: { reasoningEffort: "low", fastMode: false },
    })
  })

  test("approving a plan returns an Auto Plan chat to Auto Plan, not Full Access", () => {
    const modeOf = (model: Model, chatId: string) => {
      const state = composer(model, chatId)
      return { planMode: state.planMode, autoPlan: state.autoPlan }
    }

    let model = run(update, initialModel, Message.ChangedChatComposerMode({ chatId: "chat-a", mode: "auto-plan" }))
    expect(modeOf(model, "chat-a")).toEqual({ planMode: false, autoPlan: true })

    // Manually flipping to Plan Mode holds autoPlan underneath…
    model = run(update, model, Message.ChangedChatComposerMode({ chatId: "chat-a", mode: "plan" }))
    expect(modeOf(model, "chat-a")).toEqual({ planMode: true, autoPlan: true })

    // …so clearing plan mode on approval lands back in Auto Plan.
    model = run(update, model, Message.ClearedChatComposerPlanMode({ chatId: "chat-a" }))
    expect(modeOf(model, "chat-a")).toEqual({ planMode: false, autoPlan: true })

    // A chat that was never in Auto Plan lands in Full Access instead.
    model = run(
      update,
      model,
      Message.ChangedChatComposerMode({ chatId: "chat-b", mode: "plan" }),
      Message.ClearedChatComposerPlanMode({ chatId: "chat-b" }),
    )
    expect(modeOf(model, "chat-b")).toEqual({ planMode: false, autoPlan: false })
  })

  test("restores isolated composer state by chat id", () => {
    const model = run(
      update,
      initialModel,
      Message.ChangedComposerState({
        chatId: "chat-a",
        composerState: {
          provider: "claude",
          model: "sonnet",
          modelOptions: { reasoningEffort: "low", contextWindow: "1m", fastMode: false },
          planMode: false,
          autoPlan: false,
        },
      }),
      Message.ChangedComposerState({
        chatId: "chat-b",
        composerState: {
          provider: "codex",
          model: "gpt-5.3-codex",
          modelOptions: { reasoningEffort: "minimal", fastMode: true },
          planMode: true,
          autoPlan: false,
        },
      }),
      Message.ChangedChatComposerMode({ chatId: "chat-a", mode: "plan" }),
    )

    expect(composer(model, "chat-a")).toEqual({
      provider: "claude",
      model: "sonnet",
      modelOptions: { reasoningEffort: "low", contextWindow: "1m", fastMode: false },
      planMode: true,
      autoPlan: false,
    })
    expect(composer(model, "chat-b")).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
      autoPlan: false,
    })
  })

  test("switching Claude chat model keeps the context window preference without clamping", () => {
    const model = run(
      update,
      initialModel,
      Message.ChangedComposerState({
        chatId: "chat-a",
        composerState: {
          provider: "claude",
          model: "opus",
          modelOptions: { reasoningEffort: "high", contextWindow: "1m", fastMode: false },
          planMode: false,
          autoPlan: false,
        },
      }),
      Message.ChangedChatComposerModel({ chatId: "chat-a", model: "haiku" }),
    )

    // Stored preference stays "1m" — haiku is clamped to the standard window
    // at usage time, and switching back to Opus resumes the 1m preference.
    expect(composer(model, "chat-a")).toEqual({
      provider: "claude",
      model: "haiku",
      modelOptions: { reasoningEffort: "high", contextWindow: "1m", fastMode: false },
      planMode: false,
      autoPlan: false,
    })
  })

  test("changing the model or options of a Cursor chat keeps it on Cursor", () => {
    let model = run(
      update,
      initialModel,
      Message.ChangedComposerState({
        chatId: "chat-a",
        composerState: {
          provider: "cursor",
          model: "composer-2.5",
          modelOptions: { fastMode: true },
          planMode: false,
          autoPlan: false,
        },
      }),
      // Selecting the model must not silently convert the composer to Codex.
      Message.ChangedChatComposerModel({ chatId: "chat-a", model: "composer-2.5" }),
    )
    expect(composer(model, "chat-a")).toEqual({
      provider: "cursor",
      model: "composer-2.5",
      modelOptions: { fastMode: true },
      planMode: false,
      autoPlan: false,
    })

    model = run(update, model, Message.ChangedChatComposerModelOptions({ chatId: "chat-a", modelOptions: { fastMode: false } }))
    expect(composer(model, "chat-a")).toEqual({
      provider: "cursor",
      model: "composer-2.5",
      modelOptions: { fastMode: false },
      planMode: false,
      autoPlan: false,
    })
  })

  test("resetting a chat from a provider copies that provider's defaults into it", () => {
    const given: Model = {
      ...initialModel,
      providerDefaults: {
        ...initialModel.providerDefaults,
        codex: {
          model: "gpt-5.3-codex",
          modelOptions: { reasoningEffort: "minimal", fastMode: true },
          planMode: true,
          autoPlan: false,
        },
      },
    }

    const model = run(update, given, Message.ResetChatComposerFromProvider({ chatId: "chat-a", provider: "codex" }))

    expect(composer(model, "chat-a")).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
      autoPlan: false,
    })
  })

  test("initializing a chat uses explicit provider defaults for new chats", () => {
    const given: Model = {
      ...initialModel,
      defaultProvider: "codex",
      providerDefaults: {
        ...initialModel.providerDefaults,
        codex: {
          model: "gpt-5.3-codex-spark",
          modelOptions: { reasoningEffort: "minimal", fastMode: true },
          planMode: true,
          autoPlan: false,
        },
      },
    }

    const model = run(update, given, Message.InitializedComposerForChat({ chatId: "chat-a", sourceState: null }))

    expect(composer(model, "chat-a")).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
      autoPlan: false,
    })
  })

  test("last_used falls back to provider defaults when no real last-used state exists", () => {
    const given: Model = {
      ...initialModel,
      defaultProvider: "last_used",
      providerDefaults: {
        ...initialModel.providerDefaults,
        claude: {
          model: "opus",
          modelOptions: { reasoningEffort: "max", contextWindow: "1m", fastMode: false },
          planMode: true,
          autoPlan: false,
        },
      },
      legacyComposerState: null,
    }

    const model = run(update, given, Message.InitializedComposerForChat({ chatId: "chat-a", sourceState: null }))

    expect(composer(model, "chat-a")).toEqual({
      provider: "claude",
      model: "opus",
      modelOptions: { reasoningEffort: "max", contextWindow: "1m", fastMode: false },
      planMode: true,
      autoPlan: false,
    })
  })

  test("syncing provider defaults refreshes untouched new-chat state after settings hydration", () => {
    const model = run(
      update,
      initialModel,
      Message.InitializedComposerForChat({ chatId: NEW_CHAT_COMPOSER_ID, sourceState: null }),
      Message.SyncedProviderDefaults({
        defaultProvider: "last_used",
        providerDefaults: {
          ...initialModel.providerDefaults,
          claude: {
            model: "opus",
            modelOptions: { reasoningEffort: "max", contextWindow: "1m", fastMode: false },
            planMode: true,
            autoPlan: false,
          },
        },
      }),
    )

    expect(composer(model, NEW_CHAT_COMPOSER_ID)).toEqual({
      provider: "claude",
      model: "opus",
      modelOptions: { reasoningEffort: "max", contextWindow: "1m", fastMode: false },
      planMode: true,
      autoPlan: false,
    })
  })

  test("syncing provider defaults leaves a routed chat's state alone", () => {
    // Defaults are for starting chats. A chat that already has state — even
    // state equal to the old defaults — keeps it when the defaults move;
    // otherwise changing a setting would swap the model mid-conversation.
    const initialized = run(update, initialModel, Message.InitializedComposerForChat({ chatId: "chat-a", sourceState: null }))
    const before = composer(initialized, "chat-a")
    const model = run(update, initialized, Message.SyncedProviderDefaults({
      defaultProvider: "last_used",
      providerDefaults: {
        ...initialModel.providerDefaults,
        claude: {
          model: "opus",
          modelOptions: { reasoningEffort: "max", contextWindow: "1m", fastMode: false },
          planMode: true,
          autoPlan: false,
        },
      },
    }))

    expect(composer(model, "chat-a")).toEqual(before)
  })

  test("mutations seed an un-stored chat from the sidebar row, not the defaults", () => {
    // Shift+Tab (mode cycle) and plan approval change a chat that may have
    // nothing stored. They must still start from the chat's record, or the
    // write pins the default provider on its way through.
    const sidebar = {
      projectGroups: [{
        chats: [{ chatId: "chat-a", provider: "codex", model: "gpt-5.5" }],
      } as unknown as SidebarProjectGroup],
    } satisfies SidebarData
    const result = updateWith(
      { ...initialModel, defaultProvider: "claude" },
      Message.ChangedChatComposerMode({ chatId: "chat-a", mode: "plan" }),
      { sidebar },
    )
    const stored = result.model.chatStates["chat-a"]
    expect(stored?.provider).toBe("codex")
    expect(stored?.model).toBe("gpt-5.5")
    expect(stored?.planMode).toBe(true)
    // And the selector reads the same seed when the caller gives none.
    expect(getComposerState({ ...initialModel, defaultProvider: "claude" }, sidebar, "chat-a").provider).toBe("codex")
  })

  test("a chat's composer is seeded from what it last ran with", () => {
    // Nothing is stored for the chat (a reload emptied this model, or this is
    // another device). The chat's own record wins over the settings defaults.
    const given: Model = {
      ...initialModel,
      defaultProvider: "claude",
      providerDefaults: {
        ...initialModel.providerDefaults,
        codex: {
          model: "gpt-5.3-codex-spark",
          modelOptions: { reasoningEffort: "minimal", fastMode: true },
          planMode: true,
          autoPlan: false,
        },
      },
    }

    expect(composer(given, "chat-a", { provider: "codex", model: "gpt-5.5" })).toEqual({
      provider: "codex",
      model: "gpt-5.5",
      // Options aren't recorded per chat, so those are the provider's defaults.
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
      autoPlan: false,
    })
    // Stored state, once the user has touched the composer, still wins.
    const model = run(update, given, Message.ChangedChatComposerModel({ chatId: "chat-a", model: "gpt-5.3-codex-spark" }))
    expect(composer(model, "chat-a", { provider: "codex", model: "gpt-5.5" }).model).toBe("gpt-5.3-codex-spark")
  })

  test("syncing provider defaults does not replace a changed new-chat state", () => {
    const model = run(
      update,
      initialModel,
      Message.ChangedComposerState({
        chatId: NEW_CHAT_COMPOSER_ID,
        composerState: {
          provider: "codex",
          model: "gpt-5.5",
          modelOptions: { reasoningEffort: "low", fastMode: true },
          planMode: false,
          autoPlan: false,
        },
      }),
      Message.SyncedProviderDefaults({
        defaultProvider: "last_used",
        providerDefaults: {
          ...initialModel.providerDefaults,
          claude: {
            model: "opus",
            modelOptions: { reasoningEffort: "max", contextWindow: "1m", fastMode: false },
            planMode: true,
            autoPlan: false,
          },
        },
      }),
    )

    expect(composer(model, NEW_CHAT_COMPOSER_ID)).toEqual({
      provider: "codex",
      model: "gpt-5.5",
      modelOptions: { reasoningEffort: "low", fastMode: true },
      planMode: false,
      autoPlan: false,
    })
  })

  test("initializing with last_used copies the provided source state", () => {
    const given: Model = {
      ...initialModel,
      defaultProvider: "last_used",
      chatStates: {
        [NEW_CHAT_COMPOSER_ID]: {
          provider: "codex",
          model: "gpt-5.3-codex",
          modelOptions: { reasoningEffort: "low", fastMode: false },
          planMode: true,
          autoPlan: false,
        },
      },
    }

    const sourceState = composer(given, NEW_CHAT_COMPOSER_ID)
    const model = run(update, given, Message.InitializedComposerForChat({ chatId: "chat-a", sourceState }))

    expect(composer(model, "chat-a")).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "low", fastMode: false },
      planMode: true,
      autoPlan: false,
    })
  })

  test("a pending provider switch is marked once and cleared", () => {
    const marked = run(update, initialModel, Message.MarkedPendingProviderSwitch({ chatId: "chat-a" }))
    expect(marked.pendingProviderSwitches).toEqual({ "chat-a": true })
    expect(run(update, marked, Message.MarkedPendingProviderSwitch({ chatId: "chat-a" }))).toBe(marked)
    expect(run(update, marked, Message.ClearedPendingProviderSwitch({ chatId: "chat-a" })).pendingProviderSwitches).toEqual({})
  })
})
