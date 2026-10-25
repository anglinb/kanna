// The sign-in cards the setup wizard draws (components/auth/AuthCard.tsx in
// its SetupList rows, and on its own), every header action and every phase
// of a sign-in, and the Setup card that opens the wizard
// (gallery/setup-cards.ts on the Foldkit side).
import { useState } from "react"
import type { KannaSocket } from "../../../client/app/socket"
import { AuthCard } from "../../../client/components/auth/AuthCard"
import { SetupList } from "../../../client/components/auth/MacSetupStep"
import { SetupCard } from "../../../client/components/auth/SetupCard"
import { useProviderAuthStore } from "../../../client/stores/providerAuthStore"
import { HEADER_STATES, LOGIN_STATES, SETUP_CARD_SNAPSHOT } from "../../gallery-support/setup-states"

/** Nothing here reaches a server: a sign-in started in the gallery goes nowhere. */
const socket = { command: () => new Promise(() => {}) } as unknown as KannaSocket

const key = (service: { service: string; accountId?: string }) => `${service.service}-${service.accountId ?? ""}`

export default function SetupCardsGallery() {
  // Once, as the page opens. Not at import: every gallery module is imported
  // by the app's entry.
  useState(() => {
    useProviderAuthStore.setState({ snapshot: SETUP_CARD_SNAPSHOT, setupLoaded: true })
    return null
  })
  return (
    <div className="min-h-dvh bg-background p-6 text-foreground">
      <div className="grid grid-cols-[400px_400px_400px] items-start justify-center gap-6">
        <SetupList>
          {HEADER_STATES.map((service) => <AuthCard row key={key(service)} service={service} socket={socket} />)}
        </SetupList>
        <SetupList>
          {LOGIN_STATES.map((service) => <AuthCard row key={key(service)} service={service} socket={socket} />)}
        </SetupList>
        <div className="space-y-3">
          <SetupCard />
          <AuthCard service={HEADER_STATES[2]!} socket={socket} />
          <AuthCard service={LOGIN_STATES[2]!} socket={socket} />
          <AuthCard service={LOGIN_STATES[4]!} socket={socket} />
        </div>
      </div>
    </div>
  )
}
