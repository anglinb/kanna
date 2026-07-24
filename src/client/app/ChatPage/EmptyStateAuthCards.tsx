import { SetupCard } from "../../components/auth/SetupCard"

/**
 * New-chat empty state onboarding entry: a single Setup card (opens the
 * full-screen setup wizard) shown until the wizard has been completed.
 * Signed-in claude/codex usage renders separately via EmptyStateUsageCards.
 */
export function EmptyStateAuthCards() {
  return <SetupCard />
}
