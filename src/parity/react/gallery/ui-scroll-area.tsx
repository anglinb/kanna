// src/client/components/ui/scroll-area.tsx (gallery/ui-scroll-area.ts on the Foldkit side).
import { ScrollArea } from "../../../client/components/ui/scroll-area"
import { SCROLL_ROWS } from "../../gallery-support/scroll-rows"

export default function ScrollAreaGallery() {
  return (
    <div className="flex gap-4 bg-background p-4 text-foreground">
      <ScrollArea className="h-40 w-60 rounded-lg border border-border" aria-label="Rows">
        {SCROLL_ROWS.map((row) => (
          <div key={row} className="border-b border-border px-3 py-2 text-sm">{row}</div>
        ))}
      </ScrollArea>
    </div>
  )
}
