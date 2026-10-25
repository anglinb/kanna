import { describe, expect, test } from "bun:test"
import { Story } from "foldkit/test"
import { CHAT_TABS_STORAGE_KEY } from "../../../client/lib/storageKeys"
import { initialModel, load, Message, SaveChatTabs, update } from "./chatTabs"
import { memoryStorage, run } from "./testing"

const tabs = (...chatIds: string[]) => chatIds.map((chatId) => ({ chatId }))
const open = (chatId: string, afterChatId: string | null = null) => Message.OpenedTab({ chatId, afterChatId })

describe("chat tabs", () => {
  test("loads the tabs the React store kept, skipping what isn't one", () => {
    const storage = memoryStorage({ [CHAT_TABS_STORAGE_KEY]: JSON.stringify([{ chatId: "a" }, { nope: 1 }, "b", { chatId: "c", extra: true }]) })
    expect(load(storage)).toEqual({ tabs: tabs("a", "c"), recentChatIds: [] })
    expect(load(memoryStorage({ [CHAT_TABS_STORAGE_KEY]: "{not json" })).tabs).toEqual([])
    expect(load(memoryStorage()).tabs).toEqual([])
  })

  test("a change is saved; a no-op neither changes the model nor touches storage", () => {
    Story.story(
      update,
      Story.given(initialModel),
      Story.message(open("a")),
      Story.Command.expectExact(SaveChatTabs({ tabs: tabs("a") })),
      Story.Command.resolve(SaveChatTabs, Message.CompletedSave()),
      Story.message(open("a")),
      Story.Command.expectNone(),
    )
  })

  test("opens right of the chat it came from, and closes", () => {
    let model = run(update, initialModel, open("a"), open("b"), open("c", "a"))
    expect(model.tabs).toEqual(tabs("a", "c", "b"))
    model = run(update, model, Message.ClosedTabsToRight({ chatId: "c" }))
    expect(model.tabs).toEqual(tabs("a", "c"))
    model = run(update, model, Message.ClosedOtherTabs({ chatId: "c" }))
    expect(model.tabs).toEqual(tabs("c"))
    model = run(update, model, Message.ClosedTab({ chatId: "c" }))
    expect(model.tabs).toEqual([])
  })

  test("reorders, and prunes to the chats the caller keeps", () => {
    let model = run(update, initialModel, open("a"), open("b"), open("c"), Message.ReorderedTabs({ orderedChatIds: ["c", "a", "b"] }))
    expect(model.tabs).toEqual(tabs("c", "a", "b"))
    model = run(update, model, Message.PrunedTabs({ keepChatIds: ["a", "c"] }))
    expect(model.tabs).toEqual(tabs("c", "a"))
  })

  test("remembers the chats visited, most recent first, without storing them", () => {
    Story.story(
      update,
      Story.given(initialModel),
      Story.message(Message.VisitedChat({ chatId: "a" })),
      Story.message(Message.VisitedChat({ chatId: "b" })),
      Story.message(Message.VisitedChat({ chatId: "a" })),
      Story.Command.expectNone(),
      Story.model((model) => expect(model.recentChatIds).toEqual(["a", "b"])),
    )
  })
})
