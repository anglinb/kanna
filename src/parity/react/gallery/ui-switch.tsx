// src/client/components/ui/switch.tsx (gallery/ui-switch.ts on the Foldkit side).
import { useState } from "react"
import { Switch } from "../../../client/components/ui/switch"

export default function SwitchGallery() {
  const [sounds, setSounds] = useState(false)
  const [updates, setUpdates] = useState(true)
  return (
    <div className="flex flex-col items-start gap-3 bg-background p-4 text-foreground">
      <Switch checked={sounds} onCheckedChange={setSounds} aria-label="Sounds" />
      <Switch checked={updates} onCheckedChange={setUpdates} aria-label="Updates" />
      <Switch checked={false} onCheckedChange={() => {}} disabled aria-label="Disabled off" />
      <Switch checked onCheckedChange={() => {}} disabled aria-label="Disabled on" className="ml-4" />
    </div>
  )
}
