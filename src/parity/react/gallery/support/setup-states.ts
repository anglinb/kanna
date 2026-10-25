// Sign-in states for the setup galleries (setup-cards, setup-mac-wizard), shared
// by the React and Foldkit pages so both draw the same data. Plain data and
// one browser helper: no React here.
import type { MacSetupState } from "../../../../client/lib/macApp"
import { AUTH_SERVICE_LABELS, type AuthServiceId, type AuthServiceSnapshot, type ProviderAuthSnapshot } from "../../../../shared/types"

const STARTED_AT = Date.UTC(2026, 5, 1, 11, 58)

export function authService(id: AuthServiceId, overrides: Partial<AuthServiceSnapshot> = {}): AuthServiceSnapshot {
  return {
    service: id,
    label: AUTH_SERVICE_LABELS[id],
    installed: true,
    version: null,
    latestVersion: null,
    updateAvailable: false,
    authStatus: "signed_out",
    account: null,
    statusDetail: null,
    login: { phase: "idle" },
    installState: "idle",
    installError: null,
    checkedAt: STARTED_AT,
    ...overrides,
  }
}

/** Every header action an AuthCard can show, one card each. */
export const HEADER_STATES: AuthServiceSnapshot[] = [
  authService("claude", { authStatus: "signed_in", version: "2.1.218", account: "you@example.com" }),
  authService("codex", { authStatus: "signed_in", version: "0.48.0", latestVersion: "0.50.0", updateAvailable: true }),
  authService("cursor", { version: "2026.05.28-1a2b3c4" }),
  authService("gh", { authStatus: "unknown" }),
  authService("openrouter"),
  authService("grok", { installed: false, authStatus: "not_installed" }),
  authService("grok", { accountId: "installing", installed: false, authStatus: "not_installed", installState: "installing" }),
  authService("claude", { accountId: "outdated", authStatus: "outdated", version: "1.0.3", latestVersion: "2.1.218", statusDetail: "This version can't report its sign-in state." }),
  authService("codex", { accountId: "error", authStatus: "error", version: "0.12.0", statusDetail: "codex exited with code 1." }),
  authService("cursor", { accountId: "install-error", installed: false, authStatus: "not_installed", installState: "error", installError: "The installer couldn't reach cursor.com." }),
]

/** Every phase of a sign-in flow, drawn under the card's header. */
export const LOGIN_STATES: AuthServiceSnapshot[] = [
  authService("claude", { login: { phase: "starting" } }),
  authService("codex", { login: { phase: "finishing" } }),
  authService("gh", {
    login: { phase: "waiting_for_approval", verificationUrl: "https://github.com/login/device", userCode: "ABCD-1234", startedAt: STARTED_AT, expiresAt: null },
  }),
  authService("cursor", {
    login: { phase: "waiting_for_approval", verificationUrl: "https://cursor.com/loginDeepControl?challenge=x", userCode: null, startedAt: STARTED_AT, expiresAt: null },
  }),
  authService("claude", {
    accountId: "code-entry",
    login: { phase: "waiting_for_code_entry", verificationUrl: "https://claude.ai/oauth/authorize?code=true", startedAt: STARTED_AT },
  }),
  authService("openrouter", { login: { phase: "error", message: "The sign-in timed out.", hint: "Open the link again and approve within ten minutes." } }),
]

/** What the Setup card reads: some services in, some not. */
export const SETUP_CARD_SNAPSHOT: ProviderAuthSnapshot = {
  services: [
    authService("claude", { authStatus: "signed_in" }),
    authService("codex"),
    authService("cursor", { authStatus: "signed_in" }),
    authService("grok", { installed: false, authStatus: "not_installed" }),
    authService("gh"),
    authService("openrouter"),
  ],
}

/** The This Mac step's states, from the app's first answer to everything done. */
export const MAC_STATES: Array<MacSetupState | null> = [
  null,
  { loginItem: "requiresApproval", keepAwakeOnPower: false, keepAwakeOnBattery: false, pluggedIn: true, lidClosingSleeps: true, fileVault: true, fullDiskAccess: false },
  { loginItem: "off", keepAwakeOnPower: true, keepAwakeOnBattery: false, pluggedIn: true, lidClosingSleeps: false, fileVault: false, fullDiskAccess: false },
  { loginItem: "enabled", keepAwakeOnPower: true, keepAwakeOnBattery: true, pluggedIn: false, lidClosingSleeps: false, fileVault: true, fullDiskAccess: true },
]

