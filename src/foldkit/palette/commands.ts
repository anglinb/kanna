import { Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { REQUEST_ATTACH_FILES_EVENT } from "../../client/app/chatFocusPolicy"
import { resolveChatBrowserNotificationPreferenceAfterPermission } from "../settings/shared"
import { requestChatBrowserNotificationPermission } from "../../client/lib/chatBrowserNotifications"
import { playChatNotificationSound } from "../../client/lib/chatSounds"
import { macSetupAvailable, postToMacApp } from "../../client/lib/macApp"
import type { ChatBrowserNotificationPreference, ChatSoundId, FsListResult, GitHubRecentReposResult } from "../../shared/types"
import { newTerminalId } from "../core/stores/terminalLayout"
import { sendCommand } from "../core/socket"
import { waitForExitAnimation } from "../ui/overlay/presence"
import { focusInputAfterSelect, resetListScroll, scrollSelectedIntoView } from "./cmdk"
import { Message } from "./message"
import type { RepoMeta } from "./model"

// The palette's side effects: its socket requests (directory listings,
// recent repos), the repo metadata fetch, cmdk's scroll and focus moves, and
// the window calls its actions make.

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * React sent these from effects, after the render the handler's own sends
 * (a clone, a project request) went out in: a turn later keeps that order on
 * the wire when both start in the same update.
 */
const afterHandlers = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.sleep(Duration.millis(0)).pipe(Effect.andThen(effect))

// OPENING

/** The root's open request, with the time the palette snaps its age labels to. */
export const OpenAt = Command.define("OpenPaletteAt", {
  args: { page: Schema.NullOr(Schema.String) },
  messages: [Message.ReceivedOpenRequest],
  execute: ({ page }) => Effect.sync(() => Message.ReceivedOpenRequest({ page, at: Date.now() })),
})

/** The dialog's content element (Radix gave it a generated id). */
export const CONTENT_ID = "command-palette-content"

/** Radix's Presence: the content stays up, `data-state="closed"`, until its exit animation ends. */
export const WaitForExitAnimation = Command.define("WaitForPaletteExitAnimation", {
  args: { version: Schema.Number },
  messages: [Message.CompletedExitAnimation],
  execute: ({ version }) =>
    waitForExitAnimation(() => document.getElementById(CONTENT_ID)).pipe(Effect.as(Message.CompletedExitAnimation({ version }))),
})

// CMDK

export const ResetListScroll = Command.define("ResetPaletteListScroll", {
  messages: [Message.CompletedSideEffect],
  execute: resetListScroll.pipe(Effect.as(Message.CompletedSideEffect())),
})

export const ScrollSelectedIntoView = Command.define("ScrollPaletteSelectionIntoView", {
  messages: [Message.CompletedSideEffect],
  execute: scrollSelectedIntoView.pipe(Effect.as(Message.CompletedSideEffect())),
})

export const FocusInputAfterSelect = Command.define("FocusPaletteInputAfterSelect", {
  messages: [Message.CompletedSideEffect],
  execute: focusInputAfterSelect.pipe(Effect.as(Message.CompletedSideEffect())),
})

// SOCKET

/** The Clone page's recent repos. A failure reads as "not signed in", as the effect's catch did. */
export const FetchGithubRepos = Command.define("FetchPaletteGithubRepos", {
  args: { seq: Schema.Number },
  messages: [Message.ReceivedGithubRepos],
  execute: ({ seq }) => afterHandlers(sendCommand<GitHubRecentReposResult>({ type: "github.listRecentRepos" })).pipe(
    Effect.catch(() => Effect.succeed<GitHubRecentReposResult>({ available: false, repos: [] })),
    Effect.map((result) => Message.ReceivedGithubRepos({ seq, result })),
  ),
})

/** The Create page's collision check. A missing directory means nothing can collide. */
export const ListCreateDir = Command.define("ListPaletteCreateDir", {
  args: { seq: Schema.Number, path: Schema.String },
  messages: [Message.ReceivedCreateDirNames],
  execute: ({ seq, path }) => afterHandlers(sendCommand<FsListResult>({ type: "fs.list", path })).pipe(
    Effect.map((result) => result.entries.map((entry) => entry.name.toLocaleLowerCase())),
    Effect.catch(() => Effect.succeed<string[]>([])),
    Effect.map((names) => Message.ReceivedCreateDirNames({ seq, names })),
  ),
})

/** useDirectoryBrowser's `load` (an uncached directory; null = home). */
export const LoadDirectory = Command.define("LoadPaletteDirectory", {
  args: { seq: Schema.Number, path: Schema.NullOr(Schema.String) },
  messages: [Message.ReceivedDirectory, Message.FailedDirectory],
  execute: ({ seq, path }) => afterHandlers(sendCommand<FsListResult>(path === null ? { type: "fs.list" } : { type: "fs.list", path })).pipe(
    Effect.map((result) => Message.ReceivedDirectory({ seq, result })),
    Effect.catch((error) => Effect.succeed(Message.FailedDirectory({ seq, error: errorMessage(error) }))),
  ),
})

/** useDirectoryBrowser's `jumpTo`: a typed path, with nearest-ancestor fallback. */
export const JumpToPath = Command.define("JumpPaletteToPath", {
  args: { seq: Schema.Number, input: Schema.String },
  messages: [Message.ReceivedJump, Message.FailedJump],
  execute: ({ seq, input }) => sendCommand<FsListResult>({ type: "fs.list", path: input, nearest: true }).pipe(
    Effect.map((result) => Message.ReceivedJump({ seq, result })),
    Effect.catch((error) => Effect.succeed(Message.FailedJump({ seq, error: errorMessage(error) }))),
  ),
})

// REPO METADATA (useRepoMetadata)

const DEBOUNCE_MS = 350

/** The hook's debounce timer; update drops it when a newer run of the effect cleared it. */
export const WaitRepoMetaDebounce = Command.define("WaitPaletteRepoMetaDebounce", {
  args: { seq: Schema.Number, key: Schema.String },
  messages: [Message.ElapsedRepoMetaDebounce],
  execute: ({ seq, key }) => Effect.sleep(Duration.millis(DEBOUNCE_MS)).pipe(Effect.as(Message.ElapsedRepoMetaDebounce({ seq, key }))),
})

/** The github.com lookup the timer starts. */
export const FetchRepoMeta = Command.define("FetchPaletteRepoMeta", {
  args: { key: Schema.String },
  messages: [Message.ReceivedRepoMeta, Message.FailedRepoMeta],
  execute: ({ key }) => Effect.void.pipe(
    Effect.andThen(Effect.tryPromise(async () => {
      const response = await fetch(`https://api.github.com/repos/${key}`)
      if (!response.ok) {
        throw new Error(response.status === 404
          ? "Repository not found — it may be private. Cloning can still work if you have access."
          : `Couldn't load repository details (${response.status}).`)
      }
      const data = await response.json() as {
        full_name: string
        description: string | null
        stargazers_count: number
        language: string | null
        pushed_at: string | null
      }
      const meta: RepoMeta = {
        fullName: data.full_name,
        description: data.description,
        stars: data.stargazers_count,
        language: data.language,
        pushedAt: data.pushed_at,
      }
      return meta
    })),
    Effect.map((meta) => Message.ReceivedRepoMeta({ key, meta })),
    Effect.catch((error) => {
      const cause = (error as { cause?: unknown }).cause ?? error
      return Effect.succeed(Message.FailedRepoMeta({ key, error: errorMessage(cause) }))
    }),
  ),
})

// CLONE

/** Navigation to the new chat already happened; the ✓ flashes this long, then the palette closes. */
export const WaitCloneSuccess = Command.define("WaitPaletteCloneSuccess", {
  args: { cloneSeq: Schema.Number },
  messages: [Message.ElapsedCloneSuccess],
  execute: ({ cloneSeq }) => Effect.sleep(Duration.millis(600)).pipe(Effect.as(Message.ElapsedCloneSuccess({ cloneSeq }))),
})

// WINDOW

/** Opening the palette asks Kanna for Mac for this Mac's switches afresh. */
export const RefreshMacSetup = Command.define("RefreshPaletteMacSetup", {
  messages: [Message.ReceivedMacSetup],
  execute: Effect.sync(() => {
    if (!macSetupAvailable()) return Message.ReceivedMacSetup({ state: null })
    postToMacApp({ type: "macSetup.refresh" })
    return Message.ReceivedMacSetup({ state: window.__kannaMacSetup ?? null })
  }),
})

/** One of lib/macApp's `macSetup` calls (each answers with the new state, as a `kanna:mac-setup` event). */
export const PostToMacApp = Command.define("PostPaletteMacSetup", {
  args: { message: Schema.Record(Schema.String, Schema.Unknown) },
  messages: [Message.CompletedSideEffect],
  execute: ({ message }) => Effect.sync(() => {
    postToMacApp(message as { type: string } & Record<string, unknown>)
    return Message.CompletedSideEffect()
  }),
})

/** The Settings page plays the chosen chime, so the palette does too. */
export const PlayChatSound = Command.define("PlayPaletteChatSound", {
  args: { soundId: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ soundId }) => Effect.tryPromise(() => playChatNotificationSound(soundId as ChatSoundId, 1)).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedSideEffect()),
  ),
})

