// src/client/components/ui/kbd.tsx (gallery/ui-kbd.ts on the Foldkit side).
import { Kbd, KbdGroup } from "../../../client/components/ui/kbd"

export default function KbdGallery() {
  return (
    <div className="flex flex-col items-start gap-3 bg-background p-4 text-foreground">
      <Kbd>⌘</Kbd>
      <KbdGroup>
        <Kbd>CMD</Kbd>
        <Kbd>SHIFT</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>
      <Kbd className="text-muted-foreground">ESC</Kbd>
    </div>
  )
}
