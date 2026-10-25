// src/client/components/ui/turn-card.tsx (gallery/ui-turn-card.ts on the Foldkit side).
import { useState } from "react"
import { TurnCardMessage, TurnCardMetaRow, TurnCardMetaSeparator, TurnCardTimingRow } from "../../../client/components/ui/turn-card"

export default function TurnCardGallery() {
  const [selected, setSelected] = useState("none")
  return (
    <div className="flex flex-col gap-4 bg-background p-4 text-foreground">
      <div className="w-80 rounded-md border border-border bg-card px-1.5 py-1.5">
        <TurnCardMetaRow>
          <span>You</span>
          <TurnCardMetaSeparator />
          <span>Claude</span>
        </TurnCardMetaRow>
        <TurnCardMessage className="line-clamp-2 text-sm" label="Open the prompt" onSelect={() => setSelected("prompt")}>
          Port the shared UI primitives to Foldkit, matching the React DOM exactly so slices can swap them in.
        </TurnCardMessage>
        <TurnCardMessage className="line-clamp-2 text-sm text-muted-foreground" label="Reply">
          Done: buttons, cards and inputs.
        </TurnCardMessage>
        <TurnCardTimingRow detail="2m" timestamp="1h ago" leading={<span>Claude</span>} />
      </div>
      <div className="w-80 rounded-md border border-border bg-card px-1.5 py-1.5">
        <TurnCardTimingRow timestamp="yesterday" />
        <TurnCardTimingRow detail="8 turns" />
        <TurnCardTimingRow />
      </div>
      <p>Selected: {selected}</p>
    </div>
  )
}
