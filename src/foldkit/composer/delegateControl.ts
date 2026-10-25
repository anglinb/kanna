import type { Html, HtmlBuilder } from "foldkit/html"
import { Compass as CompassNode } from "lucide"
import { delegatedAttentionCount, delegatorDisplayTitle } from "../../client/lib/delegators"
import type { SidebarData } from "../../shared/types"
import { defineIcon } from "../ui/icon"
import * as Icons from "../ui/icons"
import type * as Popover from "../ui/popover"
import type { ComposerDelegate } from "./context"
import { Message } from "./message"
import { inputPopover, popoverMenuItem } from "./preferenceControls"

// DelegateControl.tsx: the first option under the new chat page's input,
// whether this message starts a chat or goes to a delegator, and to which.
//
// Off, it reads "Delegate" and looks like the options beside it. On, it
// names the delegator in the brand colour: the one option in the row that
// changes where the message goes, and so the one that must not be missed.
// Its menu holds the project's delegators, the way to stop delegating, and
// the way to make a new one.

/** The delegator's mark (delegator-icon.tsx): Lucide's compass, unaltered. */
export const DelegatorIcon = defineIcon("compass", CompassNode)

/** How many chats are under a delegator and how many want you (DelegatorMenuItem's summary). */
export function delegatorSummary(data: SidebarData, delegatorChatId: string): string {
  let chats = 0
  let wanting = 0
  for (const group of data.projectGroups) {
    for (const chat of group.chats) if (chat.parentChatId === delegatorChatId) chats += 1
    wanting += delegatedAttentionCount(group.chats, delegatorChatId)
  }
  if (chats === 0) return "No chats yet"
  const total = `${chats} ${chats === 1 ? "chat" : "chats"}`
  return wanting > 0 ? `${total}, ${wanting} ${wanting === 1 ? "wants" : "want"} you` : total
}

export function delegateControl(options: {
  delegate: ComposerDelegate
  sidebar: SidebarData
  popover: Popover.Model
}, h: HtmlBuilder<Message>): Html {
  const { delegate, sidebar } = options
  const target = delegate.target
  return inputPopover({
    popover: options.popover,
    slotId: "delegate",
    toParentMessage: (message) => Message.GotPopoverMessage({ name: "delegate", message }),
    trigger: [
      DelegatorIcon({ class: "h-3.5 w-3.5" }, h),
      h.span([h.Class("max-w-[16ch] truncate")], [target ? delegatorDisplayTitle(target.title) : "Delegate"]),
    ],
    ...(target ? { triggerClassName: "text-logo" } : {}),
    content: () => [
      ...delegate.delegators.map((delegator) => popoverMenuItem({
        key: delegator.chatId,
        onClick: Message.PickedDelegator({ chatId: delegator.chatId }),
        selected: false,
        icon: DelegatorIcon({ class: "h-4 w-4 text-muted-foreground" }, h),
        label: [delegatorDisplayTitle(delegator.title)],
        description: delegatorSummary(sidebar, delegator.chatId),
        ...(delegator.chatId === target?.chatId ? { trailing: Icons.Check({ class: "h-3.5 w-3.5 shrink-0 text-muted-foreground" }, h) } : {}),
      }, h)),
      popoverMenuItem({
        key: "dont-delegate",
        onClick: Message.PickedDelegator({ chatId: null }),
        selected: false,
        icon: Icons.SquarePen({ class: "h-4 w-4 text-muted-foreground" }, h),
        label: ["Don't Delegate"],
        description: `Start a new chat in ${delegate.projectName}`,
        ...(target ? {} : { trailing: Icons.Check({ class: "h-3.5 w-3.5 shrink-0 text-muted-foreground" }, h) }),
      }, h),
      popoverMenuItem({
        key: "new-delegator",
        onClick: Message.ClickedNewDelegator(),
        selected: false,
        icon: Icons.Plus({ class: "h-4 w-4 text-muted-foreground" }, h),
        label: ["New Delegator…"],
        description: "A chat that hands work to the chats under it",
      }, h),
    ],
  }, h)
}
