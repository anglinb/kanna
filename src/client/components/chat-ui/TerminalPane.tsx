import { useEffect, useRef, useState, type MutableRefObject } from "react"
import { SerializeAddon } from "@xterm/addon-serialize"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { WebglAddon } from "@xterm/addon-webgl"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Terminal, type ITheme, type ITerminalOptions } from "@xterm/xterm"
import type { TerminalSnapshot } from "../../../shared/protocol"
import type { KannaSocket, SocketStatus } from "../../app/socket"
import { useTheme } from "../../hooks/useTheme"
import { useTerminalPreferencesStore } from "../../stores/terminalPreferencesStore"

interface Props {
  /** null → a home-directory terminal (dev-box full-screen Terminal page). */
  projectId: string | null
  terminalId: string
  socket: KannaSocket
  scrollback: number
  connectionStatus: SocketStatus
  clearVersion?: number
  focusRequestVersion?: number
  initialCommand?: string
  onPathChange?: (path: string | null) => void
  onCommandSent?: () => void
  onInitialCommandSent?: (terminalId: string) => void
}

const TERMINAL_THEME_LIGHT: ITheme = {
  foreground: "#0f172a",
  // Zero alpha, and the RGB channels matter — see resolveSurfaceBackground().
  // This is only the fallback for when the surface colour can't be read off the
  // DOM; keep it in step with --background in index.css.
  background: "rgba(255, 255, 255, 0)",
  cursor: "#000000",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(221,228,236,0.55)",
  selectionInactiveBackground: "rgba(221,228,236,0.38)",
  black: "#0f172a",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#ca8a04",
  blue: "#2563eb",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#94a3b8",
  brightBlack: "#475569",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#eab308",
  brightBlue: "#3b82f6",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#e2e8f0",
}

const TERMINAL_THEME_DARK: ITheme = {
  foreground: "#f8fafc",
  // Zero alpha, and the RGB channels matter — see resolveSurfaceBackground().
  // This is only the fallback for when the surface colour can't be read off the
  // DOM; keep it in step with --background in index.css (223 4% 13%).
  background: "rgba(32, 33, 34, 0)",
  cursor: "#ffffff",
  cursorAccent: "#000000",
  selectionBackground: "rgba(248,250,252,0.28)",
  selectionInactiveBackground: "rgba(248,250,252,0.18)",
  black: "#0f172a",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#cbd5e1",
  brightBlack: "#64748b",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
}

/** Exported so tests can assert both themes stay xterm-parseable. */
export const TERMINAL_THEMES: ITheme[] = [TERMINAL_THEME_LIGHT, TERMINAL_THEME_DARK]

/** Computed `background-color` is always `rgb(...)`/`rgba(...)`; anything else we skip. */
const COMPUTED_RGB = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/

/**
 * The theme background feeds two different rectangles in xterm's WebGL renderer:
 *
 * - the full-viewport rect, drawn with the colour's real alpha — zero keeps the
 *   pane see-through so index.css's transparent backgrounds show through;
 * - one rect per run of cells whose *background attribute word* is non-zero,
 *   drawn with alpha forced to 1 (RectangleRenderer `$a = 1`). DIM, ITALIC and
 *   OVERLINE live in that word, so dim text gets a rect even though its
 *   background is the default one — with black RGB that reads as a black box
 *   behind every dim run (Vite's "ready in", "press h + enter to show help", …).
 *
 * Both read the same colour, so keep alpha at 0 and point RGB at the surface the
 * pane actually sits on: the viewport rect stays invisible and the forced-opaque
 * per-cell rects blend into the background. The DOM renderer draws neither.
 */
export function resolveSurfaceBackground(element: Element | null): string | null {
  let node: Element | null = element
  while (node) {
    const match = globalThis.getComputedStyle?.(node).backgroundColor?.match(COMPUTED_RGB)
    if (match && (match[4] === undefined || parseFloat(match[4]) > 0)) {
      return `rgba(${match[1]}, ${match[2]}, ${match[3]}, 0)`
    }
    node = node.parentElement
  }
  return null
}

