import { Duration, Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import type { GitHubRecentReposResult } from "../../shared/types"
import { sendCommand } from "../core/socket"
import { openCommandPalette, postToMacApp, readEnvironment } from "./environment"
import { Message } from "./model"

// The page's side effects: the recent-repos request, the palette and other
// window calls, and the Mounts that stand for React's mount effects.

/** Newly arrived GitHub rows fade in; later renders (filters, search) don't. */
export const ARRIVAL_FADE_MS = 600

/**
 * useGitHubRecentRepos's request. A failure reads as "not connected", as the
 * hook's catch did.
 */
export const FetchRecentRepos = Command.define("FetchGitHubRecentRepos", {
  args: { version: Schema.Number },
  messages: [Message.ReceivedRecentRepos],
  execute: ({ version }) =>
    sendCommand<GitHubRecentReposResult>({ type: "github.listRecentRepos" }).pipe(
      Effect.catch(() => Effect.succeed<GitHubRecentReposResult>({ available: false, repos: [] })),
      Effect.map((result) => Message.ReceivedRecentRepos({ version, result, at: Date.now() })),
    ),
})

export const WaitArrivalFade = Command.define("WaitGitHubArrivalFade", {
  args: { arrivedAt: Schema.Number },
  messages: [Message.ElapsedArrivalFade],
  execute: ({ arrivedAt }) =>
    Effect.sleep(Duration.millis(ARRIVAL_FADE_MS)).pipe(Effect.as(Message.ElapsedArrivalFade({ arrivedAt }))),
})

export const OpenCommandPalette = Command.define("OpenCommandPalette", {
  args: { page: Schema.Literals(["add-project", "clone-github"]) },
  messages: [Message.CompletedSideEffect],
  execute: ({ page }) => Effect.sync(() => {
    openCommandPalette(page)
    return Message.CompletedSideEffect()
  }),
})

/** `window.open(url, "_blank", features)`: Manage Fleet, Open on GitHub. */
export const OpenWindow = Command.define("OpenWindow", {
  args: { url: Schema.String, features: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ url, features }) => Effect.sync(() => {
    window.open(url, "_blank", features)
    return Message.CompletedSideEffect()
  }),
})

/** Kanna for Mac opens the machine itself (it blocks links to other origins). */
export const OpenMachineInMacApp = Command.define("OpenMachineInMacApp", {
  args: { subdomain: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ subdomain }) => Effect.sync(() => {
    postToMacApp({ type: "openMachine", subdomain })
    return Message.CompletedSideEffect()
  }),
})

/** Show Archived stamps the time it opened, for the rows' ages. */
export const OpenArchive = Command.define("OpenArchivedChats", {
  args: { localPath: Schema.String },
  messages: [Message.OpenedArchive],
  execute: ({ localPath }) => Effect.sync(() => Message.OpenedArchive({ localPath, nowMs: Date.now() })),
})

/**
 * On the page's root: the page is on screen. LocalDev read the URL's
 * `?preview=`, the host and the Mac app on every render; they don't change
 * while the page is open, so they are read once here, with the element.
 */
export const MountPage = Mount.define("MountHomePage", {
  messages: [Message.MountedPage],
  execute: () => Effect.sync(() => Message.MountedPage({ environment: readEnvironment() })),
})

/**
 * On the list's heading, keyed by GitHub's sign-in state: useGitHubRecentRepos's
 * effect ran when ProjectsHome mounted and again whenever that state changed
 * (the setup wizard just connected GitHub). A new key is a new element, so
 * this runs at exactly those moments.
 */
export const MountProjectsList = Mount.define("MountProjectsList", {
  args: { ghStatus: Schema.String },
  messages: [Message.MountedProjectsList],
  execute: ({ ghStatus }) => Effect.succeed(Message.MountedProjectsList({ ghStatus })),
})
