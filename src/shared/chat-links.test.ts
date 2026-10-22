import { describe, expect, test } from "bun:test"
import { KANNA_CHAT_LINK_INSTRUCTIONS, parseChatLink } from "./chat-links"

describe("parseChatLink", () => {
  test("recognizes relative and same-origin chat routes", () => {
    expect(parseChatLink("/chat/abc-123")).toBe("/chat/abc-123")
    expect(parseChatLink("https://kanna.example/chat/abc-123?x=1#reply", "https://kanna.example"))
      .toBe("/chat/abc-123?x=1#reply")
  })
  test("leaves files, external URLs, and invalid routes alone", () => {
    for (const href of [undefined, "/Users/brian/chat.jsonl", "/chat/", "/chat/a/file", "//evil.example/chat/a", "javascript:alert(1)", "https://other.example/chat/a"]) {
      expect(parseChatLink(href, "https://kanna.example")).toBeNull()
    }
  })
})

test("agents are told the chat link form", () => {
  expect(KANNA_CHAT_LINK_INSTRUCTIONS).toContain("[Chat title](/chat/<chatId>)")
  expect(KANNA_CHAT_LINK_INSTRUCTIONS).not.toMatch(/ticket/i)
})
