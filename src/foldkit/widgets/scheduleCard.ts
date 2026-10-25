import { Schema } from "effect"
import { Command, Submodel, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { cn } from "../../client/lib/utils"
import type { ChatSchedule } from "../../shared/types"
import { formatScheduleState, TRIGGER_ICON } from "../transcript/messages/schedule-tool"
import { TOOL_CARD_CAPTION_CLASS, toolCardClasses } from "../transcript/messages/tool-card-classes"
import * as ContextMenu from "../ui/context-menu"
import { Pencil } from "../ui/icons"
import { applyHover, Hovered, HoverMessage, listHoverAttributes, listHoverCard, SyncHoverTracker } from "./hoverCard"
import { scheduleCard } from "./schedules"

/**
 * The live schedule card the transcript shows where an agent set a schedule
 * (messages/ScheduleToolMessage.tsx's ScheduleCardBox): the Schedules
 * widget's row in a card, with the widget's right-click menu (Edit
 * Schedule…) and hover card (its message, where it goes, its runs, Edit).
 *
 * A Submodel the transcript embeds per card, from its References'
 * `renderScheduleCard`:
 *
 *   Model:    scheduleCards: Record<string, ScheduleCard.Model>
 *             (ScheduleCard.init(key) for a card not seen yet; key: the row's id)
 *   Message:  GotScheduleCardMessage: { key, message: ScheduleCard.Message }
 *   update:   ScheduleCard.update(model.scheduleCards[key], message) →
 *             OutMessage RequestedEdit { scheduleId }  → the composer's prefill
 *                          (the chat page's handleEditSchedule: scheduleEditPrompt)
 *             OutMessage RequestedOpenChat { chatId }  → open the chat
 *                          (chat/chatReference.ts openChatActions)
 *   view:     renderScheduleCard: (card) => h.submodel({
 *               slotId: `schedule-card-${key}`, model, view: ScheduleCard.view,
 *               viewInputs: { key, card, currentChatId, now, chatTitle, canOpenChats },
 *               toParentMessage: (message) => GotScheduleCardMessage({ key, message }) })
 *
 * `now` is the host's minute clock (useMinuteClock's 20s while the schedule
 * is on), as the transcript's rows already tick it.
 */

export const Model = Schema.Struct({
  key: Schema.String,
  menu: ContextMenu.Model,
  hovered: Hovered,
})
export type Model = typeof Model.Type

export function init(key: string): Model {
  return { key, menu: ContextMenu.init({ id: `schedule-card-${key}` }), hovered: {} }
}

export const Message = defineMessageUnion({
  GotMenuMessage: { message: ContextMenu.Message },
  // The list hover card's own Messages (hoverCard.ts's HoverMessage), as this card's.
  ChangedHoveredRow: { list: Schema.String, key: Schema.NullOr(Schema.String) },
  CompletedSyncHoverTracker: {},
  ClickedEdit: { scheduleId: Schema.String },
  ClickedRunChat: { chatId: Schema.String },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  RequestedEdit: { scheduleId: Schema.String },
  RequestedOpenChat: { chatId: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

const listOf = (key: string) => `schedule-card:${key}`

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

export function update(model: Model, message: Message): Return {
  return Message.match<Return>(message, {
    GotMenuMessage: ({ message: child }) => {
      const step = ContextMenu.update(model.menu, child)
      const commands = (step.commands ?? []).map((command) => Command.mapMessage(command, (inner: ContextMenu.Message) => Message.GotMenuMessage({ message: inner })))
      const next = modifyFields(model, { menu: () => step.model })
      if (step.outMessage?._tag === "Selected") {
        return { model: next, commands, outMessage: OutMessage.RequestedEdit({ scheduleId: step.outMessage.value }) }
      }
      return { model: next, commands }
    },
    ChangedHoveredRow: ({ list, key }) => ({ model: modifyFields(model, { hovered: (hovered) => applyHover(hovered, list, key) }) }),
    CompletedSyncHoverTracker: () => ({ model }),
    // The card goes first: the composer is where the eye should land.
    ClickedEdit: ({ scheduleId }) => ({
      model,
      commands: [Command.mapMessage(SyncHoverTracker({ list: listOf(model.key), action: "dismiss" }), toHover)],
      outMessage: OutMessage.RequestedEdit({ scheduleId }),
    }),
    ClickedRunChat: ({ chatId }) => ({ model, outMessage: OutMessage.RequestedOpenChat({ chatId }) }),
  })
}

export interface ViewInputs {
  card: { schedule: ChatSchedule; caption: string; quote: boolean }
  currentChatId: string | null
  now: number
  chatTitle: (chatId: string) => string | undefined
  canOpenChats: boolean
}

/** The hover card's Messages are this card's own (the same tags and fields). */
const toHover = (message: HoverMessage): Message => message

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
  const { schedule, caption, quote } = inputs.card
  const on = schedule.enabled && schedule.nextRunAt != null
  const icon = TRIGGER_ICON[schedule.trigger.kind]
  const classes = toolCardClasses(quote)
  const list = listOf(model.key)
  return h.submodel({
    slotId: `schedule-card-menu-${model.key}`,
    model: model.menu,
    view: ContextMenu.view,
    viewInputs: {
      items: [ContextMenu.item({ value: schedule.id })],
      renderItem: () => [Pencil({ class: "size-3.5" }, h), h.span([], ["Edit Schedule…"])],
      toView: ({ trigger, portal }) => h.div([h.Class(classes.width), ...listHoverAttributes(list, toHover, h)], [
        h.div([
          ...trigger,
          // What the hover card finds the card under the pointer by.
          h.DataAttribute("row-key", schedule.id),
          h.Class(cn(classes.box, classes.lit, "select-none")),
        ], [
          h.div([h.Class("flex min-w-0 items-center gap-2.5")], [
            icon({ class: "size-4 shrink-0 text-muted-foreground" }, h),
            h.span([h.Class(cn("min-w-0 shrink truncate", !on && "text-muted-foreground"))], [schedule.name]),
            h.span([h.Class("ml-auto shrink-0 pl-3 text-xs tabular-nums text-muted-foreground")], [formatScheduleState(schedule, inputs.now)]),
          ]),
          h.p([h.Class(TOOL_CARD_CAPTION_CLASS)], [caption]),
          portal,
        ]),
        model.hovered[list] === schedule.id
          ? listHoverCard({ list, rowKey: schedule.id, toMessage: toHover, side: "bottom", sideOffset: 6 }, scheduleCard(schedule, {
            currentChatId: inputs.currentChatId,
            now: inputs.now,
            chatTitle: inputs.chatTitle,
            ...(inputs.canOpenChats ? { onOpenChat: (chatId: string) => Message.ClickedRunChat({ chatId }) } : {}),
            onEdit: Message.ClickedEdit({ scheduleId: schedule.id }),
          }, h), h)
          : null,
      ]),
    },
    toParentMessage: (message) => Message.GotMenuMessage({ message }),
  })
})