function withSurfaceBackground(theme: ITheme, element: Element | null): ITheme {
  const background = resolveSurfaceBackground(element)
  return background ? { ...theme, background } : theme
}

function getTerminalSize(terminal: Terminal) {
  return {
    cols: Math.max(1, terminal.cols || 80),
    rows: Math.max(1, terminal.rows || 24),
  }
}

function getMeasuredTerminalSize(terminal: Terminal, container: HTMLElement) {
  const xtermElement = terminal.element
  const cellDimensions = (
    terminal as unknown as {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: {
                width?: number
                height?: number
              }
            }
          }
        }
      }
    }
  )._core?._renderService?.dimensions?.css?.cell

  const cellWidth = cellDimensions?.width ?? 0
  const cellHeight = cellDimensions?.height ?? 0

  if (!xtermElement || !Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0) {
    return null
  }

  const containerRect = container.getBoundingClientRect()
  const containerStyle = window.getComputedStyle(container)
  const xtermStyle = window.getComputedStyle(xtermElement)
  const overviewRulerWidth = terminal.options.scrollback === 0 ? 0 : (terminal.options.overviewRuler?.width ?? 14)
  const widthPadding = parseFloat(containerStyle.paddingLeft) + parseFloat(containerStyle.paddingRight) + parseFloat(xtermStyle.paddingLeft) + parseFloat(xtermStyle.paddingRight)
  const heightPadding = parseFloat(containerStyle.paddingTop) + parseFloat(containerStyle.paddingBottom) + parseFloat(xtermStyle.paddingTop) + parseFloat(xtermStyle.paddingBottom)
  const availableWidth = Math.max(0, containerRect.width - widthPadding - overviewRulerWidth - 1)
  const availableHeight = Math.max(0, containerRect.height - heightPadding)

  return {
    cols: Math.max(2, Math.floor(availableWidth / cellWidth)),
    rows: Math.max(1, Math.floor(availableHeight / cellHeight)),
  }
}

function refreshTerminal(terminal: Terminal) {
  terminal.refresh(0, Math.max(0, terminal.rows - 1))
}

function sameTerminalMetadata(
  left: Pick<TerminalSnapshot, "cwd" | "shell" | "status" | "exitCode"> | null,
  right: Pick<TerminalSnapshot, "cwd" | "shell" | "status" | "exitCode"> | null
) {
  if (left === right) return true
  if (!left || !right) return false
  return left.cwd === right.cwd
    && left.shell === right.shell
    && left.status === right.status
    && left.exitCode === right.exitCode
}

function isMacPlatform(platform: string) {
  return /mac/i.test(platform)
}

interface MacOptionKeyEvent {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  key: string
  getModifierState?: (key: string) => boolean
}

export function getTerminalOptions(scrollback: number, theme: ITheme, platform = globalThis.navigator?.platform ?? ""): ITerminalOptions {
  return {
    scrollback,
    // Required before touching `terminal.unicode` — xterm throws from
    // _checkProposedApi() otherwise. The server's shadow terminal already
    // sets it.
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorWidth: 1,
    lineHeight: 1,
    convertEol: false,
    allowTransparency: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 13,
    theme,
    macOptionIsMeta: isMacPlatform(platform),
    // Shrink glyphs that a fallback font draws wider than their cell instead of
    // letting them bleed over the next column. xterm defaults this off.
    rescaleOverlappingGlyphs: true,
  }
}

