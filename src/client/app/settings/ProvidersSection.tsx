import { useEffect, useState } from "react"
import { ChevronDown, History, Loader2 } from "lucide-react"
import {
  authServiceForProvider,
  chatModeFromFlags,
  chatModeToFlags,
  DEFAULT_OPENAI_SDK_MODEL,
  DEFAULT_OPENROUTER_SDK_MODEL,
  PROVIDERS,
  type AgentProvider,
  type ChatMode,
  type LlmProviderKind,
  type LlmProviderSnapshot,
  type ProviderAuthSnapshot,
} from "../../../shared/types"
import { AuthCard } from "../../components/auth/AuthCard"
import { ChatPreferenceControls } from "../../components/chat-ui/ChatPreferenceControls"
import { DefaultModelsDialog } from "../../components/DefaultModelsDialog"
import { PROVIDER_ICONS } from "../../components/provider-icons"
import { Button } from "../../components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogTitle } from "../../components/ui/dialog"
import { Input } from "../../components/ui/input"
import { SelectItem } from "../../components/ui/select"
import { applyModelToComposerState } from "../../lib/composer"
import { cn } from "../../lib/utils"
import { useChatPreferencesStore, type ComposerState } from "../../stores/chatPreferencesStore"
import { selectAuthService, useProviderAuthStore } from "../../stores/providerAuthStore"
import type { KannaState } from "../useKannaState"
import {
  handleSettingsInputKeyDown,
  SETTINGS_CONTROL_CLASS,
  SettingsActionButton,
  SettingsErrorBanner,
  SettingsGroup,
  SettingsGroups,
  SettingsNotice,
  SettingsRow,
  SettingsSelect,
} from "./shared"
import { SETTINGS_ROWS } from "./registry"
import { planLabel, signedInUsageProviders, UsageWindowRows, useUsageLimits } from "./UsageSection"

function ProviderLogo({ provider }: { provider: AgentProvider }) {
  const Icon = PROVIDER_ICONS[provider]
  return <Icon className="h-4 w-4 shrink-0" />
}

const QUICK_RESPONSE_PROVIDER_OPTIONS: Array<{ value: LlmProviderKind; label: string }> = [
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "custom", label: "Custom" },
]

/** Only configured connections get chat defaults; installing a CLI alone is not enough. */
export function configuredProviders(auth: ProviderAuthSnapshot | null, registry: LlmProviderSnapshot | null): AgentProvider[] {
  return PROVIDERS.filter(({ id }) => {
    if (id === "pi") return registry?.enabled === true
    const service = authServiceForProvider(id)
    return service !== null && selectAuthService(auth, service)?.authStatus === "signed_in"
  }).map(({ id }) => id)
}

