// The whole setup wizard as Kanna for Mac shows it, with its This Mac step
// first (components/auth/SetupWizard.tsx; gallery/setup-mac-wizard.ts on the
// Foldkit side). A stand-in for the app answers the step's switches.
import { useState } from "react"
import type { KannaSocket } from "../../../client/app/socket"
import { SetupWizard } from "../../../client/components/auth/SetupWizard"
import { useMacSetupStore } from "../../../client/lib/macApp"
import { useProviderAuthStore } from "../../../client/stores/providerAuthStore"
import { installFakeMacApp, MAC_WIZARD_SNAPSHOT, MAC_WIZARD_START } from "../../gallery-support/setup-states"

/** Nothing here reaches a server: a sign-in started in the gallery goes nowhere. */
const socket = { command: () => new Promise(() => {}) } as unknown as KannaSocket

export default function SetupMacWizardGallery() {
  // Once, before the wizard mounts and asks whether it runs in the Mac app.
  useState(() => {
    installFakeMacApp(MAC_WIZARD_START)
    useMacSetupStore.setState({ state: MAC_WIZARD_START })
    useProviderAuthStore.setState({ snapshot: MAC_WIZARD_SNAPSHOT, socket, setupWizardOpen: true, setupLoaded: true, setupShown: true })
    return null
  })
  return <SetupWizard />
}
