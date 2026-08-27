import { describe, expect, test } from "bun:test"
import { CLI_COMMAND } from "../shared/branding"
import { buildReminderInstructions, reminderInstructionsBlock } from "./reminder-instructions"

describe("buildReminderInstructions", () => {
  test("names the command and the fallback path", () => {
    const block = buildReminderInstructions("/opt/kanna/bin/kanna")
    expect(block).toContain(`${CLI_COMMAND} remind --in 30m`)
    expect(block).toContain("/opt/kanna/bin/kanna")
  })

  test("bakes in --chat for providers that cannot carry KANNA_CHAT_ID", () => {
    const block = buildReminderInstructions("/bin/kanna", "chat-42")
    expect(block).toContain("--chat chat-42")
  })

  test("omits --chat when the chat id is not supplied", () => {
    expect(buildReminderInstructions("/bin/kanna")).not.toContain("--chat")
  })

  test("tells the agent not to sleep or poll — the line the feature depends on", () => {
    const block = buildReminderInstructions("/bin/kanna")
    expect(block).toContain("Do not sleep, poll, or loop")
    expect(block).toContain("survives a restart")
  })

  test("warns that the future message arrives without current context", () => {
    expect(buildReminderInstructions("/bin/kanna")).toContain("none of your current context")
  })

  test("is always on — unlike pull requests, it has no global setting to gate", () => {
    expect(reminderInstructionsBlock()).not.toBeNull()
  })
})
