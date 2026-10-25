import {
  chatModeFromFlags,
  CLAUDE_CONTEXT_WINDOW_OPTIONS,
  CLAUDE_REASONING_OPTIONS,
  getCodexReasoningOptions,
  GROK_REASONING_OPTIONS,
  normalizeClaudeContextWindow,
  normalizeClaudeFastMode,
  normalizeCodexModelId,
  normalizeCodexReasoningEffort,
  PI_REASONING_OPTIONS,
  supportsClaudeMaxReasoningEffort,
  type ChatMode,
  type ClaudeContextWindow,
  type ProviderCatalogEntry,
} from "../../shared/types"
import type { ComposerState } from "../core/stores/chatPreferences"

// Copied from src/client/lib/composer.ts, which imports the React
// chatPreferencesStore (zustand) for one constant: the pieces the provider
// defaults rows use, unchanged. The composer slice may own a copy too; the
// integrator can make it one.

/**
 * The step the chat composer takes when a model is picked: options that
 * depend on the model are checked against the live catalog entry, so a Codex
 * effort the new model does not offer moves to one it does.
 */
export function applyModelToComposerState(
  state: ComposerState,
  model: string,
  providerConfig?: ProviderCatalogEntry,
): ComposerState {
  if (state.provider === "codex") {
    const normalizedModel = normalizeCodexModelId(model)
    return {
      ...state,
      model: normalizedModel,
      modelOptions: {
        ...state.modelOptions,
        reasoningEffort: normalizeCodexReasoningEffort(
          normalizedModel,
          state.modelOptions.reasoningEffort,
          providerConfig?.id === "codex" ? providerConfig.models : undefined,
        ),
      },
    }
  }
  if (state.provider !== "claude") return { ...state, model }
  return {
    ...state,
    model,
    modelOptions: {
      ...state.modelOptions,
      contextWindow: normalizeClaudeContextWindow(model, state.modelOptions.contextWindow),
      fastMode: normalizeClaudeFastMode(model, state.modelOptions.fastMode),
    },
  }
}

export interface ComposerOptionChoice {
  id: string
  label: string
  description?: string
  disabled?: boolean
}

export interface ComposerOptionControls {
  /** Reasoning-effort selector, or null when the provider has none (e.g. cursor). */
  reasoning: { options: ComposerOptionChoice[]; selectedId: string | undefined } | null
  /** Claude context-window selector, or null when the model has a single window. */
  contextWindow: { options: ComposerOptionChoice[]; selectedId: ClaudeContextWindow } | null
  /** Fast-mode toggle, or null when the selected model doesn't support it. */
  fastMode: { enabled: boolean } | null
  /**
   * Mode selector, or null when the provider has no modes (cursor, pi).
   * `options` is in display order — it is also the Shift+Tab cycle order, so
   * codex cycles between two entries and claude between three.
   */
  mode: { selected: ChatMode; options: ChatMode[] } | null
}

/** Labels/descriptions for each mode, shared by the picker and command palette. */
export const CHAT_MODE_LABELS: Record<ChatMode, { label: string; description: string }> = {
  "full-access": { label: "Full Access", description: "Execution without approval" },
  "plan": { label: "Plan Mode", description: "Review a plan before execution" },
  "auto-plan": { label: "Auto Plan", description: "The agent decides when to plan first" },
}

/**
 * Which per-model/provider option controls are available for a composer state
 * and what their current values are. This is the single availability registry
 * consumed by ChatPreferenceControls (chat input + provider defaults in
 * settings) and the command palette.
 */
export function deriveComposerOptionControls(
  state: ComposerState,
  providerConfig: ProviderCatalogEntry | undefined
): ComposerOptionControls {
  const selectedModelOption = providerConfig?.models.find((candidate) => candidate.id === state.model)
  const modelOptions = state.modelOptions as {
    reasoningEffort?: string
    contextWindow?: ClaudeContextWindow
    fastMode?: boolean
  }

  const reasoning = state.provider === "cursor"
    ? null
    : {
      options: (
        state.provider === "claude"
          ? CLAUDE_REASONING_OPTIONS.map((option) => ({
            ...option,
            disabled: option.id === "max" && !supportsClaudeMaxReasoningEffort(state.model),
          }))
          : state.provider === "pi"
            ? [...PI_REASONING_OPTIONS]
            : state.provider === "grok"
              ? [...GROK_REASONING_OPTIONS]
              : [...getCodexReasoningOptions(state.model, providerConfig?.models)]
      ) as ComposerOptionChoice[],
      selectedId: modelOptions.reasoningEffort,
    }

  const contextWindowOptions = state.provider === "claude"
    ? (selectedModelOption?.contextWindowOptions ?? [])
    : []
  const contextWindow = contextWindowOptions.length > 1
    ? {
      options: contextWindowOptions.map((option) => ({ ...option }) as ComposerOptionChoice),
      selectedId: modelOptions.contextWindow ?? CLAUDE_CONTEXT_WINDOW_OPTIONS[0].id,
    }
    : null

  const fastMode = selectedModelOption?.supportsFastMode
    ? { enabled: Boolean(modelOptions.fastMode) }
    : null

  const modeOptions: ChatMode[] = providerConfig?.supportsAutoPlanMode
    ? ["full-access", "plan", "auto-plan"]
    : ["full-access", "plan"]
  // A composer state seeded from another harness can carry autoPlan into a
  // provider that has no Auto Plan (see getEffectiveComposerState), so clamp
  // the selection to what this provider actually offers.
  const selectedMode = chatModeFromFlags(state.planMode, state.autoPlan)
  const mode = providerConfig?.supportsPlanMode
    ? {
      selected: modeOptions.includes(selectedMode) ? selectedMode : "full-access" as ChatMode,
      options: modeOptions,
    }
    : null

  return { reasoning, contextWindow, fastMode, mode }
}