/**
 * As in Settings: the browser's prompt, on this choice; a denied or
 * unsupported one saves Never rather than an option that never fires.
 */
export const RequestNotificationPermission = Command.define("RequestPaletteNotificationPermission", {
  args: { preference: Schema.Literals(["never", "unfocused", "always"]) },
  messages: [Message.ReceivedNotificationPermission],
  execute: ({ preference }) => Effect.tryPromise(async () => {
    const permission = preference === "never" ? "granted" as const : await requestChatBrowserNotificationPermission()
    return resolveChatBrowserNotificationPreferenceAfterPermission(preference as ChatBrowserNotificationPreference, permission)
  }).pipe(
    Effect.catch(() => Effect.succeed<ChatBrowserNotificationPreference>("never")),
    Effect.map((resolved) => Message.ReceivedNotificationPermission({ preference: resolved })),
  ),
})

/** "Attach Files": ChatInput opens its file picker. */
export const RequestAttachFiles = Command.define("RequestPaletteAttachFiles", {
  messages: [Message.CompletedSideEffect],
  execute: Effect.sync(() => {
    window.dispatchEvent(new CustomEvent(REQUEST_ATTACH_FILES_EVENT))
    return Message.CompletedSideEffect()
  }),
})

/** `addTerminal`'s id, made before the layout change (the store made it inside). */
export const MakeTerminalId = Command.define("MakePaletteTerminalId", {
  args: { projectId: Schema.String, chatKey: Schema.NullOr(Schema.String), nextTerminalIndex: Schema.Number },
  messages: [Message.GeneratedTerminalId],
  execute: ({ projectId, chatKey, nextTerminalIndex }) => Effect.sync(() =>
    Message.GeneratedTerminalId({ projectId, chatKey, terminalId: newTerminalId(nextTerminalIndex) })),
})
