import { Schema } from "effect"
import type { Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import type { ChatBrowserNotificationPreference, ChatSoundId, ChatSoundPreference } from "../../../shared/types"

// Port of src/client/stores/chatSoundPreferencesStore.ts. Not persisted: the
// values come from the app settings.

export type { ChatBrowserNotificationPreference, ChatSoundId, ChatSoundPreference }

export const DEFAULT_CHAT_SOUND_PREFERENCE: ChatSoundPreference = "always"
export const DEFAULT_CHAT_SOUND_ID: ChatSoundId = "funk"
export const DEFAULT_CHAT_BROWSER_NOTIFICATION_PREFERENCE: ChatBrowserNotificationPreference = "never"

export const CHAT_SOUND_OPTIONS: Array<{ value: ChatSoundId; label: string }> = [
  { value: "blow", label: "Blow" },
  { value: "bottle", label: "Bottle" },
  { value: "frog", label: "Frog" },
  { value: "funk", label: "Funk" },
  { value: "glass", label: "Glass" },
  { value: "ping", label: "Ping" },
  { value: "pop", label: "Pop" },
  { value: "purr", label: "Purr" },
  { value: "tink", label: "Tink" },
]

export function normalizeChatSoundPreference(value?: string): ChatSoundPreference {
  switch (value) {
    case "never":
    case "unfocused":
    case "always":
      return value
    default:
      return DEFAULT_CHAT_SOUND_PREFERENCE
  }
}

export function normalizeChatBrowserNotificationPreference(value?: string): ChatBrowserNotificationPreference {
  switch (value) {
    case "never":
    case "unfocused":
    case "always":
      return value
    default:
      return DEFAULT_CHAT_BROWSER_NOTIFICATION_PREFERENCE
  }
}

export function normalizeChatSoundId(value?: string): ChatSoundId {
  switch (value) {
    case "blow":
    case "bottle":
    case "frog":
    case "funk":
    case "glass":
    case "ping":
    case "pop":
    case "purr":
    case "tink":
      return value
    default:
      return DEFAULT_CHAT_SOUND_ID
  }
}

const SoundPreference = Schema.Literals(["never", "unfocused", "always"])
const SoundId = Schema.Literals(["blow", "bottle", "frog", "funk", "glass", "ping", "pop", "purr", "tink"])

export const Model = Schema.Struct({
  chatSoundPreference: SoundPreference,
  chatSoundId: SoundId,
  chatBrowserNotificationPreference: SoundPreference,
})
export type Model = typeof Model.Type

export const initialModel: Model = {
  chatSoundPreference: DEFAULT_CHAT_SOUND_PREFERENCE,
  chatSoundId: DEFAULT_CHAT_SOUND_ID,
  chatBrowserNotificationPreference: DEFAULT_CHAT_BROWSER_NOTIFICATION_PREFERENCE,
}

// The payloads are plain strings: whatever arrives (an older settings file, a
// value this build doesn't know) is normalized here, as the setters did.
export const Message = defineMessageUnion({
  ChangedChatSoundPreference: { value: Schema.String },
  ChangedChatSoundId: { value: Schema.String },
  ChangedChatBrowserNotificationPreference: { value: Schema.String },
})
export type Message = typeof Message.Type

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    ChangedChatSoundPreference: ({ value }) => ({
      model: modifyFields(model, { chatSoundPreference: () => normalizeChatSoundPreference(value) }),
    }),
    ChangedChatSoundId: ({ value }) => ({
      model: modifyFields(model, { chatSoundId: () => normalizeChatSoundId(value) }),
    }),
    ChangedChatBrowserNotificationPreference: ({ value }) => ({
      model: modifyFields(model, { chatBrowserNotificationPreference: () => normalizeChatBrowserNotificationPreference(value) }),
    }),
  })