/** The wizard over a Mac with nothing set up: GitHub out, one agent in, OpenRouter out. */
export const MAC_WIZARD_SNAPSHOT: ProviderAuthSnapshot = {
  services: [
    authService("claude", { authStatus: "signed_in", version: "2.1.218" }),
    authService("codex", { version: "0.50.0" }),
    authService("cursor", { installed: false, authStatus: "not_installed" }),
    authService("grok", { installed: false, authStatus: "not_installed" }),
    authService("gh", { version: "2.74.0" }),
    authService("openrouter"),
  ],
}

export const MAC_WIZARD_START: MacSetupState = {
  loginItem: "off",
  keepAwakeOnPower: false,
  keepAwakeOnBattery: false,
  pluggedIn: true,
  lidClosingSleeps: false,
  fileVault: true,
  fullDiskAccess: false,
}

/**
 * Stands in for Kanna for Mac (macos/src/mac-setup.ts): the `kanna` message
 * handler, the features it offers and the state it put on the page. It
 * answers each request with the new state on `kanna:mac-setup`, as the app
 * does. Call before the page draws anything.
 */
export function installFakeMacApp(start: MacSetupState) {
  let state = { ...start }
  const answer = () => window.dispatchEvent(new CustomEvent("kanna:mac-setup", { detail: { ...state } }))
  const kanna = {
    postMessage(message: { type: string; enabled?: boolean; onPower?: boolean; onBattery?: boolean }) {
      switch (message.type) {
        case "macSetup.setLoginItem": state = { ...state, loginItem: message.enabled ? "enabled" : "off" }; break
        case "macSetup.setKeepAwake": state = {
          ...state,
          ...(message.onPower !== undefined ? { keepAwakeOnPower: message.onPower } : {}),
          ...(message.onBattery !== undefined ? { keepAwakeOnBattery: message.onBattery } : {}),
        }; break
        case "macSetup.openFullDiskAccess": state = { ...state, fullDiskAccess: true }; break
        case "macSetup.refresh": break
        default: return
      }
      answer()
    },
  }
  const page = window as unknown as {
    webkit?: { messageHandlers?: Record<string, unknown> }
    __kannaMacApp?: { version?: string; features?: string[] }
    __kannaMacSetup?: MacSetupState
  }
  page.webkit = { messageHandlers: { ...(page.webkit?.messageHandlers ?? {}), kanna } }
  page.__kannaMacApp = { version: "2.1.0", features: ["fleet", "setup"] }
  page.__kannaMacSetup = { ...state }
}

/** Everything signed in: the cloud wizard opens past the sign-ins. */
export const CLOUD_WIZARD_SNAPSHOT: ProviderAuthSnapshot = {
  services: [
    authService("claude", { authStatus: "signed_in", version: "2.1.218" }),
    authService("codex", { authStatus: "signed_in", version: "0.50.0" }),
    authService("cursor", { installed: false, authStatus: "not_installed" }),
    authService("grok", { installed: false, authStatus: "not_installed" }),
    authService("gh", { authStatus: "signed_in", version: "2.74.0" }),
    authService("openrouter", { authStatus: "signed_in" }),
  ],
}

export const CLAIM_URL = "https://kanna.sh/machine?pair=TIDE-4821"
export const PAIRED_ORIGIN = "https://tidepool-mac.kanna.sh"

/**
 * Stands in for this machine's pairing endpoint (server/cloud/pair-session.ts)
 * and its capabilities: no session until the page starts one, then a claim
 * outstanding until `window.__setupGalleryPair()` says the browser finished it.
 */
export function installFakePairSession() {
  type Session = { status: string; claimUrl?: string; expiresAt?: number; appOrigin?: string }
  let session: Session = { status: "idle" }
  const original = window.fetch.bind(window)
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }))
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const pathname = new URL(url, window.location.href).pathname
    if (pathname === "/api/capabilities") return json({ capabilities: { cloud: true, publicSharing: true } })
    if (pathname === "/api/cloud/pair-session") {
      if (init?.method === "POST" && session.status === "idle") {
        session = { status: "waiting", claimUrl: CLAIM_URL, expiresAt: Date.UTC(2026, 5, 1, 12, 15) }
      }
      return json(session)
    }
    return original(input, init)
  }) as typeof fetch
  ;(window as unknown as { __setupGalleryPair?: () => void }).__setupGalleryPair = () => {
    session = { status: "paired", appOrigin: PAIRED_ORIGIN }
  }
}
