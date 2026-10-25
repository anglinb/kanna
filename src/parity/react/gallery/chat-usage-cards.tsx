// The usage cards a phone's new chat page shows (EmptyStateUsageCards: each
// a collapsible Settings ProviderCard), in its list's layout
// (gallery/chat-usage-cards.ts on the Foldkit side).
import { ProviderCard } from "../../../client/app/settings/UsageSection"
import { TooltipProvider } from "../../../client/components/ui/tooltip"
import { USAGE_SNAPSHOTS } from "../../gallery-support/usage-snapshots"

export default function ChatUsageCardsGallery() {
  return (
    <TooltipProvider>
      <div className="min-h-dvh bg-background p-6 pt-24 text-foreground">
        <div className="mx-auto w-full max-w-[840px]">
          <div className="w-full space-y-3 text-left">
            {USAGE_SNAPSHOTS.map((provider) => (
              <ProviderCard key={provider.provider} snapshot={provider} collapsible />
            ))}
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
