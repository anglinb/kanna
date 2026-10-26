// The Kanna for Mac bridge (src/client/lib/macApp.ts without its zustand
// store, which would bring React in). The app talks to the page through the
// `kanna` message handler one way and `window.__kanna*` globals the other
// (macos/src/preload.ts, window.ts). The handler keeps the WebKit name from
// the WKWebView the app used to be, so pages of any version find it.
//
// The app and this page ship separately (the app's own updates vs npm), so
// the page checks `window.__kannaMacApp.features` before it shows anything
// that needs the app, and an app older than the feature simply doesn't get
// it. The live setup state arrives on the `kanna:mac-setup` event.

interface MacAppHandler {
  postMessage: (message: unknown) => void
}

export type MacAppFeature = "fleet" | "setup"

/** The live state behind the setup wizard's This Mac step (macos/src/mac-setup.ts). */
export interface MacSetupState {
  loginItem: "enabled" | "requiresApproval" | "off"
  keepAwakeOnPower: boolean
  keepAwakeOnBattery: boolean
  pluggedIn: boolean
  lidClosingSleeps: boolean | null
  fileVault: boolean | null
  fullDiskAccess: boolean
  /** What quitting the app does to its server (macos/src/quit.ts). Missing
   *  from apps before 2.1. */
  quitBehavior?: MacQuitBehavior
}

export type MacQuitBehavior = "ask" | "keepOnline" | "goOffline"

declare global {
  interface Window {
    __kannaMacApp?: { version?: string; features?: string[] }
    __kannaMacSetup?: MacSetupState
    __kannaOpenSetup?: (step?: string) => void
  }
}

function handler(): MacAppHandler | null {
  if (typeof window === "undefined") return null
  const webkit = (window as { webkit?: { messageHandlers?: { kanna?: MacAppHandler } } }).webkit
  return webkit?.messageHandlers?.kanna ?? null
}

export function isMacApp() {
  return handler() !== null
}

export function macAppHasFeature(feature: MacAppFeature) {
  return isMacApp() && (window.__kannaMacApp?.features ?? []).includes(feature)
}

/**
 * This Mac's own server, not another machine's page opened through the
 * Fleet: the only page that may change this Mac's settings. The app checks
 * the same thing on its side.
 */
export function isOnThisMac() {
  if (typeof window === "undefined") return false
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(window.location.hostname)
}

/** The Mac settings (wizard step, Settings › This Mac) apply here and only here. */
export function macSetupAvailable() {
  return macAppHasFeature("setup") && isOnThisMac()
}

export function postToMacApp(message: { type: string } & Record<string, unknown>) {
  handler()?.postMessage(message)
}

/** The state the app put on the page at load, before any `kanna:mac-setup` event. */
export function initialMacSetupState(): MacSetupState | null {
  return typeof window !== "undefined" ? window.__kannaMacSetup ?? null : null
}
