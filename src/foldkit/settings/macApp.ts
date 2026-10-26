import { macSetupAvailable, postToMacApp, type MacQuitBehavior, type MacSetupState } from "../core/macApp"

// The bridge itself is core/macApp.ts; Settings › This Mac sends these.

export type { MacQuitBehavior, MacSetupState }
export { macSetupAvailable }

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