export function getMacOptionInputSequence(event: MacOptionKeyEvent, platform = globalThis.navigator?.platform ?? "") {
  if (event.ctrlKey) return null

  if (!event.altKey && !event.metaKey) {
    switch (event.key) {
      case "ArrowUp":
        return "\x1b[A"
      case "ArrowDown":
        return "\x1b[B"
      case "ArrowLeft":
        return "\x1b[D"
      case "ArrowRight":
        return "\x1b[C"
      default:
        return null
    }
  }

  if (!isMacPlatform(platform)) return null

  if (event.metaKey && !event.altKey) {
    switch (event.key) {
      case "Backspace":
        return "\x15"
      case "Delete":
        return "\x0b"
      default:
        return null
    }
  }

  const isOptionPressed = event.altKey || event.getModifierState?.("AltGraph") === true
  if (!isOptionPressed) return null

  switch (event.key) {
    case "ArrowLeft":
      return "\x1bb"
    case "ArrowRight":
      return "\x1bf"
    case "Backspace":
      return "\x1b\x7f"
    case "Delete":
      return "\x1bd"
    default:
      return null
  }
}

function syncTerminalSize(
  terminal: Terminal,
  container: HTMLElement,
  lastSizeRef: MutableRefObject<{ cols: number; rows: number } | null>,
  hasCreated: boolean,
  sendResize: (cols: number, rows: number) => void
) {
  const nextSize = getMeasuredTerminalSize(terminal, container) ?? getTerminalSize(terminal)
  if (lastSizeRef.current && lastSizeRef.current.cols === nextSize.cols && lastSizeRef.current.rows === nextSize.rows) {
    return nextSize
  }
  terminal.resize(nextSize.cols, nextSize.rows)
  lastSizeRef.current = nextSize
  if (hasCreated) {
    sendResize(nextSize.cols, nextSize.rows)
  }
  return nextSize
}

/**
 * An xterm instance that outlives the pane that opened it.
 *
 * Switching to a chat in another project remounts the terminal panel group,
 * and a fresh `Terminal` plus WebGL renderer (shader compile, canvas
 * allocation, glyph atlas) ran 400-600 ms on the main thread per switch. So a
 * pane parks its terminal here on unmount, DOM node and all, and the next
 * pane for the same terminal id lifts it back into its container. Only a
 * closed terminal, a renderer toggle, or the cache cap disposes one.
 *
 * `sendInput` is re-pointed on every mount because the key handler and
 * `onData` are registered once, at creation, and must reach the live pane.
 */
interface CachedTerminal {
  terminal: Terminal
  host: HTMLDivElement
  serializeAddon: SerializeAddon
  webglAddon: WebglAddon | null
  webglRenderer: boolean
  mounted: boolean
  lastUsedAt: number
  sendInput: (data: string) => void
}

/** Browsers cap live WebGL contexts around 16; stay well under it. */
const TERMINAL_CACHE_LIMIT = 8

const terminalCache = new Map<string, CachedTerminal>()

function disposeTerminal(cached: CachedTerminal) {
  // Release the GL context before the terminal goes away; browsers cap the
  // number of live contexts and won't reclaim it on their own.
  cached.webglAddon?.dispose()
  cached.webglAddon = null
  cached.terminal.dispose()
  cached.host.remove()
}

/** Drop a parked terminal for good. Call when its shell is closed. */
export function disposeCachedTerminal(terminalId: string) {
  const cached = terminalCache.get(terminalId)
  if (!cached) return
  terminalCache.delete(terminalId)
  disposeTerminal(cached)
}

function evictParkedTerminals() {
  if (terminalCache.size <= TERMINAL_CACHE_LIMIT) return
  const parked = [...terminalCache.entries()]
    .filter(([, cached]) => !cached.mounted)
    .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)
  for (const [terminalId, cached] of parked) {
    if (terminalCache.size <= TERMINAL_CACHE_LIMIT) return
    terminalCache.delete(terminalId)
    disposeTerminal(cached)
  }
}