export function ProvidersSection({
  state,
  focusRowId = "",
}: {
  focusRowId?: string
  state: Pick<
    KannaState,
    | "socket"
    | "availableProviders"
    | "llmProvider"
    | "handleReadLlmProvider"
    | "handleWriteLlmProvider"
    | "handleValidateLlmProvider"
    | "handleWriteFaveModels"
    | "handleWriteAppSettings"
  >
}) {
  const llmProvider = state.llmProvider
  const handleReadLlmProvider = state.handleReadLlmProvider
  const handleWriteLlmProvider = state.handleWriteLlmProvider
  const handleValidateLlmProvider = state.handleValidateLlmProvider
  const handleWriteAppSettings = state.handleWriteAppSettings

  const providerAuthSnapshot = useProviderAuthStore((store) => store.snapshot)
  const { snapshot: usageSnapshot, refreshing, refresh } = useUsageLimits(state.socket)
  const configured = configuredProviders(providerAuthSnapshot, llmProvider)
  const usageProviders = usageSnapshot ? signedInUsageProviders(usageSnapshot.providers, providerAuthSnapshot) : []
  const [showMoreProviders, setShowMoreProviders] = useState(() => PROVIDERS.some(({ id }) => `${id}Defaults` === focusRowId))
  const [showRegistry, setShowRegistry] = useState(() => ["modelRegistry", "defaultModels", "piDefaults"].includes(focusRowId))
  const registryVisible = showRegistry || llmProvider?.enabled || Boolean(llmProvider?.apiKey) || Boolean(llmProvider?.warning)
  const otherServices = providerAuthSnapshot?.services.filter((service) =>
    service.service !== "gh" && service.authStatus !== "signed_in",
  ) ?? []
  const github = selectAuthService(providerAuthSnapshot, "gh")

  useEffect(() => {
    if (["modelRegistry", "defaultModels", "piDefaults"].includes(focusRowId)) setShowRegistry(true)
    if (PROVIDERS.some(({ id }) => `${id}Defaults` === focusRowId)) setShowMoreProviders(true)
  }, [focusRowId])

  const defaultProvider = useChatPreferencesStore((store) => store.defaultProvider)
  const providerDefaults = useChatPreferencesStore((store) => store.providerDefaults)
  const setDefaultProvider = useChatPreferencesStore((store) => store.setDefaultProvider)
  const setProviderDefaultModel = useChatPreferencesStore((store) => store.setProviderDefaultModel)
  const setProviderDefaultModelOptions = useChatPreferencesStore((store) => store.setProviderDefaultModelOptions)
  const setProviderDefaultMode = useChatPreferencesStore((store) => store.setProviderDefaultMode)

  const [providersError, setProvidersError] = useState<string | null>(null)
  const [llmProviderDraft, setLlmProviderDraft] = useState({
    provider: "openai" as LlmProviderKind,
    apiKey: "",
    model: "",
    baseUrl: "",
  })
  const [llmProviderError, setLlmProviderError] = useState<string | null>(null)
  const [llmValidationStatus, setLlmValidationStatus] = useState<"idle" | "valid" | "invalid">("idle")
  const [llmValidationError, setLlmValidationError] = useState<unknown | null>(null)
  const [llmValidationDialogOpen, setLlmValidationDialogOpen] = useState(false)
  const [defaultModelsDialogOpen, setDefaultModelsDialogOpen] = useState(false)

  // The section only mounts while its tab is selected and the socket is
  // connected, so a plain mount effect matches the old page-gated read.
  useEffect(() => {
    void handleReadLlmProvider()
  }, [handleReadLlmProvider])

  useEffect(() => {
    if (!llmProvider) return
    setLlmProviderDraft({
      provider: llmProvider.provider,
      apiKey: llmProvider.apiKey,
      model: llmProvider.model,
      baseUrl: llmProvider.baseUrl,
    })
  }, [llmProvider])

  useEffect(() => {
    setLlmValidationStatus("idle")
    setLlmValidationError(null)
  }, [llmProviderDraft.provider, llmProviderDraft.apiKey, llmProviderDraft.model, llmProviderDraft.baseUrl])

  function handleDefaultProviderChange(nextValue: "last_used" | AgentProvider) {
    setDefaultProvider(nextValue)
    void handleWriteAppSettings({ defaultProvider: nextValue }).catch((error) => {
      setProvidersError(error instanceof Error ? error.message : "Unable to save provider settings.")
    })
  }

  function handleProviderDefaultModelChange(provider: AgentProvider, model: string) {
    // The step the chat composer takes when a model is picked: options that
    // depend on the model are checked against the live catalog entry, so a
    // Codex effort the new model does not offer moves to one it does. The
    // store's own normalizer knows only the static list, which has no row for
    // a model the account gained at runtime.
    const next = applyModelToComposerState(
      { provider, ...providerDefaults[provider] } as ComposerState,
      model,
      state.availableProviders.find((entry) => entry.id === provider),
    )
    setProviderDefaultModel(provider, next.model)
    setProviderDefaultModelOptions(provider, next.modelOptions)
    void handleWriteAppSettings({
      providerDefaults: { [provider]: { model: next.model, modelOptions: next.modelOptions } },
    }).catch((error) => {
      setProvidersError(error instanceof Error ? error.message : "Unable to save provider settings.")
    })
  }

  function handleProviderDefaultModelOptionsChange(
    provider: AgentProvider,
    modelOptions: Partial<typeof providerDefaults[typeof provider]["modelOptions"]>
  ) {
    setProviderDefaultModelOptions(provider, modelOptions)
    void handleWriteAppSettings({ providerDefaults: { [provider]: { modelOptions } } }).catch((error) => {
      setProvidersError(error instanceof Error ? error.message : "Unable to save provider settings.")
    })
  }

  function handleProviderDefaultModeChange(provider: AgentProvider, mode: ChatMode) {
    setProviderDefaultMode(provider, mode)
    const flags = chatModeToFlags(mode, providerDefaults[provider].autoPlan)
    void handleWriteAppSettings({ providerDefaults: { [provider]: flags } }).catch((error) => {
      setProvidersError(error instanceof Error ? error.message : "Unable to save provider settings.")
    })
  }

  async function commitLlmProvider(nextValue = llmProviderDraft) {
    try {
      setLlmProviderError(null)
      await handleWriteLlmProvider(nextValue)
      const validation = await handleValidateLlmProvider(nextValue)
      setLlmValidationStatus(validation.ok ? "valid" : "invalid")
      setLlmValidationError(validation.error)
    } catch (error) {
      const fallbackError = error instanceof Error
        ? { name: error.name, message: error.message }
        : error
      setLlmValidationStatus("invalid")
      setLlmValidationError(fallbackError)
      setLlmProviderError(error instanceof Error ? error.message : "Unable to save Model Registry settings.")
    }
  }

  function handleLlmProviderSelection(nextProvider: LlmProviderKind) {
    const nextDraft = {
      ...llmProviderDraft,
      provider: nextProvider,
      model: nextProvider === "openai"
        ? DEFAULT_OPENAI_SDK_MODEL
        : nextProvider === "openrouter"
          ? DEFAULT_OPENROUTER_SDK_MODEL
          : llmProviderDraft.model,
      baseUrl: nextProvider === "custom" ? llmProviderDraft.baseUrl : "",
    }
    setLlmProviderDraft(nextDraft)
    void commitLlmProvider(nextDraft)
  }

  const llmValidationErrorText = llmValidationError ? JSON.stringify(llmValidationError, null, 2) : ""
  // No subtitle, only the result of checking the credentials once there is one.
  const llmValidationDescription = llmValidationStatus === "valid" ? (
    <span className="font-medium text-emerald-600 dark:text-emerald-400">Credentials valid & saved</span>
  ) : llmValidationStatus === "invalid" ? (
    <span className="font-medium text-destructive">
      Credentials invalid.
      {llmValidationError ? (
        <>
          {" "}
          <button
            type="button"
            onClick={() => setLlmValidationDialogOpen(true)}
            className="underline underline-offset-2 transition-colors hover:opacity-70"
          >
            See error
          </button>
        </>
      ) : null}
    </span>
  ) : null

  function renderDefaults(provider: AgentProvider) {
    const defaults = providerDefaults[provider]
    return (
      <SettingsRow def={SETTINGS_ROWS[`${provider}Defaults`]} title="Chat defaults" description={null} wideControl>
        <ChatPreferenceControls
          availableProviders={state.availableProviders}
          selectedProvider={provider}
          showProviderPicker={false}
          providerLocked
          model={defaults.model}
          modelOptions={defaults.modelOptions}
          onModelChange={(_, model) => handleProviderDefaultModelChange(provider, model)}
          onModelOptionChange={(change) => {
            if (change.type === "contextWindow") {
              handleProviderDefaultModelOptionsChange(provider, { contextWindow: change.contextWindow })
            } else if (change.type === "fastMode") {
              handleProviderDefaultModelOptionsChange(provider, { fastMode: change.fastMode })
            } else {
              handleProviderDefaultModelOptionsChange(provider, { reasoningEffort: change.effort })
            }
          }}
          onEditModels={provider === "pi" ? () => setDefaultModelsDialogOpen(true) : undefined}
          mode={chatModeFromFlags(defaults.planMode, defaults.autoPlan)}
          onModeChange={(mode) => handleProviderDefaultModeChange(provider, mode)}
          includeMode={provider === "claude" || provider === "codex" || provider === "grok"}
          className="justify-start flex-wrap"
        />
      </SettingsRow>
    )
  }

  return (
    <>
      {providersError ? <SettingsErrorBanner message={providersError} /> : null}
      <SettingsGroups>
        <SettingsGroup>
          <SettingsRow def={SETTINGS_ROWS.defaultProvider} description={null}>
            <SettingsSelect
              aria-label="Default provider"
              value={defaultProvider}
              onValueChange={(value) => handleDefaultProviderChange(value as "last_used" | AgentProvider)}
            >
              <SelectItem value="last_used">
                <span className="flex items-center gap-2"><History className="size-4 shrink-0" />Last Used</span>
              </SelectItem>
              {PROVIDERS.filter(({ id }) => configured.includes(id) || id === defaultProvider).map((provider) => (
                <SelectItem key={provider.id} value={provider.id} disabled={!configured.includes(provider.id)}>
                  <span className="flex items-center gap-2">
                    <ProviderLogo provider={provider.id} />
                    {provider.label}{!configured.includes(provider.id) ? " (not connected)" : ""}
                  </span>
                </SelectItem>
              ))}
            </SettingsSelect>
          </SettingsRow>
        </SettingsGroup>

        <div id={SETTINGS_ROWS.usageLimits.id} className="flex scroll-mt-4 flex-col gap-8">
          {!providerAuthSnapshot ? (
            <div className="flex items-center gap-3 px-4 text-sm text-muted-foreground" role="status">
              <Loader2 className="size-4 shrink-0 animate-spin" />Checking provider sign-in status…
            </div>
          ) : null}
          {PROVIDERS.filter(({ id }) => id !== "pi" && configured.includes(id)).map((provider) => {
            const serviceId = authServiceForProvider(provider.id)
            const service = serviceId ? selectAuthService(providerAuthSnapshot, serviceId) : null
            if (!service) return null
            const usage = usageProviders.find((entry) => entry.provider === provider.id)
            const plan = usage ? planLabel(usage) : ""
            return (
              <SettingsGroup key={provider.id}>
                <AuthCard row textActions service={service} socket={state.socket} detail={
                  plan ? <span className="hidden min-w-0 truncate text-xs capitalize text-muted-foreground @lg:inline">{plan}</span> : null
                } />
                {service.account ? <div className="break-all px-4 py-2 text-xs text-muted-foreground">{service.account}</div> : null}
                {usage ? (
                  <div className="flex flex-col gap-3 px-4 py-3">
                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span>Usage limits</span>
                      <SettingsActionButton disabled={refreshing} onClick={() => void refresh(true)} className="h-7">
                        {refreshing ? "Refreshing…" : "Refresh"}
                      </SettingsActionButton>
                    </div>
                    {usage.windows.length || usage.credits || usage.detail ? (
                      <UsageWindowRows snapshot={usage} />
                    ) : <div className="text-xs text-muted-foreground">Usage limits are not available.</div>}
                  </div>
                ) : null}
                {renderDefaults(provider.id)}
              </SettingsGroup>
            )
          })}
          {providerAuthSnapshot && configured.length === 0 ? (
            <div className="px-4 text-sm text-muted-foreground">Connect a provider below to start chatting. Its usage and defaults will appear here.</div>
          ) : null}
        </div>

        {otherServices.length > 0 || !registryVisible ? (
          <section>
            <SettingsActionButton aria-expanded={showMoreProviders} aria-controls="more-providers" onClick={() => setShowMoreProviders(!showMoreProviders)} className="px-4" icon={<ChevronDown className={cn("transition-transform", showMoreProviders && "rotate-180")} />}>
              {showMoreProviders ? "Hide setup options" : "Set up more providers"}
            </SettingsActionButton>
            <div id="more-providers" hidden={!showMoreProviders} className="mt-2">
              <SettingsGroup>
                {otherServices.map((service) => (
                  <div key={service.service} id={service.service !== "openrouter" && service.service !== "gh" ? SETTINGS_ROWS[`${service.service}Defaults`].id : undefined}>
                    <AuthCard row textActions service={service} socket={state.socket} />
                  </div>
                ))}
                {!registryVisible ? (
                  <SettingsRow title="Model Registry" description="Connect OpenAI, OpenRouter, or a custom endpoint for Pi and quick responses.">
                    <SettingsActionButton onClick={() => setShowRegistry(true)}>Set up</SettingsActionButton>
                  </SettingsRow>
                ) : null}
              </SettingsGroup>
            </div>
          </section>
        ) : null}

        {registryVisible ? (
          <div id={!configured.includes("pi") && ["piDefaults", "defaultModels"].includes(focusRowId) ? focusRowId : undefined} className="scroll-mt-4">
            <SettingsGroup title="Model Registry" trailing={
              !llmProvider?.enabled && !llmProvider?.apiKey && !llmProvider?.warning ? (
                <SettingsActionButton onClick={() => setShowRegistry(false)}>Hide</SettingsActionButton>
              ) : undefined
            }>
              {llmProviderError || llmProvider?.warning ? (
                <div className="space-y-3 p-4">
                  {llmProviderError ? <SettingsNotice>{llmProviderError}</SettingsNotice> : null}
                  {llmProvider?.warning ? <SettingsNotice tone="warning">{llmProvider.warning}</SettingsNotice> : null}
                </div>
              ) : null}
              {/* Provider, endpoint, key and model each get a titled row, as in
                  iOS Settings: with no field frames, a stack of bare inputs in
                  one row left nothing to say which was which once filled. */}
              <SettingsRow def={SETTINGS_ROWS.modelRegistry} description={llmValidationDescription}>
                <SettingsSelect
                  value={llmProviderDraft.provider}
                  onValueChange={(value) => handleLlmProviderSelection(value as LlmProviderKind)}
                >
                  {QUICK_RESPONSE_PROVIDER_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SettingsSelect>
              </SettingsRow>
              {llmProviderDraft.provider === "custom" ? (
                <SettingsRow nested wideControl title="Base URL">
                  <Input
                    value={llmProviderDraft.baseUrl}
                    onChange={(event) => setLlmProviderDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                    onBlur={() => void commitLlmProvider()}
                    onKeyDown={(event) => handleSettingsInputKeyDown(event, () => void commitLlmProvider())}
                    placeholder="https://your-provider.example/v1"
                    spellCheck={false}
                    autoComplete="off"
                    className={cn(SETTINGS_CONTROL_CLASS, "font-mono")}
                  />
                </SettingsRow>
              ) : null}
              <SettingsRow nested wideControl title="API Key">
                <Input
                  type="password"
                  value={llmProviderDraft.apiKey}
                  onChange={(event) => setLlmProviderDraft((current) => ({ ...current, apiKey: event.target.value }))}
                  onBlur={() => void commitLlmProvider()}
                  onKeyDown={(event) => handleSettingsInputKeyDown(event, () => void commitLlmProvider())}
                  placeholder="Required"
                  autoComplete="off"
                  className={cn(SETTINGS_CONTROL_CLASS, "font-mono")}
                />
              </SettingsRow>
              <SettingsRow
                nested
                wideControl
                title="Quick Response Model"
              >
                <Input
                  value={llmProviderDraft.model}
                  onChange={(event) => setLlmProviderDraft((current) => ({ ...current, model: event.target.value }))}
                  onBlur={() => void commitLlmProvider()}
                  onKeyDown={(event) => handleSettingsInputKeyDown(event, () => void commitLlmProvider())}
                  placeholder="Model id"
                  spellCheck={false}
                  autoComplete="off"
                  className={cn(SETTINGS_CONTROL_CLASS, "font-mono")}
                />
              </SettingsRow>

              {configured.includes("pi") ? renderDefaults("pi") : null}
              {configured.includes("pi") ? (
                <SettingsRow def={SETTINGS_ROWS.defaultModels} description={null}>
                  <SettingsActionButton onClick={() => setDefaultModelsDialogOpen(true)}>
                    Edit models
                  </SettingsActionButton>
                </SettingsRow>
              ) : null}
            </SettingsGroup>
          </div>
        ) : null}

        {github ? (
          <div id={SETTINGS_ROWS.github.id} className="scroll-mt-4">
            <SettingsGroup title="GitHub">
              <AuthCard row textActions service={github} socket={state.socket} />
            </SettingsGroup>
          </div>
        ) : null}
      </SettingsGroups>
      <Dialog open={llmValidationDialogOpen} onOpenChange={setLlmValidationDialogOpen}>
        <DialogContent size="lg">
          <DialogBody className="space-y-4">
            <DialogTitle>Validation Error</DialogTitle>
            <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-muted p-3 text-xs font-mono whitespace-pre-wrap break-words">
              {llmValidationErrorText}
            </pre>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={() => setLlmValidationDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DefaultModelsDialog
        open={defaultModelsDialogOpen}
        onOpenChange={setDefaultModelsDialogOpen}
        faveModels={llmProvider?.faveModels ?? []}
        onSave={(faveModels) => {
          void state.handleWriteFaveModels(faveModels).catch((error) => {
            setLlmProviderError(error instanceof Error ? error.message : "Unable to save Model Registry settings.")
          })
        }}
      />
    </>
  )
}
