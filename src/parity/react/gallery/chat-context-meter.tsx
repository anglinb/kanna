// src/client/components/chat-ui/ContextWindowMeter.tsx in the states the
// composer shows it: a share of a known window, a small share, no window
// (tokens only), and past full (gallery/chat-context-meter.ts on the Foldkit
// side). Inside the one TooltipProvider the app wraps everything in.
import { ContextWindowMeter } from "../../../client/components/chat-ui/ContextWindowMeter"
import { TooltipProvider } from "../../../client/components/ui/tooltip"
import type { ContextWindowSnapshot } from "../../../client/lib/contextWindow"
import { CONTEXT_METER_USAGES } from "../../gallery-support/context-meter-usages"

export default function ChatContextMeterGallery() {
  return (
    <TooltipProvider>
      <div className="flex min-h-dvh flex-col items-start gap-6 bg-background p-10 pt-24 text-foreground">
        {CONTEXT_METER_USAGES.map((usage: ContextWindowSnapshot, index) => (
          <div key={index} className="flex items-center gap-3">
            <ContextWindowMeter usage={usage} />
            <span className="text-sm">Meter {index + 1}</span>
          </div>
        ))}
      </div>
    </TooltipProvider>
  )
}