export function TerminalPane({
  projectId,
  terminalId,
  socket,
  scrollback,
  connectionStatus,
  clearVersion = 0,
  focusRequestVersion = 0,
  initialCommand,
  onPathChange,
  onCommandSent,
  onInitialCommandSent,
}: Props) {
  const { resolvedTheme } = useTheme()
  // Labs opt-in. Read from the store rather than drilled through the workspace
  // so toggling it only re-mounts the panes.
  const webglRenderer = useTerminalPreferencesStore((store) => store.webglRenderer)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const replayStateRef = useRef<string | null>(null)
  const onCommandSentRef = useRef<Props["onCommandSent"]>(onCommandSent)
  const hasCreatedRef = useRef(false)
  const createAttemptRef = useRef(0)
  const lastAppliedSnapshotKeyRef = useRef<string | null>(null)
  const sentInitialCommandRef = useRef<string | null>(null)
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const [metadata, setMetadata] = useState<Pick<TerminalSnapshot, "cwd" | "shell" | "status" | "exitCode"> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const terminalTheme = resolvedTheme === "dark" ? TERMINAL_THEME_DARK : TERMINAL_THEME_LIGHT
  const sendInput = (data: string) => {
    void socket.command({
      type: "terminal.input",
      terminalId,
      data,
    }).catch((commandError) => {
      setError(commandError instanceof Error ? commandError.message : String(commandError))
    })
    if (data.includes("\r") || data.includes("\n")) {
      onCommandSentRef.current?.()
    }
  }
  const sendResize = (cols: number, rows: number) => {
    void socket.command({
      type: "terminal.resize",
      terminalId,
      cols,
      rows,
    }).catch(() => {})
  }
  const scheduleResizeSync = () => {
    const sync = () => {
      const terminalInstance = terminalRef.current
      const element = containerRef.current
      if (!terminalInstance || !element || !hasCreatedRef.current) return
      syncTerminalSize(terminalInstance, element, lastSizeRef, true, sendResize)
    }

    requestAnimationFrame(() => {
      sync()
      setTimeout(sync, 0)
    })
  }

  useEffect(() => {
    onCommandSentRef.current = onCommandSent
  }, [onCommandSent])

  useEffect(() => {
    sentInitialCommandRef.current = null
  }, [initialCommand])

  useEffect(() => {
    const element = containerRef.current
    const theme = withSurfaceBackground(terminalTheme, element)

    let cached = terminalCache.get(terminalId) ?? null
    if (cached && cached.webglRenderer !== webglRenderer) {
      // The renderer is chosen at creation; a toggle needs a fresh instance.
      terminalCache.delete(terminalId)
      disposeTerminal(cached)
      cached = null
    }

    if (cached) {
      cached.terminal.options.theme = theme
      cached.terminal.options.scrollback = scrollback
    } else {
      const terminal = new Terminal(getTerminalOptions(scrollback, theme))
      const serializeAddon = new SerializeAddon()
      terminal.loadAddon(serializeAddon)
      terminal.loadAddon(new WebLinksAddon())
      // Must match the shadow terminal on the server: xterm defaults to Unicode 6
      // width tables, which measure astral emoji as one cell instead of two. If
      // the two ends disagree, replayed snapshots land in the wrong columns.
      terminal.loadAddon(new Unicode11Addon())
      terminal.unicode.activeVersion = "11"

      const created: CachedTerminal = {
        terminal,
        host: document.createElement("div"),
        serializeAddon,
        webglAddon: null,
        webglRenderer,
        mounted: false,
        lastUsedAt: Date.now(),
        sendInput,
      }
      created.host.className = "h-full w-full"
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true

        const sequence = getMacOptionInputSequence(event)
        if (!sequence) return true

        event.preventDefault()
        created.sendInput(sequence)
        return false
      })
      terminal.onData((data) => {
        created.sendInput(data)
      })

      // xterm opens into the host, never into the pane's own container, so the
      // host can move between containers as panes come and go.
      terminal.open(created.host)
      // The WebGL renderer needs a live render service, so it can only be
      // attached after open(). Any failure (no GPU, blocklisted driver, lost
      // context) falls back to xterm's built-in DOM renderer rather than
      // leaving the pane blank.
      if (webglRenderer) {
        try {
          const addon = new WebglAddon()
          addon.onContextLoss(() => {
            addon.dispose()
            if (created.webglAddon === addon) created.webglAddon = null
          })
          terminal.loadAddon(addon)
          created.webglAddon = addon
        } catch (webglError) {
          console.warn("Terminal: WebGL renderer unavailable, using the DOM renderer.", webglError)
          created.webglAddon = null
        }
      }
      if (replayStateRef.current) {
        terminal.write(replayStateRef.current)
      }
      terminalCache.set(terminalId, created)
      cached = created
      evictParkedTerminals()
    }

    const live = cached
    const { terminal, serializeAddon } = live
    live.sendInput = sendInput
    live.mounted = true
    live.lastUsedAt = Date.now()
    terminalRef.current = terminal

    if (element) {
      element.appendChild(live.host)
      syncTerminalSize(terminal, element, lastSizeRef, false, () => {})
      refreshTerminal(terminal)
      scheduleResizeSync()
    }

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (!hasCreatedRef.current) return
      const nextSize = { cols, rows }
      if (lastSizeRef.current && lastSizeRef.current.cols === cols && lastSizeRef.current.rows === rows) {
        return
      }
      lastSizeRef.current = nextSize
      sendResize(cols, rows)
    })

    const observer = new ResizeObserver(() => {
      const terminalInstance = terminalRef.current
      const element = containerRef.current
      if (!terminalInstance || !element) return
      syncTerminalSize(terminalInstance, element, lastSizeRef, hasCreatedRef.current, (cols, rows) => {
        void socket.command({
          type: "terminal.resize",
          terminalId,
          cols,
          rows,
        }).catch(() => {})
      })
    })

    if (element) {
      observer.observe(element)
    }

    return () => {
      observer.disconnect()
      resizeDisposable.dispose()
      replayStateRef.current = serializeAddon.serialize()
      // Park, do not dispose. Input from a parked terminal has nowhere to go.
      live.sendInput = () => {}
      live.mounted = false
      live.lastUsedAt = Date.now()
      live.host.remove()
      terminalRef.current = null
    }
  }, [scrollback, socket, terminalId, terminalTheme, webglRenderer])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.scrollback = scrollback
  }, [scrollback])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.theme = withSurfaceBackground(terminalTheme, containerRef.current)
    refreshTerminal(terminal)
  }, [terminalTheme])

  useEffect(() => {
    if (focusRequestVersion === 0) return

    const terminal = terminalRef.current
    if (!terminal) return

    requestAnimationFrame(() => {
      terminal.focus()
    })
  }, [focusRequestVersion])

  useEffect(() => {
    if (clearVersion === 0) return

    const terminal = terminalRef.current
    if (!terminal) return

    hasCreatedRef.current = false
    createAttemptRef.current += 1
    lastAppliedSnapshotKeyRef.current = null
    replayStateRef.current = null
    setMetadata(null)
    setError(null)
    terminal.reset()
    refreshTerminal(terminal)
    void socket.command({
      type: "terminal.close",
      terminalId,
    }).catch((commandError) => {
      setError(commandError instanceof Error ? commandError.message : String(commandError))
    })
  }, [clearVersion, socket, terminalId])

  useEffect(() => {
    onPathChange?.(metadata?.cwd ?? null)
  }, [metadata?.cwd, onPathChange])

  useEffect(() => {
    const applySnapshot = (snapshot: TerminalSnapshot) => {
      const terminal = terminalRef.current
      if (!terminal) return false
      const nextMetadata = {
        cwd: snapshot.cwd,
        shell: snapshot.shell,
        status: snapshot.status,
        exitCode: snapshot.exitCode,
      } satisfies Pick<TerminalSnapshot, "cwd" | "shell" | "status" | "exitCode">
      const snapshotKey = JSON.stringify({
        cwd: snapshot.cwd,
        shell: snapshot.shell,
        cols: snapshot.cols,
        rows: snapshot.rows,
        scrollback: snapshot.scrollback,
        status: snapshot.status,
        exitCode: snapshot.exitCode,
        serializedState: snapshot.serializedState,
      })
      if (lastAppliedSnapshotKeyRef.current === snapshotKey) {
        setMetadata((current) => sameTerminalMetadata(current, nextMetadata) ? current : nextMetadata)
        replayStateRef.current = snapshot.serializedState || null
        return false
      }
      lastAppliedSnapshotKeyRef.current = snapshotKey
      setMetadata((current) => sameTerminalMetadata(current, nextMetadata) ? current : nextMetadata)
      replayStateRef.current = snapshot.serializedState || null
      terminal.options.scrollback = snapshot.scrollback
      terminal.reset()
      if (snapshot.serializedState) {
        terminal.write(snapshot.serializedState)
      }
      refreshTerminal(terminal)
      return true
    }

    const ensureSession = () => {
      const terminal = terminalRef.current
      const element = containerRef.current
      if (!terminal || !element) return
      const size = getMeasuredTerminalSize(terminal, element) ?? getTerminalSize(terminal)
      terminal.resize(size.cols, size.rows)
      lastSizeRef.current = size
      void socket.command({
        type: "terminal.create",
        projectId,
        terminalId,
        cols: size.cols,
        rows: size.rows,
        scrollback,
      }).then((snapshot) => {
        hasCreatedRef.current = true
        setError(null)
        if (snapshot) {
          applySnapshot(snapshot as TerminalSnapshot)
        }
        if (initialCommand && sentInitialCommandRef.current !== initialCommand) {
          sentInitialCommandRef.current = initialCommand
          sendInput(`${initialCommand}\r`)
          onInitialCommandSent?.(terminalId)
        }
        scheduleResizeSync()
      }).catch((commandError) => {
        setError(commandError instanceof Error ? commandError.message : String(commandError))
      })
    }

    const scheduleSessionCreate = () => {
      const attempt = ++createAttemptRef.current
      const run = () => {
        if (createAttemptRef.current !== attempt) return
        const terminal = terminalRef.current
        const element = containerRef.current
        if (!terminal || !element) return

        syncTerminalSize(terminal, element, lastSizeRef, false, () => {})
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) {
          requestAnimationFrame(run)
          return
        }

        ensureSession()
      }

      requestAnimationFrame(() => {
        requestAnimationFrame(run)
      })
    }

    scheduleSessionCreate()

    return socket.subscribeTerminal(terminalId, {
      onSnapshot: (snapshot) => {
        if (!snapshot) {
          hasCreatedRef.current = false
          lastAppliedSnapshotKeyRef.current = null
          if (connectionStatus === "connected") {
            scheduleSessionCreate()
          }
          return
        }
        hasCreatedRef.current = true
        setError(null)
        if (applySnapshot(snapshot)) {
          scheduleResizeSync()
        }
      },
      onEvent: (event) => {
        const terminal = terminalRef.current
        if (!terminal) return
        if (event.type === "terminal.output") {
          terminal.write(event.data)
          return
        }
        if (event.type === "terminal.exit") {
          setMetadata((current) => ({
            cwd: current?.cwd ?? "",
            shell: current?.shell ?? "",
            status: "exited",
            exitCode: event.exitCode,
          }))
        }
      },
    })
  }, [connectionStatus, initialCommand, onInitialCommandSent, projectId, scrollback, socket, terminalId])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pb-4">
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden px-3 py-1">
        <div ref={containerRef} className="kanna-terminal min-h-0 min-w-0 flex-1 overflow-hidden w-full" />
      </div>
      {error ? <div className="px-3 py-1 text-xs text-destructive">Terminal error: {error}</div> : null}
    </div>
  )
}
