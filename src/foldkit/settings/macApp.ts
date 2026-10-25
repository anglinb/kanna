import type { MacQuitBehavior, MacSetupState } from "../../client/lib/macApp"

// The Kanna for Mac bridge from src/client/lib/macApp.ts without its zustand
// store (which would bring React into this bundle): the same checks and
// messages to the app's `kanna` message handler. The live state arrives on
// the `kanna:mac-setup` event (mac.ts listens while This Mac is open).

export type { MacQuitBehavior, MacSetupState }

interface MacAppHandler {
  postMessage: (message: unknown) => void
}

function handler(): MacAppHandler | null {
  if (typeof window === "undefined") return null
  const webkit = (window as { webkit?: { messageHandlers?: { kanna?: MacAppHandler } } }).webkit
  return webkit?.messageHandlers?.kanna ?? null
}

function isMacApp() {
  return handler() !== null
}

function macAppHasFeature(feature: "fleet" | "setup") {
  return isMacApp() && (window.__kannaMacApp?.features ?? []).includes(feature)
}

/**
 * This Mac's own server, not another machine's page opened through the
 * Fleet: the only page that may change this Mac's settings.
 */
function isOnThisMac() {
  if (typeof window === "undefined") return false
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(window.location.hostname)
}

/** The Mac settings (wizard step, Settings › This Mac) apply here and only here. */
export function macSetupAvailable() {
  return macAppHasFeature("setup") && isOnThisMac()
}

function postToMacApp(message: { type: string } & Record<string, unknown>) {
  handler()?.postMessage(message)
}

/** Each one answers with the new state. */
export const macSetup = {
  refresh: () => postToMacApp({ type: "macSetup.refresh" }),
  setLoginItem: (enabled: boolean) => postToMacApp({ type: "macSetup.setLoginItem", enabled }),
  openLoginItems: () => postToMacApp({ type: "macSetup.openLoginItems" }),
  setKeepAwake: (change: { onPower?: boolean; onBattery?: boolean }) =>
    postToMacApp({ type: "macSetup.setKeepAwake", ...change }),
  openFullDiskAccess: () => postToMacApp({ type: "macSetup.openFullDiskAccess" }),
  setQuitBehavior: (value: MacQuitBehavior) => postToMacApp({ type: "macSetup.setQuitBehavior", value }),
}
