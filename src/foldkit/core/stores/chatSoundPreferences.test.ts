import { describe, expect, test } from "bun:test"
import {
  DEFAULT_CHAT_BROWSER_NOTIFICATION_PREFERENCE,
  DEFAULT_CHAT_SOUND_ID,
  DEFAULT_CHAT_SOUND_PREFERENCE,
  initialModel,
  Message,
  normalizeChatBrowserNotificationPreference,
  normalizeChatSoundId,
  normalizeChatSoundPreference,
  update,
} from "./chatSoundPreferences"
import { run } from "./testing"

describe("normalizeChatSoundPreference", () => {
  test("accepts supported values", () => {
    expect(normalizeChatSoundPreference("never")).toBe("never")
    expect(normalizeChatSoundPreference("unfocused")).toBe("unfocused")
    expect(normalizeChatSoundPreference("always")).toBe("always")
  })

  test("falls back to the default for unknown values", () => {
    expect(normalizeChatSoundPreference("loud")).toBe(DEFAULT_CHAT_SOUND_PREFERENCE)
    expect(normalizeChatSoundPreference(undefined)).toBe(DEFAULT_CHAT_SOUND_PREFERENCE)
  })
})

describe("normalizeChatBrowserNotificationPreference", () => {
  test("accepts supported values", () => {
    expect(normalizeChatBrowserNotificationPreference("never")).toBe("never")
    expect(normalizeChatBrowserNotificationPreference("unfocused")).toBe("unfocused")
    expect(normalizeChatBrowserNotificationPreference("always")).toBe("always")
  })

  test("falls back to the default for unknown values", () => {
    expect(normalizeChatBrowserNotificationPreference("loud")).toBe(DEFAULT_CHAT_BROWSER_NOTIFICATION_PREFERENCE)
    expect(normalizeChatBrowserNotificationPreference(undefined)).toBe(DEFAULT_CHAT_BROWSER_NOTIFICATION_PREFERENCE)
  })
})

describe("normalizeChatSoundId", () => {
  test("accepts supported values", () => {
    expect(normalizeChatSoundId("blow")).toBe("blow")
    expect(normalizeChatSoundId("funk")).toBe("funk")
    expect(normalizeChatSoundId("tink")).toBe("tink")
  })

  test("falls back to the default for unknown values", () => {
    expect(normalizeChatSoundId("gong")).toBe(DEFAULT_CHAT_SOUND_ID)
    expect(normalizeChatSoundId(undefined)).toBe(DEFAULT_CHAT_SOUND_ID)
  })
})

describe("chat sound preferences", () => {
  test("defaults sounds to always and browser notifications to never", () => {
    expect(initialModel.chatSoundPreference).toBe("always")
    expect(initialModel.chatSoundId).toBe("funk")
    expect(initialModel.chatBrowserNotificationPreference).toBe("never")
  })

  test("normalizes what it is given", () => {
    let model = run(update, initialModel, Message.ChangedChatSoundPreference({ value: "never" }))
    expect(model.chatSoundPreference).toBe("never")
    model = run(update, model, Message.ChangedChatSoundPreference({ value: "invalid" }))
    expect(model.chatSoundPreference).toBe("always")

    model = run(update, model, Message.ChangedChatSoundId({ value: "glass" }))
    expect(model.chatSoundId).toBe("glass")
    model = run(update, model, Message.ChangedChatSoundId({ value: "invalid" }))
    expect(model.chatSoundId).toBe("funk")

    model = run(update, model, Message.ChangedChatBrowserNotificationPreference({ value: "unfocused" }))
    expect(model.chatBrowserNotificationPreference).toBe("unfocused")
    model = run(update, model, Message.ChangedChatBrowserNotificationPreference({ value: "invalid" }))
    expect(model.chatBrowserNotificationPreference).toBe("never")
  })
})
