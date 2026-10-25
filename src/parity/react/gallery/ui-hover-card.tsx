// src/client/components/ui/hover-card.tsx (gallery/ui-hover-card.ts on the Foldkit side).
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../../../client/components/ui/hover-card"

export default function HoverCardGallery() {
  return (
    <div className="flex min-h-dvh items-start gap-24 bg-background p-24 text-foreground">
      <HoverCard>
        <HoverCardTrigger asChild>
          <a href="#branch" className="text-sm underline">feat/foldkit-ui</a>
        </HoverCardTrigger>
        <HoverCardContent className="w-72">
          <p className="text-sm font-medium">feat/foldkit-ui</p>
          <p className="text-xs text-muted-foreground">3 commits ahead of main</p>
          <button type="button" className="mt-2 rounded-md border border-border px-2 py-1 text-xs">Open pull request</button>
        </HoverCardContent>
      </HoverCard>
      <HoverCard openDelay={0} closeDelay={0}>
        <HoverCardTrigger asChild>
          <span className="text-sm">Instant</span>
        </HoverCardTrigger>
        <HoverCardContent side="right" align="start" sideOffset={8}>No delay either way</HoverCardContent>
      </HoverCard>
    </div>
  )
}
