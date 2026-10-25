import { Effect, Schema } from "effect"

// What the page reads of the browser it runs in, and the window events it
// sends. Copied from React files the Foldkit bundle must not import:
// src/client/lib/macApp.ts (it also builds a zustand store, which pulls in
// React) and CommandPalette.tsx (the open event).

/** CommandPalette.tsx's OPEN_COMMAND_PALETTE_EVENT. */
export const OPEN_COMMAND_PALETTE_EVENT = "kanna:open-command-palette"

/** CommandPalette.tsx's CommandPaletteTargetPage. */
export type CommandPaletteTargetPage = "new-thread" | "project-chats" | "add-project" | "clone-github"

/**
 * Opens the command palette from anywhere. Pass a target page to land directly
 * on a sub-page (e.g. "new-thread" for the "New Chat In…" project picker).
 */
export function openCommandPalette(page?: CommandPaletteTargetPage) {
  window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT, { detail: page ? { page } : undefined }))
}

interface MacAppHandler {
  postMessage: (message: unknown) => void
}

function handler(): MacAppHandler | null {
  if (typeof window === "undefined") return null
  const webkit = (window as { webkit?: { messageHandlers?: { kanna?: MacAppHandler } } }).webkit
  return webkit?.messageHandlers?.kanna ?? null
}

/** macApp.ts's isMacApp: the Kanna for Mac window (macos/). */
export function isMacApp() {
  return handler() !== null
}

/**
 * macApp.ts's isOnThisMac: this Mac's own server, not another machine's page
 * opened through the Fleet.
 */
export function isOnThisMac(hostname: string) {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)
}

export function postToMacApp(message: { type: string } & Record<string, unknown>) {
  handler()?.postMessage(message)
}

/** MachineSwitcher.tsx's FLEET_URL. */
export const FLEET_URL = "https://kanna.sh/fleet"

/**
 * The page's surroundings, read once when it mounts (React read them on
 * every render; none of them change while a page is open).
 */
export const PageEnvironment = Schema.Struct({
  hostname: Schema.String,
  host: Schema.String,
  port: Schema.String,
  macApp: Schema.Boolean,
  /** `?preview=` on the URL (LocalDev's preview bar). */
  preview: Schema.NullOr(Schema.String),
  /** Date.now() when read: what the preview fleet's "last seen" counts from. */
  nowMs: Schema.Number,
})
export type PageEnvironment = typeof PageEnvironment.Type

export const defaultEnvironment: PageEnvironment = {
  hostname: "localhost",
  host: "localhost",
  port: "",
  macApp: false,
  preview: null,
  nowMs: 0,
}

export function readEnvironment(): PageEnvironment {
  return {
    hostname: window.location.hostname,
    host: window.location.host,
    port: window.location.port,
    macApp: isMacApp(),
    preview: new URLSearchParams(window.location.search).get("preview"),
    nowMs: Date.now(),
  }
}

export const readEnvironmentEffect = Effect.sync(readEnvironment)
