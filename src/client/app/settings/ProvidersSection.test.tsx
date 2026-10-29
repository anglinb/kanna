import { afterEach, describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  AUTH_SERVICE_LABELS,
  AUTH_SERVICE_ORDER,
  PROVIDERS,
  type AuthServiceId,
  type AuthServiceSnapshot,
  type LlmProviderSnapshot,
  type ProviderAuthSnapshot,
  type ProviderUsageSnapshot,
} from "../../../shared/types"
import { useProviderAuthStore } from "../../stores/providerAuthStore"
import { configuredProviders, ProvidersSection } from "./ProvidersSection"
import { signedInUsageProviders } from "./UsageSection"

function authSnapshot(statuses: Partial<Record<AuthServiceId, AuthServiceSnapshot["authStatus"]>> = {}): ProviderAuthSnapshot {
  return {
    services: AUTH_SERVICE_ORDER.map((service) => ({
      service,
      label: AUTH_SERVICE_LABELS[service],
      installed: statuses[service] !== "not_installed",
      version: null,
      latestVersion: null,
      updateAvailable: false,
      authStatus: statuses[service] ?? "signed_out",
      account: null,
      statusDetail: null,
      login: { phase: "idle" },
      installState: "idle",
      installError: null,
      checkedAt: null,
    })),
  }
}

const registry: LlmProviderSnapshot = {
  provider: "openai", apiKey: "", model: "test-model", baseUrl: "",
  resolvedBaseUrl: "https://api.openai.com/v1", faveModels: [], enabled: false,
  warning: null, filePathDisplay: "~/.kanna/llm-provider.json",
}

function usage(provider: ProviderUsageSnapshot["provider"], status: ProviderUsageSnapshot["status"] = "ok"): ProviderUsageSnapshot {
  return { provider, status, plan: null, windows: [], credits: null, detail: null, updatedAt: null }
}

const originalAuthSnapshot = useProviderAuthStore.getInitialState().snapshot
afterEach(() => {
  useProviderAuthStore.getInitialState().snapshot = originalAuthSnapshot
})

function renderProviders(auth: ProviderAuthSnapshot | null, llmProvider = registry, focusRowId = "") {
  useProviderAuthStore.getInitialState().snapshot = auth
  return renderToStaticMarkup(<ProvidersSection focusRowId={focusRowId} state={{
    socket: {} as never,
    availableProviders: PROVIDERS,
    llmProvider,
    handleReadLlmProvider: async () => {},
    handleWriteLlmProvider: async () => {},
    handleValidateLlmProvider: async () => ({ ok: true, error: null }),
    handleWriteFaveModels: async () => {},
    handleWriteAppSettings: async () => {},
  }} />)
}

describe("configured provider defaults", () => {
  test("only signed-in agents qualify, including Grok", () => {
    expect(configuredProviders(authSnapshot({
      claude: "signed_in", codex: "signed_out", cursor: "not_installed", grok: "signed_in", gh: "signed_in", openrouter: "signed_in",
    }), registry)).toEqual(["claude", "grok"])
  })

  test("unknown, failed, and outdated probes do not expose unconfigured defaults", () => {
    expect(configuredProviders(authSnapshot({ claude: "unknown", codex: "error", cursor: "outdated" }), registry)).toEqual([])
    expect(configuredProviders(null, null)).toEqual([])
  })

  test("Pi requires an enabled Model Registry, including custom connections", () => {
    expect(configuredProviders(null, { ...registry, provider: "custom", apiKey: "test-key", enabled: true })).toEqual(["pi"])
    expect(configuredProviders(null, { ...registry, apiKey: "test-key", warning: "Invalid endpoint" })).toEqual([])
  })

  test("renders defaults only for connected providers and collapses setup", () => {
    const html = renderProviders(authSnapshot({ claude: "signed_in", codex: "signed_out" }))
    expect(html).toContain('id="claudeDefaults" data-settings-row')
    expect(html).not.toContain('id="codexDefaults" data-settings-row')
    expect(html).not.toContain('id="piDefaults"')
    expect(html).not.toContain('id="modelRegistry"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('id="more-providers" hidden=""')
    expect(html).toContain('id="github"')
  })

  test("enabled registries expose Pi defaults and model editing", () => {
    const html = renderProviders(authSnapshot(), { ...registry, enabled: true, apiKey: "test-key" })
    expect(html).toContain('id="piDefaults" data-settings-row')
    expect(html).toContain('id="defaultModels" data-settings-row')
    expect(html).toContain('id="modelRegistry" data-settings-row')
  })

  test("links to hidden defaults reveal the provider's setup options", () => {
    const html = renderProviders(authSnapshot(), registry, "codexDefaults")
    expect(html).toContain('aria-expanded="true"')
    expect(html).not.toContain('id="more-providers" hidden')
    expect(html).toContain('id="codexDefaults"')
    expect(html).not.toContain("Chat defaults")
  })

  test("links to Pi models reveal registry setup before it is configured", () => {
    const html = renderProviders(authSnapshot(), registry, "defaultModels")
    expect(html).toContain('id="defaultModels"')
    expect(html).toContain('id="modelRegistry" data-settings-row')
    expect(html).not.toContain('id="piDefaults" data-settings-row')
  })

  test("first-time setup keeps sign-in available without irrelevant defaults", () => {
    const html = renderProviders(authSnapshot())
    expect(html).toContain("Connect a provider below")
    expect(html).toContain("Set up more providers")
    expect(html).not.toContain("Chat defaults")
    expect(html).toContain("Log In")
  })
})

describe("usage visibility", () => {
  test("signed-out accounts never show stale usage", () => {
    const snapshots = [usage("claude"), usage("codex"), usage("pi")]
    expect(signedInUsageProviders(snapshots, authSnapshot({ claude: "signed_in" }))).toEqual([snapshots[0]!])
  })

  test("live usage remains visible while auth is unknown or failed", () => {
    const snapshots = [usage("claude"), usage("codex", "unknown")]
    expect(signedInUsageProviders(snapshots, null)).toEqual([snapshots[0]!])
    expect(signedInUsageProviders(snapshots, authSnapshot({ claude: "error", codex: "unknown" }))).toEqual([snapshots[0]!])
  })
})
