import { Effect, Schema } from "effect"
import { Command, Navigation } from "foldkit"
import type { ClientCommand } from "../../shared/protocol"
import type { AppSettingsSnapshot, ChatBrowserNotificationPreference, ChatPreview, ChatSoundId, ChatSoundPreference, LlmProviderSnapshot } from "../../shared/types"
import { followChat, unfollowChat } from "../core/backgroundChats"
import * as AppNavigation from "../core/navigation"
import { opaque } from "../core/schema"
import { errorMessage, sendCommand } from "../core/socket"
import { writeStorageItem } from "../core/storage"
import { SIDEBAR_COLLAPSED_STORAGE_KEY } from "../../client/lib/storageKeys"
import { playChatNotificationSound, shouldPlayChatSound } from "../../client/lib/chatSounds"
import { shouldShowChatBrowserNotification, showChatBrowserNotification } from "../../client/lib/chatBrowserNotifications"
import { syncThemeMetadata } from "./theme"
import { Message } from "./message"

const AUTH_STATUS_RETRY_DELAY_MS = 500
/**
 * How long a chat that stopped running stays subscribed. Longer than the
 * server's background push interval, so the push that carries the end of the
 * turn lands before the subscription goes.
 */
export const STOPPED_CHAT_GRACE_MS = 3_000

// NAVIGATION

export const PushUrl = Command.define("PushUrl", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigation],
  execute: ({ url }) => AppNavigation.pushUrl(url).pipe(Effect.as(Message.CompletedNavigation())),
})

export const ReplaceUrl = Command.define("ReplaceUrl", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigation],
  execute: ({ url }) => AppNavigation.replaceUrl(url).pipe(Effect.as(Message.CompletedNavigation())),
})

export const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedNavigation],
  execute: ({ href }) => Navigation.load(href).pipe(Effect.as(Message.CompletedNavigation())),
})

// AUTH (App.tsx useAppAuthState)

export const FetchAuthStatus = Command.define("FetchAuthStatus", {
  messages: [Message.ReceivedAuthStatus, Message.FailedAuthStatus],
  execute: Effect.tryPromise(async () => {
    const response = await fetch("/auth/status", {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
    })
    if (!response.ok) throw new Error(String(response.status))
    const payload = await response.json() as { enabled?: boolean; authenticated?: boolean }
    return Message.ReceivedAuthStatus({ enabled: Boolean(payload.enabled), authenticated: Boolean(payload.authenticated) })
  }).pipe(Effect.catch(() => Effect.succeed(Message.FailedAuthStatus()))),
})

export const DelayAuthRetry = Command.define("DelayAuthRetry", {
  messages: [Message.ElapsedAuthRetry],
  execute: Effect.sleep(AUTH_STATUS_RETRY_DELAY_MS).pipe(Effect.as(Message.ElapsedAuthRetry())),
})

export const SubmitPassword = Command.define("SubmitPassword", {
  args: { password: Schema.String },
  messages: [Message.SucceededLogin, Message.FailedLogin],
  execute: ({ password }) => Effect.tryPromise(async () => {
    const response = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ password, next: AppNavigation.currentPathAndSearch() }),
    })
    return response.ok ? Message.SucceededLogin() : Message.FailedLogin()
  }).pipe(Effect.catch(() => Effect.succeed(Message.FailedLogin()))),
})

// SOCKET COMMANDS

/**
 * A ClientCommand whose ack carries nothing the app keeps: what it changes
 * comes back on a snapshot. Its failure becomes the app's command error,
 * as `setCommandError` did.
 */
export const SendCommand = Command.define("SendCommand", {
  args: { command: opaque<ClientCommand>("ClientCommand") },
  messages: [Message.CompletedCommand, Message.FailedCommand],
  execute: ({ command }) => sendCommand(command).pipe(
    Effect.as(Message.CompletedCommand()),
    Effect.catch((error) => Effect.succeed(Message.FailedCommand({ message: errorMessage(error) }))),
  ),
})

export const ReadAppSettings = Command.define("ReadAppSettings", {
  messages: [Message.SucceededReadAppSettings, Message.FailedCommand],
  execute: sendCommand<AppSettingsSnapshot>({ type: "settings.readAppSettings" }).pipe(
    Effect.map((snapshot) => Message.SucceededReadAppSettings({ snapshot })),
    Effect.catch((error) => Effect.succeed(Message.FailedCommand({ message: errorMessage(error) }))),
  ),
})

