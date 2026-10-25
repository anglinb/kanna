// src/client/components/ui/tooltip.tsx: each side, an edge that flips, the
// default delay, the hotkey variant and a still one (gallery/ui-tooltip.ts on
// the Foldkit side). The app wraps everything in one TooltipProvider; so does
// this page.
import {
  HotkeyTooltip,
  HotkeyTooltipContent,
  HotkeyTooltipTrigger,
  StillTooltips,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../../client/components/ui/tooltip"
import { Button } from "../../../client/components/ui/button"

const triggerClass = "rounded-md border border-border px-3 py-1.5 text-sm"

export default function TooltipGallery() {
  return (
    <TooltipProvider>
      <div className="relative min-h-dvh bg-background text-foreground">
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <button type="button" className={`${triggerClass} absolute left-4 top-1`}>Edge</button>
          </TooltipTrigger>
          <TooltipContent>Flips below at the top edge</TooltipContent>
        </Tooltip>
        <div className="flex flex-wrap items-center gap-16 p-24">
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <button type="button" className={triggerClass}>Top</button>
            </TooltipTrigger>
            <TooltipContent>Above by default</TooltipContent>
          </Tooltip>
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <button type="button" className={triggerClass}>Right</button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={4}>/Users/kanna/projects/foldkit</TooltipContent>
          </Tooltip>
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Fetch">Bottom</Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Fetched 2m ago</TooltipContent>
          </Tooltip>
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <button type="button" className={triggerClass}>Left</button>
            </TooltipTrigger>
            <TooltipContent side="left" align="start">Left, start-aligned</TooltipContent>
          </Tooltip>
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2 pr-1">Usage</div>
            </TooltipTrigger>
            <TooltipContent side="top" align="center">
              <div>5-hour window</div>
              <div className="text-muted-foreground">Resets in 2h</div>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className={triggerClass}>Delayed</button>
            </TooltipTrigger>
            <TooltipContent>After the provider's delay</TooltipContent>
          </Tooltip>
          <HotkeyTooltip>
            <HotkeyTooltipTrigger asChild>
              <button type="button" className={triggerClass}>Terminal</button>
            </HotkeyTooltipTrigger>
            <HotkeyTooltipContent side="bottom" shortcut="cmd+j" />
          </HotkeyTooltip>
          <HotkeyTooltip delayDuration={0}>
            <HotkeyTooltipTrigger asChild>
              <button type="button" className={triggerClass}>Label</button>
            </HotkeyTooltipTrigger>
            <HotkeyTooltipContent side="bottom">Open in editor</HotkeyTooltipContent>
          </HotkeyTooltip>
          <StillTooltips>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <button type="button" className={triggerClass}>Still</button>
              </TooltipTrigger>
              <TooltipContent side="right">No motion</TooltipContent>
            </Tooltip>
          </StillTooltips>
        </div>
      </div>
    </TooltipProvider>
  )
}
