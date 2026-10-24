// Every lucide icon the client uses, as lucide-react draws it, against
// src/foldkit/ui/icons.ts (gallery/icons.ts on the Foldkit side).
import * as Lucide from "lucide-react"
import type { ComponentType } from "react"
import * as FoldkitIcons from "../../../foldkit/ui/icons"

const names = Object.keys(FoldkitIcons).sort()

export default function Icons() {
  return (
    <div className="flex flex-wrap gap-2 bg-background p-4 text-foreground">
      {names.map((name) => {
        const Icon = (Lucide as unknown as Record<string, ComponentType<{ className?: string; strokeWidth?: number; "aria-label"?: string }>>)[name]!
        return (
          <span key={name} title={name} className="inline-flex">
            <Icon className="size-5" />
            <Icon className="h-3 w-3 text-muted-foreground" strokeWidth={1.5} aria-label={name} />
          </span>
        )
      })}
    </div>
  )
}