export const ReadLlmProvider = Command.define("ReadLlmProvider", {
  messages: [Message.SucceededReadLlmProvider, Message.FailedCommand],
  execute: sendCommand<LlmProviderSnapshot>({ type: "settings.readLlmProvider" }).pipe(
    Effect.map((snapshot) => Message.SucceededReadLlmProvider({ snapshot })),
    Effect.catch((error) => Effect.succeed(Message.FailedCommand({ message: errorMessage(error) }))),
  ),
})

// BACKGROUND CHATS

export const FollowBackgroundChat = Command.define("FollowBackgroundChat", {
  args: { chatId: Schema.String, windowSize: Schema.Number },
  messages: [Message.CompletedSideEffect],
  execute: ({ chatId, windowSize }) => followChat(chatId, windowSize).pipe(Effect.as(Message.CompletedSideEffect())),
})

export const UnfollowBackgroundChat = Command.define("UnfollowBackgroundChat", {
  args: { chatId: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ chatId }) => unfollowChat(chatId).pipe(Effect.as(Message.CompletedSideEffect())),
})

export const DelayBackgroundChatDrop = Command.define("DelayBackgroundChatDrop", {
  args: { chatId: Schema.String },
  messages: [Message.ElapsedBackgroundChatGrace],
  execute: ({ chatId }) => Effect.sleep(STOPPED_CHAT_GRACE_MS).pipe(Effect.as(Message.ElapsedBackgroundChatGrace({ chatId }))),
})

// BROWSER

export const SaveSidebarCollapsed = Command.define("SaveSidebarCollapsed", {
  args: { collapsed: Schema.Boolean },
  messages: [Message.CompletedSideEffect],
  execute: ({ collapsed }) => writeStorageItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0").pipe(Effect.as(Message.CompletedSideEffect())),
})

export const ApplyTheme = Command.define("ApplyTheme", {
  args: { resolved: Schema.Literals(["light", "dark"]) },
  messages: [Message.CompletedSideEffect],
  execute: ({ resolved }) => Effect.sync(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark")
    syncThemeMetadata(resolved)
    return Message.CompletedSideEffect()
  }),
})

/** The chime for chats that just turned unread or started waiting (App.tsx). */
export const PlayChatSound = Command.define("PlayChatSound", {
  args: { preference: Schema.String, soundId: Schema.String, burstCount: Schema.Number },
  messages: [Message.CompletedSideEffect],
  execute: ({ preference, soundId, burstCount }) => Effect.gen(function* () {
    if (shouldPlayChatSound(preference as ChatSoundPreference)) {
      yield* Effect.tryPromise(() => playChatNotificationSound(soundId as ChatSoundId, burstCount)).pipe(Effect.ignore)
    }
    return Message.CompletedSideEffect()
  }),
})

/**
 * A system notification for one chat event. It names its chat, so the body
 * for a chat that only turned unread is fetched on demand: the sidebar
 * snapshot deliberately carries no message previews. A waiting chat already
 * has its question. Resolves with ClickedChatNotification if it is clicked.
 */
export const ShowChatNotification = Command.define("ShowChatNotification", {
  args: {
    preference: Schema.String,
    chatId: Schema.String,
    projectTitle: Schema.String,
    chatTitle: Schema.String,
    message: Schema.NullOr(Schema.String),
  },
  messages: [Message.CompletedSideEffect, Message.ClickedChatNotification],
  execute: ({ preference, chatId, projectTitle, chatTitle, message }) => Effect.gen(function* () {
    if (!shouldShowChatBrowserNotification(preference as ChatBrowserNotificationPreference)) return Message.CompletedSideEffect()
    const body = message ?? (yield* sendCommand<ChatPreview>({ type: "chat.getPreview", chatId }).pipe(
      Effect.map((preview) => preview?.lastAgentMessagePreview ?? ""),
      Effect.catch(() => Effect.succeed("")),
    ))
    return yield* Effect.callback<typeof Message.ClickedChatNotification.Type | typeof Message.CompletedSideEffect.Type>((resume) => {
      const shown = showChatBrowserNotification({
        projectTitle,
        chatTitle,
        message: body,
        onClick: () => {
          window.focus()
          resume(Effect.succeed(Message.ClickedChatNotification({ chatId })))
        },
      })
      if (!shown) resume(Effect.succeed(Message.CompletedSideEffect()))
    })
  }),
})
