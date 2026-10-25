// src/client/components/ui/context-menu.tsx as the sidebar uses it: a row
// that opens a menu of icon items, a separator, a disabled item and one with
// a title (gallery/ui-context-menu.ts on the Foldkit side).
import { useState } from "react"
import { Archive, Pencil, Pin, Trash2 } from "lucide-react"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../../../client/components/ui/context-menu"

export default function ContextMenuGallery() {
  const [last, setLast] = useState("nothing")
  return (
    <div className="flex min-h-dvh flex-col gap-2 bg-background p-6 text-foreground">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="w-80 rounded-md border border-border px-3 py-2 text-sm">Port the shared UI primitives</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setLast("pin")}>
            <Pin className="h-3.5 w-3.5" />
            <span>Pin</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setLast("rename")}>
            <Pencil className="h-3.5 w-3.5" />
            <span>Rename</span>
          </ContextMenuItem>
          <ContextMenuItem disabled onSelect={() => setLast("fork")}>
            <span>Fork</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setLast("delegate")} title="Takes effect on this chat's next turn">
            <span>Delegate</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setLast("archive")}>
            <Archive className="h-3.5 w-3.5" />
            <span>Archive</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setLast("delete")} className="text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
            <span>Delete</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <p className="text-sm">Last: {last}</p>
    </div>
  )
}
