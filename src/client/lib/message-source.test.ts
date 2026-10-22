import { describe, expect, test } from "bun:test"
import type { MessageSource } from "../../shared/types"
import { drawnMessageSource } from "./message-source"

describe("drawnMessageSource", () => {
  test("keeps the senders the transcript draws", () => {
    const sources: MessageSource[] = [
      { kind: "agent", chatId: "a" },
      { kind: "report", chatIds: ["a"] },
      { kind: "schedule", scheduleId: "s" },
    ]
    for (const source of sources) expect(drawnMessageSource(source)).toBe(source)
  })

  test("reads an old ticket reply, a nudge, or a kind it does not know as the user's own", () => {
    const old = [
      { kind: "ticket", ticketId: "tk_00000d", number: 3, title: "Fix", replyId: "r" },
      { kind: "ticket_nudge", ticketIds: ["tk_00000d"] },
      { kind: "from_the_future" },
    ] as unknown as MessageSource[]
    for (const source of old) expect(drawnMessageSource(source)).toBeUndefined()
    expect(drawnMessageSource(undefined)).toBeUndefined()
  })
})
