import { describe, expect, test } from "bun:test"
import type { ChatSnapshot, TranscriptEntry } from "../../shared/types"
import * as ChatSession from "./chatSession"

const input = { windowSize: 50, sidebarStatus: null }

function snapshot(chatId: string, messages: TranscriptEntry[], status = "idle"): ChatSnapshot {
  return {
    runtime: { chatId, projectId: "p1", localPath: "/p", title: "Chat", status, provider: "claude", planMode: false, sessionToken: null } as unknown as ChatSnapshot["runtime"],
    messages,
    startIndex: 0,
    queuedMessages: [],
    availableProviders: [],
    outline: [],
    readAnchor: null,
  } as unknown as ChatSnapshot
}

const prompt = (id: string, content: string): TranscriptEntry => ({ _id: id, kind: "user_prompt", content, attachments: [], createdAt: 1 } as unknown as TranscriptEntry)

function open(chatId = "c1") {
  const started = ChatSession.init(chatId, { windowSize: 50, starting: false })
  return ChatSession.update(started.model, ChatSession.Message.ResolvedCache({ window: null, remembered: null, timedOut: false }), input).model
}

describe("chat session", () => {
  test("opening with no cache waits for the snapshot, then is ready", () => {
    const opened = open()
    expect(opened.cacheResolved).toBe(true)
    expect(opened.subscribeSpan).toBeNull()
    expect(ChatSession.readAnchorState(opened).resolved).toBe(false)
    const received = ChatSession.update(opened, ChatSession.Message.ReceivedSnapshot({ snapshot: snapshot("c1", [prompt("e1", "hi")]) }), input)
    expect(received.model.chatReady).toBe(true)
    expect(received.model.messages).toHaveLength(1)
    expect(ChatSession.readAnchorState(received.model).confirmed).toBe(true)
    expect(received.outMessage).toEqual(ChatSession.OutMessage.ChangedCommandError({ message: null }))
  })

  test("a sent prompt shows at once and is replaced by the server's copy", () => {
    const ready = ChatSession.update(open(), ChatSession.Message.ReceivedSnapshot({ snapshot: snapshot("c1", []) }), input).model
    const submitted = ChatSession.update(ready, ChatSession.Message.SubmittedMessage({ content: "ship it", options: {} }), input)
    expect(submitted.commands?.[0]?.name).toBe("PrepareSend")
    const prepared = ChatSession.update(ready, ChatSession.Message.PreparedSend({ content: "ship it", options: {}, optimisticId: "o1", sentAt: 5 }), input)
    expect(prepared.model.messages).toHaveLength(1)
    expect(ChatSession.runtimeStatus(prepared.model, null)).toBe("starting")
    expect(prepared.outMessage).toEqual(ChatSession.OutMessage.MarkedSending({ chatId: "c1", sentAt: 5 }))
    expect(prepared.commands?.[0]?.name).toBe("ChatSend")

    const acked = ChatSession.update(prepared.model, ChatSession.Message.SucceededChatSend({ optimisticId: "o1" }), input)
    expect(ChatSession.runtimeStatus(acked.model, null)).toBe("starting")
    // The first push after the ack answers: here it is running, with the prompt.
    const pushed = ChatSession.update(acked.model, ChatSession.Message.ReceivedSnapshot({ snapshot: snapshot("c1", [prompt("e1", "ship it")], "running") }), input)
    expect(pushed.model.optimisticPrompts).toHaveLength(0)
    expect(pushed.model.messages).toHaveLength(1)
    expect(ChatSession.runtimeStatus(pushed.model, null)).toBe("running")
  })

  test("a failed send takes the optimistic prompt back and hands the draft back", () => {
    const ready = ChatSession.update(open(), ChatSession.Message.ReceivedSnapshot({ snapshot: snapshot("c1", []) }), input).model
    const prepared = ChatSession.update(ready, ChatSession.Message.PreparedSend({ content: "x", options: {}, optimisticId: "o1", sentAt: 5 }), input).model
    const failed = ChatSession.update(prepared, ChatSession.Message.FailedChatSend({ optimisticId: "o1", content: "x", error: "boom" }), input)
    expect(failed.model.messages).toHaveLength(0)
    expect(failed.model.optimisticProcessing).toBeNull()
    expect(failed.outMessage).toEqual(ChatSession.OutMessage.FailedSend({ content: "x", error: "boom" }))
  })

  test("while processing, a submit enqueues instead", () => {
    const running = ChatSession.update(open(), ChatSession.Message.ReceivedSnapshot({ snapshot: snapshot("c1", [], "running") }), input).model
    const submitted = ChatSession.update(running, ChatSession.Message.SubmittedMessage({ content: "next", options: {} }), input)
    expect(submitted.commands?.[0]?.name).toBe("EnqueueMessage")
  })

  test("read anchor writes are throttled and deduped", () => {
    const ready = ChatSession.update(open(), ChatSession.Message.ReceivedSnapshot({ snapshot: snapshot("c1", []) }), input).model
    const first = ChatSession.update(ready, ChatSession.Message.ReportedReadAnchor({ messageId: "m1", atEnd: true, layout: null, at: 10_000 }), input)
    expect(first.commands?.map((command) => command.name)).toEqual(["RememberReadAnchor", "DelayReadAnchorWrite"])
    const second = ChatSession.update(first.model, ChatSession.Message.ReportedReadAnchor({ messageId: "m2", atEnd: true, layout: null, at: 10_100 }), input)
    expect(second.commands?.map((command) => command.name)).toEqual(["RememberReadAnchor"])
    const flushed = ChatSession.update(second.model, ChatSession.Message.ElapsedReadAnchorTimer({ at: 10_200 }), input)
    expect(flushed.commands?.map((command) => command.name)).toEqual(["WriteReadAnchor"])
    // At the end again: same key, no second write.
    const again = ChatSession.update(flushed.model, ChatSession.Message.ReportedReadAnchor({ messageId: "m3", atEnd: true, layout: null, at: 20_000 }), input)
    const flushedAgain = ChatSession.update(again.model, ChatSession.Message.ElapsedReadAnchorTimer({ at: 20_000 }), input)
    expect(flushedAgain.commands ?? []).toHaveLength(0)
  })

  test("the first write keeps the report's measure; a throttled one measures again", () => {
    const layout = { transcriptWidth: 816, offsetFromMessage: 197 }
    const ready = ChatSession.update(open(), ChatSession.Message.ReceivedSnapshot({ snapshot: snapshot("c1", []) }), input).model
    const first = ChatSession.update(ready, ChatSession.Message.ReportedReadAnchor({ messageId: "m1", atEnd: false, layout, at: 10_000 }), input)
    const written = ChatSession.update(first.model, ChatSession.Message.ElapsedReadAnchorTimer({ at: 10_000 }), input)
    expect(written.commands?.[0]?.args).toEqual({ chatId: "c1", messageId: "m1", atEnd: false, layout, measure: false })
    const later = ChatSession.update(written.model, ChatSession.Message.ReportedReadAnchor({ messageId: "m2", atEnd: true, layout: null, at: 10_500 }), input)
    expect(later.commands?.find((command) => command.name === "DelayReadAnchorWrite")?.args).toEqual({ ms: 1_000 })
    const throttled = ChatSession.update(later.model, ChatSession.Message.ElapsedReadAnchorTimer({ at: 11_500 }), input)
    expect(throttled.commands?.[0]?.args).toMatchObject({ messageId: "m2", measure: true })
  })

  test("the throttle carries over from the chat before", () => {
    const started = ChatSession.init("c2", { windowSize: 50, starting: false, readAnchorLastWriteAt: 10_000 })
    const opened = ChatSession.update(started.model, ChatSession.Message.ResolvedCache({ window: null, remembered: null, timedOut: false }), input).model
    const ready = ChatSession.update(opened, ChatSession.Message.ReceivedSnapshot({ snapshot: snapshot("c2", []) }), input).model
    const reported = ChatSession.update(ready, ChatSession.Message.ReportedReadAnchor({ messageId: "m1", atEnd: false, layout: null, at: 10_000 }), input)
    expect(reported.commands?.find((command) => command.name === "DelayReadAnchorWrite")?.args).toEqual({ ms: 1_500 })
  })
})
