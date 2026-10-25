import { describe, expect, test } from "bun:test"
import { Story } from "foldkit/test"
import type { ChatAttachment } from "../../../shared/types"
import {
  draftStartTimes,
  getAttachmentDrafts,
  initialModel,
  load,
  Message,
  SaveDrafts,
  STORAGE_NAME,
  update,
  type Model,
} from "./chatInput"
import { memoryStorage, persisted, run } from "./testing"

const attachment = { id: "a", kind: "file", displayName: "a.txt" } as unknown as ChatAttachment

describe("chat input store", () => {
  test("loads what the React store persisted", () => {
    const storage = memoryStorage({
      [STORAGE_NAME]: persisted({
        drafts: { c1: "half a thought" },
        draftStartedAt: { c1: 10 },
        draftTouchedAt: { c1: 20 },
        attachmentDrafts: { c1: [attachment] },
        startedChats: { c1: { projectId: "p", at: 5 } },
      }, 0),
    })
    const model = load(storage)
    expect(model.drafts).toEqual({ c1: "half a thought" })
    expect(model.draftStartedAt).toEqual({ c1: 10 })
    expect(model.draftTouchedAt).toEqual({ c1: 20 })
    expect(model.attachmentDrafts.c1).toEqual([attachment])
    expect(model.startedChats).toEqual({ c1: { projectId: "p", at: 5 } })
  })

  test("a store written before startedChats existed loads with the default", () => {
    const model = load(memoryStorage({ [STORAGE_NAME]: persisted({ drafts: { c1: "x" } }, 0) }))
    expect(model.drafts).toEqual({ c1: "x" })
    expect(model.startedChats).toEqual({})
  })

  test("every change is saved", () => {
    Story.story(
      update,
      Story.given(initialModel),
      Story.message(Message.ChangedDraft({ chatId: "chat-1", value: "h", at: 100 })),
      Story.Command.expectExact(SaveDrafts({
        state: { ...initialModel, drafts: { "chat-1": "h" }, draftStartedAt: { "chat-1": 100 }, draftTouchedAt: { "chat-1": 100 } },
      })),
      Story.Command.resolve(SaveDrafts, Message.CompletedSave()),
    )
  })

  test("a draft is last touched when its text or its attachments last changed, and not once both are gone", () => {
    let model = run(update, initialModel, Message.ChangedDraft({ chatId: "chat-1", value: "typed", at: 100 }))
    expect(model.draftTouchedAt["chat-1"]).toBe(100)

    model = run(
      update,
      model,
      Message.ChangedAttachmentDrafts({ chatId: "chat-1", attachments: [attachment], at: 200 }),
      Message.ChangedDraft({ chatId: "chat-1", value: "", at: 300 }),
    )
    // The attachment is still staged, so there is still a draft.
    expect(model.draftTouchedAt["chat-1"]).toBe(200)
    model = run(update, model, Message.ChangedAttachmentDrafts({ chatId: "chat-1", attachments: [], at: 400 }))
    expect(model.draftTouchedAt["chat-1"]).toBeUndefined()
  })

  test("moving a draft takes all of it to the other chat and leaves nothing behind", () => {
    const before = run(
      update,
      initialModel,
      Message.ChangedDraft({ chatId: "gone", value: "written before lunch", at: 100 }),
      Message.ChangedAttachmentDrafts({ chatId: "gone", attachments: [attachment], at: 200 }),
    )

    const after = run(update, before, Message.MovedDraft({ fromChatId: "gone", toChatId: "fresh" }))

    expect(after.drafts).toEqual({ fresh: "written before lunch" })
    expect(after.attachmentDrafts).toEqual({ fresh: [attachment] })
    expect(after.draftStartedAt).toEqual({ fresh: before.draftStartedAt.gone! })
    expect(after.draftTouchedAt).toEqual({ fresh: before.draftTouchedAt.gone! })
  })

  test("a started chat is remembered while it has a draft or is young enough to get one", () => {
    const day = 24 * 60 * 60 * 1000
    const now = 10 * day
    const given: Model = {
      ...initialModel,
      drafts: { "old-with-draft": "kept" },
      startedChats: {
        "old-with-draft": { projectId: "p", at: now - 3 * day },
        "old-empty": { projectId: "p", at: now - 3 * day },
        "young-empty": { projectId: "p", at: now - 1000 },
      },
    }

    const remembered = run(update, given, Message.RememberedStartedChat({ chatId: "new", projectId: "q", at: now }))

    expect(Object.keys(remembered.startedChats).sort()).toEqual(["new", "old-with-draft", "young-empty"])
    expect(remembered.startedChats.new?.projectId).toBe("q")

    const forgotten = run(update, remembered, Message.ForgotStartedChat({ chatId: "new" }))
    expect(forgotten.startedChats.new).toBeUndefined()
  })

  test("stamps a draft when it appears, and leaves it alone as you keep typing", () => {
    // The sidebar sorts Relevant by this, so it has to hold still mid-sentence
    // — a row that climbs a place per keystroke is unreadable to type beside.
    const started = run(update, initialModel, Message.ChangedDraft({ chatId: "chat-1", value: "h", at: 100 }))
    expect(started.draftStartedAt["chat-1"]).toBe(100)

    const typed = run(update, started, Message.ChangedDraft({ chatId: "chat-1", value: "half a thought", at: 200 }))
    expect(typed.draftStartedAt["chat-1"]).toBe(100)
    expect(typed.draftStartedAt).toBe(started.draftStartedAt)
  })

  test("a draft cleared and started again is a new draft", () => {
    const first = run(update, initialModel, Message.ChangedDraft({ chatId: "chat-1", value: "first", at: 100 }))
    const cleared = run(update, first, Message.ClearedDraft({ chatId: "chat-1" }))
    expect(cleared.draftStartedAt["chat-1"]).toBeUndefined()

    const second = run(update, cleared, Message.ChangedDraft({ chatId: "chat-1", value: "second", at: 200 }))
    expect(second.draftStartedAt["chat-1"]).toBe(200)
  })

  test("emptying a draft drops its stamp too", () => {
    const model = run(
      update,
      initialModel,
      Message.ChangedDraft({ chatId: "chat-1", value: "typed", at: 100 }),
      Message.ChangedDraft({ chatId: "chat-1", value: "", at: 200 }),
    )

    expect(model.drafts["chat-1"]).toBeUndefined()
    expect(model.draftStartedAt["chat-1"]).toBeUndefined()
  })

  test("stores attachment drafts per chat", () => {
    const model = run(update, initialModel, Message.ChangedAttachmentDrafts({
      chatId: "chat-1",
      attachments: [{
        id: "attachment-1",
        kind: "image",
        displayName: "mock.png",
        absolutePath: "/tmp/project/.kanna/uploads/mock.png",
        relativePath: "./.kanna/uploads/mock.png",
        contentUrl: "/api/projects/project-1/uploads/mock.png/content",
        mimeType: "image/png",
        size: 512,
      }],
      at: 100,
    }))

    expect(getAttachmentDrafts(model, "chat-1")).toHaveLength(1)
    expect(getAttachmentDrafts(model, "chat-2")).toEqual([])
  })

  test("clears attachment drafts for a chat", () => {
    const model = run(
      update,
      initialModel,
      Message.ChangedAttachmentDrafts({
        chatId: "chat-1",
        attachments: [{
          id: "attachment-1",
          kind: "file",
          displayName: "spec.pdf",
          absolutePath: "/tmp/project/.kanna/uploads/spec.pdf",
          relativePath: "./.kanna/uploads/spec.pdf",
          contentUrl: "/api/projects/project-1/uploads/spec.pdf/content",
          mimeType: "application/pdf",
          size: 1234,
        }],
        at: 100,
      }),
      Message.ClearedAttachmentDrafts({ chatId: "chat-1" }),
    )
    expect(getAttachmentDrafts(model, "chat-1")).toEqual([])
  })

  test("draft start times keep their identity while you type, and change when a draft appears", () => {
    const started = run(update, initialModel, Message.ChangedDraft({ chatId: "chat-1", value: "h", at: 100 }))
    const times = draftStartTimes(started)
    expect([...times]).toEqual([["chat-1", 100]])

    const typed = run(update, started, Message.ChangedDraft({ chatId: "chat-1", value: "hello", at: 200 }))
    expect(draftStartTimes(typed)).toBe(times)

    const another = run(update, typed, Message.ChangedDraft({ chatId: "chat-2", value: " ", at: 300 }))
    // Whitespace alone is not a draft to list.
    expect(draftStartTimes(another)).toBe(times)

    const listed = run(update, another, Message.ChangedDraft({ chatId: "chat-2", value: "x", at: 400 }))
    expect(draftStartTimes(listed)).not.toBe(times)
  })
})
