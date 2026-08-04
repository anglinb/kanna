import { Folder, MessageCircle, Settings2 } from "lucide-react"
import { InputPopover, PopoverMenuItem } from "../ChatPreferenceControls"

/** Which view the sidebar shows when the recent-chats Labs mode is enabled. */
export type SidebarView = "recents" | "projects"

/**
 * One row's text: the view's name with what it's grouped by trailing it inline
 * — two rows in a picker this small read better on one line each.
 *
 * Same treatment as `PopoverMenuItem`'s own `description` subtitle. The weight
 * has to be stated: unlike that slot, this sits *inside* the label, so it would
 * otherwise inherit its medium weight and read as part of the name.
 */
function ViewLabel({ name, grouping }: { name: string; grouping: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span>{name}</span>
      <span className="text-xs font-normal text-muted-foreground">grouped by {grouping}</span>
    </span>
  )
}

/**
 * Swaps the sidebar between its Chats and Projects views.
 *
 * Rides in the first section header of the Chats view rather than in a row of
 * its own: a permanent segmented control spent a full row on a switch that gets
 * flipped rarely. The Projects view has no section header to host it (project
 * headers already carry their own actions), so it uses the "All Chats" button
 * above New Chat instead.
 */
export function SidebarViewSwitcher({
  view,
  onChange,
}: {
  view: SidebarView
  onChange: (view: SidebarView) => void
}) {
  return (
    // Section headers toggle their bucket on click; the popover isn't a toggle.
    <span onClick={(event) => event.stopPropagation()}>
      <InputPopover
        // Panel hangs off the button's left edge — centering a 16rem panel on a
        // 22px button in the sidebar's right gutter would overhang the window.
        align="start"
        // Geometry and hover match the neighbouring "…" ghost icon button.
        triggerClassName="h-5.5 w-5.5 justify-center rounded border border-border/0 p-0 hover:border-border hover:bg-accent dark:hover:bg-card"
        trigger={<Settings2 className="size-3.5 text-slate-500 dark:text-slate-400" />}
      >
        {(close) => (
          <>
            <PopoverMenuItem
              onClick={() => {
                close()
                onChange("recents")
              }}
              selected={view === "recents"}
              icon={<MessageCircle className="h-4 w-4" />}
              label={<ViewLabel name="Chats" grouping="relevance" />}
            />
            <PopoverMenuItem
              onClick={() => {
                close()
                onChange("projects")
              }}
              selected={view === "projects"}
              icon={<Folder className="h-4 w-4" />}
              label={<ViewLabel name="Projects" grouping="recency" />}
            />
          </>
        )}
      </InputPopover>
    </span>
  )
}
