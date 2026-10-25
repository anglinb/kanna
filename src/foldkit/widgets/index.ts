import { Submodel } from "foldkit"
import type { ChatPageSliceInputs } from "../chat/pageInputs"
import { Message } from "./message"
import { init, Model } from "./model"
import { update } from "./update"
import { view as columnView } from "./view"

// The chat page's right sidebar: the widget column's content
// (components/chat-ui/widgets/*, git/* but DiffViewer). Embedded by chat/,
// which draws the column itself (chat/widgetsColumn.ts) and hands this its
// page (`ChatPageSliceInputs`).
//
//   model.ts, message.ts   the column's state and Messages
//   update.ts              what they do (useChatPageSidebarActions' calls included)
//   commands.ts            its server commands and timers
//   subscriptions.ts       the ports poll and the clock
//   view.ts                WidgetsSidebar; one file per widget:
//     git.ts, branchPicker.ts, gitDialogs.ts, cards.ts, gitParts.ts, gitLogic.ts
//     tasks.ts, workflow.ts, schedules.ts, attachments.ts, ports.ts,
//     quickActions.ts, usage.ts
//   parts.ts               WidgetCard.tsx and parts.tsx (generic over the host's Message)
//   hoverCard.ts           WidgetHoverCard over the app's list hover card
//   menus.ts               the column's one right-click menu
//   scheduleCard.ts        the live schedule card the transcript shows

export { init, Message, Model, update }
export { subscriptions } from "./subscriptions"

export const view = Submodel.defineView<Model, Message, ChatPageSliceInputs>((model, inputs, h) => columnView(model, inputs, h))
