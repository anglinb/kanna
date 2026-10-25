import type { ITheme, ITerminalOptions, Terminal } from "@xterm/xterm"
import type { TerminalSnapshot } from "../../shared/protocol"

// The pure helpers of src/client/components/chat-ui/TerminalPane.tsx, copied
// (that file is React): xterm's themes and options, the Mac key sequences,
// and how a pane measures and sizes its terminal.

export const TERMINAL_THEME_LIGHT: ITheme = {
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

export const TERMINAL_THEME_DARK: ITheme = {
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

export function withSurfaceBackground(theme: ITheme, element: Element | null): ITheme {
  const background = resolveSurfaceBackground(element)
  return background ? { ...theme, background } : theme
}

export function getTerminalSize(terminal: Terminal) {
  return {
    cols: Math.max(1, terminal.cols || 80),
    rows: Math.max(1, terminal.rows || 24),
  }
}

export function getMeasuredTerminalSize(terminal: Terminal, container: HTMLElement) {
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

export function refreshTerminal(terminal: Terminal) {
  terminal.refresh(0, Math.max(0, terminal.rows - 1))
}

export function sameTerminalMetadata(
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

export function syncTerminalSize(
  terminal: Terminal,
  container: HTMLElement,
  lastSizeRef: { current: { cols: number; rows: number } | null },
  hasCreated: boolean,
  sendResize: (cols: number, rows: number) => void
) {
  // A collapsed or parked pane measures as 0x0. Sizing the terminal (and the
  // PTY behind it) to 2x1 for that reflowed every line into two columns; the
  // real size arrives with the next resize once the pane is shown.
  if (container.getBoundingClientRect().height <= 0) {
    return lastSizeRef.current ?? getTerminalSize(terminal)
  }
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
