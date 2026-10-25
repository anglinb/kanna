// src/client/components/ui/animated-shiny-text.tsx (gallery/ui-animated-shiny-text.ts on the Foldkit side).
import { AnimatedShinyText } from "../../../client/components/ui/animated-shiny-text"

export default function AnimatedShinyTextGallery() {
  return (
    <div className="flex w-80 flex-col items-start gap-3 bg-background p-4 text-foreground">
      <AnimatedShinyText className="!mx-0 text-sm" shimmerWidth={44}>Thinking…</AnimatedShinyText>
      <AnimatedShinyText animate={false}>Read 3 files</AnimatedShinyText>
      <AnimatedShinyText className="!mx-0 min-w-0 shrink truncate" shimmerWidth={60}>
        <span>A label long enough to truncate at the edge of its column</span>
      </AnimatedShinyText>
    </div>
  )
}
