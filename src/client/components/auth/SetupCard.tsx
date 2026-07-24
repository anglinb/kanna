import { ChevronRight, Flower } from "lucide-react"
import { AUTH_SERVICE_ORDER } from "../../../shared/types"
import { cn } from "../../lib/utils"
import { useProviderAuthStore, useSetupStatus, useShowSetupCard, selectAuthService } from "../../stores/providerAuthStore"
import { AUTH_SERVICE_ICONS } from "../provider-icons"

/**
 * Compact "finish setup" entry point shown on the home page and new-chat empty
 * state until the setup wizard has been completed. Connected services render
 * bright, missing ones muted. Clicking opens the full-screen wizard.
 */
export function SetupCard({ className }: { className?: string }) {
  const show = useShowSetupCard()
  const status = useSetupStatus()
  const snapshot = useProviderAuthStore((store) => store.snapshot)
  const openSetupWizard = useProviderAuthStore((store) => store.openSetupWizard)
  if (!show) return null

  const subtitle = !status.anyAgentConnected
    ? "Connect your coding agents to start building."
    : "Connect the rest of your accounts."

  return (
    <button
      type="button"
      onClick={openSetupWizard}
      className={cn(
        "group w-full rounded-2xl border border-border bg-card/40 px-3.5 py-3 text-left transition-colors hover:border-primary/30 hover:bg-muted/40",
        className
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Flower className="h-4 w-4 shrink-0 text-logo" />
          <span className="truncate text-sm font-semibold text-foreground">Set up Kanna</span>
        </div>
        <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border px-2.5 py-1 text-xs font-semibold text-foreground transition-colors group-hover:bg-muted">
          Setup
          <ChevronRight className="h-3.5 w-3.5 -mr-0.5" />
        </span>
      </div>
      <div className="mt-2.5 flex items-center gap-3">
        <div className="flex items-center gap-2.5">
          {AUTH_SERVICE_ORDER.map((id) => {
            const Icon = AUTH_SERVICE_ICONS[id]
            const connected = selectAuthService(snapshot, id)?.authStatus === "signed_in"
            return (
              <Icon
                key={id}
                className={cn("h-4 w-4", connected ? "text-foreground" : "text-muted-foreground/40")}
              />
            )
          })}
        </div>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{subtitle}</span>
      </div>
    </button>
  )
}
