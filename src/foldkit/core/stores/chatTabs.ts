import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import {
  closeChatTab,
  closeChatTabsToRight,
  closeOtherChatTabs,
  MAX_CHAT_TABS,
  openChatTab,
  pruneChatTabs,
  reorderChatTabs,
  type ChatTab,
} from "../../../client/lib/chat-tabs"
import { CHAT_TABS_STORAGE_KEY } from "../../../client/lib/storageKeys"
import { readStorageItem, writeStorageItem } from "../storage"

// Port of src/client/stores/chatTabsStore.ts.

/**
 * The chat tabs, kept in this browser: they are how one
 * window is arranged, not something another device should inherit. The rules
 * are in `lib/chat-tabs`.
 */

const ChatTabSchema = Schema.Struct({ chatId: Schema.String })

export const Model = Schema.Struct({
  tabs: Schema.Array(ChatTabSchema),
  /**
   * The chats you have been on, most recent first: what closing the open tab
   * goes back to. This page's memory only, not stored: after a reload there
   * is no "before" yet.
   *
   * Here and not in the tab bar, which does not live long enough to hold it:
   * the chat page rebuilds its navbar whenever the open chat's project
   * changes, and a history kept in the bar was lost on exactly the switches
   * it was for.
   */
  recentChatIds: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

export const initialModel: Model = { tabs: [], recentChatIds: [] }

export function load(storage?: Storage): Model {
  return { tabs: readStoredTabs(storage), recentChatIds: [] }
}

function readStoredTabs(storage?: Storage): ChatTab[] {
  try {
    const parsed: unknown = JSON.parse(readStorageItem(CHAT_TABS_STORAGE_KEY, storage) ?? "[]")
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => (
      item && typeof item === "object" && typeof (item as ChatTab).chatId === "string"
        ? [{ chatId: (item as ChatTab).chatId }]
        : []
    ))
  } catch {
    return []
  }
}

export const Message = defineMessageUnion({
  VisitedChat: { chatId: Schema.String },
  OpenedTab: { chatId: Schema.String, afterChatId: Schema.NullOr(Schema.String) },
  ClosedTab: { chatId: Schema.String },
  ClosedOtherTabs: { chatId: Schema.String },
  ClosedTabsToRight: { chatId: Schema.String },
  ReorderedTabs: { orderedChatIds: Schema.Array(Schema.String) },
  /**
   * The React action took a predicate; a Message carries data, so the caller
   * runs its predicate over the tabs and sends the ids to keep.
   */
  PrunedTabs: { keepChatIds: Schema.Array(Schema.String) },
  CompletedSave: {},
})
export type Message = typeof Message.Type

export const SaveChatTabs = Command.define("SaveChatTabs", {
  args: { tabs: Schema.Array(ChatTabSchema) },
  messages: [Message.CompletedSave],
  execute: ({ tabs }) => writeStorageItem(CHAT_TABS_STORAGE_KEY, JSON.stringify(tabs)).pipe(Effect.as(Message.CompletedSave())),
})

// Every change goes through here: unchanged tabs (the rules hand back the
// same array) neither re-render anything nor touch storage.
function changeTabs(model: Model, change: (tabs: readonly ChatTab[]) => readonly ChatTab[]): Update.Return<Model, Message> {
  const tabs = change(model.tabs)
  if (tabs === model.tabs) return { model }
  return { model: modifyFields(model, { tabs: () => tabs }), commands: [SaveChatTabs({ tabs })] }
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    VisitedChat: ({ chatId }) => ({
      model: model.recentChatIds[0] === chatId
        ? model
        : modifyFields(model, {
          recentChatIds: (recent) => [chatId, ...recent.filter((id) => id !== chatId)].slice(0, MAX_CHAT_TABS),
        }),
    }),
    OpenedTab: ({ chatId, afterChatId }) => changeTabs(model, (tabs) => openChatTab(tabs, chatId, afterChatId)),
    // closeChatTab always hands back a new array, so this writes even for a
    // chat with no tab, as the store did (its check was by identity).
    ClosedTab: ({ chatId }) => changeTabs(model, (tabs) => closeChatTab(tabs, chatId)),
    ClosedOtherTabs: ({ chatId }) => changeTabs(model, (tabs) => closeOtherChatTabs(tabs, chatId)),
    ClosedTabsToRight: ({ chatId }) => changeTabs(model, (tabs) => closeChatTabsToRight(tabs, chatId)),
    ReorderedTabs: ({ orderedChatIds }) => changeTabs(model, (tabs) => reorderChatTabs(tabs, orderedChatIds)),
    PrunedTabs: ({ keepChatIds }) => {
      const keep = new Set(keepChatIds)
      return changeTabs(model, (tabs) => pruneChatTabs(tabs, (chatId) => keep.has(chatId)))
    },
    CompletedSave: () => ({ model }),
  })
