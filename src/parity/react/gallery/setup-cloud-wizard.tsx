// The setup wizard's Kanna Cloud step (components/auth/SetupWizard.tsx with
// CloudPairPanel), opened the way the Mac app's Put This Mac Online… opens
// it; gallery/setup-cloud-wizard.ts on the Foldkit side. A stand-in for the
// machine's pairing endpoint answers.
import { useState } from "react"
import type { KannaSocket } from "../../../client/app/socket"
import { SetupWizard } from "../../../client/components/auth/SetupWizard"
import { useProviderAuthStore } from "../../../client/stores/providerAuthStore"
import { CLOUD_WIZARD_SNAPSHOT, installFakePairSession } from "./support/setup-states"

/** Nothing here reaches a server: a sign-in started in the gallery goes nowhere. */
const socket = { command: () => new Promise(() => {}) } as unknown as KannaSocket

export default function SetupCloudWizardGallery() {
  // Once, before the wizard mounts and asks what the server can do.
  useState(() => {
    installFakePairSession()
    useProviderAuthStore.setState({ snapshot: CLOUD_WIZARD_SNAPSHOT, socket, setupLoaded: true, setupShown: true })
    return null
  })
  return <SetupWizard />
}
