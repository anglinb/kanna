import { delegatedAttentionCount } from "../../lib/delegators"
import { cn } from "../../lib/utils"
import { useRightSidebarStore } from "../../stores/rightSidebarStore"
import { useSidebarStore } from "../../stores/sidebarStore"
import { openViewer, useViewerStore } from "../../stores/viewerStore"
import { Button } from "../ui/button"
import { DelegatorIcon } from "./delegator-icon"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"

/** The delegator pane's toggle, read once: for the command palette, which shows the same state. */
export function isDelegatedPaneOpen(chatId: string): boolean {
  return Boolean(useRightSidebarStore.getState().chatViewers[chatId])
}

/**
 * Opens a delegator's pane in the viewer, or shuts the pane if it is open.
 * What the navbar's button does, and the command palette's entry.
 */
export function toggleDelegatedPane(chatId: string) {
  if (isDelegatedPaneOpen(chatId)) useViewerStore.getState().shut()
  else openViewer({ kind: "delegated", chatId })
}

/**
 * A delegator's way to its pane, the list of the chats under it: the
 * navbar's button, just left of the widgets toggle, on a delegator and
 * nowhere else. It opens the pane and shuts it again, and counts the chats
 * under the delegator that want the user, pane open or not: waiting on them,
 * or finished and unread.
 *
 * One control at every width. Beside the chat it is a toggle among the
 * navbar's other plain icon buttons, lit while the pane is open as the
 * widgets toggle is, and the count is what asks for attention. On a phone
 * (`overlay`) there is no pane: the list opens over the transcript, which
 * covers this bar, so the button only ever opens it. There it is in the
 * brand colour, as the mark of what the page is, since the list it stands
 * for is out of sight until asked for.
 */
export function DelegatedListButton({ chatId, overlay }: { chatId: string; overlay: boolean }) {
  // A number, so the button re-renders when the count moves and not for
  // every push of the sidebar.
  const count = useSidebarStore((state) => {
    let total = 0
    for (const group of state.data.projectGroups) total += delegatedAttentionCount(group.chats, chatId)
    return total
  })
  const open = useRightSidebarStore((store) => Boolean(store.chatViewers[chatId]))
  const pressed = open && !overlay
  const action = pressed ? "Hide delegated chats" : "Show delegated chats"
  const label = count > 0 ? `${action}, ${count} ${count === 1 ? "wants" : "want"} you` : action
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="none"
          aria-label={label}
          aria-pressed={overlay ? undefined : pressed}
          onClick={() => (overlay ? openViewer({ kind: "delegated", chatId }) : toggleDelegatedPane(chatId))}
          className={cn(
            // The box of the buttons beside it (see the terminal and widgets toggles).
            "flex h-9 items-center justify-center gap-1 border border-border/0 px-1.5 hover:!border-border/0 hover:!bg-transparent max-md:h-[45px] max-md:min-w-[42px]",
            overlay ? "text-logo hover:text-logo" : pressed && "text-foreground",
          )}
        >
          <DelegatorIcon strokeWidth={2} className="h-4 shrink-0 max-md:h-5 max-md:w-5" />
          {count > 0 ? (
            <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-foreground/10 px-1 text-xs font-bold leading-none text-foreground tabular-nums">
              {count}
            </span>
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{action}</TooltipContent>
    </Tooltip>
  )
}
