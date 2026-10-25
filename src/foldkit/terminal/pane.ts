import { SerializeAddon } from "@xterm/addon-serialize"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { WebglAddon } from "@xterm/addon-webgl"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Terminal } from "@xterm/xterm"
import type { KannaSocket, SocketStatus } from "../../client/app/socket"
import type { TerminalSnapshot, TerminalTailResult } from "../../shared/protocol"
import { lentSocket, withSocket } from "./socketBridge"
import {
  getMacOptionInputSequence,
  getMeasuredTerminalSize,
  getTerminalOptions,
  getTerminalSize,
  refreshTerminal,
  sameTerminalMetadata,
  syncTerminalSize,
  TERMINAL_THEME_DARK,
  TERMINAL_THEME_LIGHT,
  withSurfaceBackground,
} from "./xterm"

// TerminalPane (src/client/components/chat-ui/TerminalPane.tsx) without
// React: one xterm per pane, its server session and its output. The pane's
// Mount (index.ts) makes a controller on the `.kanna-terminal` element and
// hands it the pane's props as they change; the controller runs what
// TerminalPane's effects ran, on the same dependencies and in the same order,
// so the commands the server sees are the same.

export interface PaneInputs {
  /** null → a home-directory terminal (dev-box full-screen Terminal page). */
  projectId: string | null
  scrollback: number
  theme: "light" | "dark"
  webglRenderer: boolean
  connectionStatus: SocketStatus
  initialCommand: string | null
  clearVersion: number
  focusRequestVersion: number
}

/** What TerminalPane told its parent: its callbacks and the state it rendered. */
export interface PaneEvents {
  pathChanged: (path: string | null) => void
  errorChanged: (error: string | null) => void
  commandSent: () => void
  initialCommandSent: () => void
}

type Metadata = Pick<TerminalSnapshot, "cwd" | "shell" | "status" | "exitCode">

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
  /**
   * The pane holding it. React ran every unmount cleanup of a commit before
   * any mount effect; Foldkit's Mounts usually keep that order, but a pane
   * that lost its terminal to a newer one must not park it from under it.
   */
  owner: TerminalPaneController | null
  lastUsedAt: number
  sendInput: (data: string) => void
}

/** Browsers cap live WebGL contexts around 16; stay well under it. */
const TERMINAL_CACHE_LIMIT = 8

const terminalCache = new Map<string, CachedTerminal>()

/**
 * Where a parked terminal's DOM waits, still in the document.
 *
 * A host taken out of the document entirely came back frozen: once shown
 * again the pane parsed output but never painted. Kept in a `display: none`
 * holder instead, xterm's own visibility observer sees one continuous
 * hidden-then-shown transition, and the WebGL canvas is never a detached
 * canvas that the browser may decide to drop.
 */
let parkingLot: HTMLDivElement | null = null

function getParkingLot(): HTMLDivElement {
  if (!parkingLot) {
    parkingLot = document.createElement("div")
    parkingLot.style.display = "none"
    parkingLot.setAttribute("data-kanna-parked-terminals", "")
    document.body.appendChild(parkingLot)
  }
  return parkingLot
}

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

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// Each effect's dependencies, as TerminalPane listed them (the socket and
// the terminal id never change for a controller).
const TERMINAL_EFFECT_DEPS = ["scrollback", "theme", "webglRenderer"] as const
const SESSION_EFFECT_DEPS = ["connectionStatus", "initialCommand", "projectId", "scrollback"] as const

function changed(next: PaneInputs, previous: PaneInputs | null, keys: ReadonlyArray<keyof PaneInputs>) {
  return previous === null || keys.some((key) => next[key] !== previous[key])
}

export class TerminalPaneController {
  // Whether the pane has any height. A collapsed terminal panel keeps its
  // panes mounted at 0% (reopening returns to the same shell), and a parked
  // pane sits in a hidden holder, so mounting says nothing about being seen.
  // Measured by the pane's own ResizeObserver rather than read from the
  // layout store: the store has to be keyed exactly right for every pane,
  // and a pane that reads "hidden" for good drops output for good.
  private visible = false
  /** Output count xterm has been fed up to; what `terminal.tail` resumes from. */
  private writtenVersion: number | null = null
  /** Events that land while a catch-up is in flight, replayed after it. */
  private catchUpQueue: Array<{ data: string; version?: number }> | null = null
  /** Resync after the pane is shown. Bound by the session effect, which owns `applySnapshot`. */
  private catchUp: () => void = () => {}
  private terminal: Terminal | null = null
  private replayState: string | null = null
  private hasCreated = false
  private createAttempt = 0
  private lastAppliedSnapshotKey: string | null = null
  private sentInitialCommand: string | null = null
  private readonly lastSize: { current: { cols: number; rows: number } | null } = { current: null }
  private metadata: Metadata | null = null
  private error: string | null = null
  private inputs: PaneInputs | null = null
  private terminalEffectCleanup: (() => void) | null = null
  private sessionEffectCleanup: (() => void) | null = null
  private disposed = false

  constructor(
    private readonly container: HTMLElement,
    private readonly terminalId: string,
    private readonly events: PaneEvents,
  ) {}

  /** Mount, or new props: what React's effects ran for this render, in their order. */
  apply(next: PaneInputs) {
    if (this.disposed) return
    const previous = this.inputs
    this.inputs = next
    const terminalEffect = changed(next, previous, TERMINAL_EFFECT_DEPS)
    const sessionEffect = changed(next, previous, SESSION_EFFECT_DEPS)

    // Cleanups of the effects that re-run, then the effects, in order.
    if (terminalEffect) this.terminalEffectCleanup?.()
    if (sessionEffect) this.sessionEffectCleanup?.()

    if (changed(next, previous, ["initialCommand"])) this.sentInitialCommand = null
    if (terminalEffect) this.terminalEffectCleanup = this.runTerminalEffect(next)
    if (changed(next, previous, ["scrollback"]) && this.terminal) this.terminal.options.scrollback = next.scrollback
    if (changed(next, previous, ["theme"]) && this.terminal) {
      this.terminal.options.theme = withSurfaceBackground(this.terminalTheme(next), this.container)
      refreshTerminal(this.terminal)
    }
    if (changed(next, previous, ["focusRequestVersion"])) this.runFocusEffect(next.focusRequestVersion)
    // TerminalWorkspace's clear counts started at 0 with each mount, and the
    // effect skipped 0. The slice's counts outlive the panes, so the count a
    // pane mounts with is its zero.
    if (previous !== null && changed(next, previous, ["clearVersion"])) this.runClearEffect(next.clearVersion)
    if (previous === null) {
      // A fresh TerminalPane's state: no path yet, no error.
      this.events.pathChanged(this.metadata?.cwd ?? null)
      this.events.errorChanged(null)
    }
    if (sessionEffect) this.sessionEffectCleanup = this.runSessionEffect(next)
  }

  /** Unmount: the effects' cleanups, in order. */
  dispose() {
    if (this.disposed) return
    this.terminalEffectCleanup?.()
    this.sessionEffectCleanup?.()
    this.terminalEffectCleanup = null
    this.sessionEffectCleanup = null
    this.disposed = true
  }

  private terminalTheme(inputs: PaneInputs) {
    return inputs.theme === "dark" ? TERMINAL_THEME_DARK : TERMINAL_THEME_LIGHT
  }

  private setMetadata(update: (current: Metadata | null) => Metadata | null) {
    const next = update(this.metadata)
    const previousCwd = this.metadata?.cwd ?? null
    this.metadata = next
    const cwd = next?.cwd ?? null
    if (cwd !== previousCwd && !this.disposed) this.events.pathChanged(cwd)
  }

  private setError(error: string | null) {
    if (error === this.error) return
    this.error = error
    if (!this.disposed) this.events.errorChanged(error)
  }

  private command<Result = unknown>(command: Parameters<KannaSocket["command"]>[0]): Promise<Result> {
    const socket = lentSocket()
    return socket ? socket.command<Result>(command) : Promise.reject(new Error("Not connected"))
  }

  private sendInput = (data: string) => {
    void this.command({
      type: "terminal.input",
      terminalId: this.terminalId,
      data,
    }).catch((commandError) => {
      this.setError(errorText(commandError))
    })
    if (data.includes("\r") || data.includes("\n")) {
      if (!this.disposed) this.events.commandSent()
    }
  }

  private sendResize = (cols: number, rows: number) => {
    void this.command({
      type: "terminal.resize",
      terminalId: this.terminalId,
      cols,
      rows,
    }).catch(() => {})
  }

  private scheduleResizeSync() {
    const sync = () => {
      const terminalInstance = this.terminal
      const element = this.container
      if (!terminalInstance || !element || !this.hasCreated) return
      syncTerminalSize(terminalInstance, element, this.lastSize, true, this.sendResize)
    }

    requestAnimationFrame(() => {
      sync()
      setTimeout(sync, 0)
    })
  }

  // React: useEffect(…, [scrollback, socket, terminalId, terminalTheme, webglRenderer])
  private runTerminalEffect(inputs: PaneInputs): () => void {
    const element = this.container
    const theme = withSurfaceBackground(this.terminalTheme(inputs), element)
    const { scrollback, webglRenderer } = inputs
    const terminalId = this.terminalId

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
      // The addon's default handler opens a blank window and points it at the
      // link afterwards. The Mac app gives blank windows a real in-app popup
      // (for the OpenRouter sign-in), so pass the URL up front and let it go
      // to the browser.
      terminal.loadAddon(new WebLinksAddon((_event, uri) => {
        window.open(uri, "_blank", "noopener,noreferrer")
      }))
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
        owner: null,
        lastUsedAt: Date.now(),
        sendInput: this.sendInput,
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
      if (this.replayState) {
        terminal.write(this.replayState)
      }
      terminalCache.set(terminalId, created)
      cached = created
      evictParkedTerminals()
    }

    const live = cached
    const { terminal, serializeAddon } = live
    live.sendInput = this.sendInput
    live.mounted = true
    live.owner = this
    live.lastUsedAt = Date.now()
    this.terminal = terminal

    element.appendChild(live.host)
    syncTerminalSize(terminal, element, this.lastSize, false, () => {})
    refreshTerminal(terminal)
    this.scheduleResizeSync()
    // Starts hidden: the observer below reports the real size on observe.
    this.visible = false

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (!this.hasCreated) return
      const nextSize = { cols, rows }
      if (this.lastSize.current && this.lastSize.current.cols === cols && this.lastSize.current.rows === rows) {
        return
      }
      this.lastSize.current = nextSize
      this.sendResize(cols, rows)
    })

    const syncVisibility = (observed: HTMLElement) => {
      const shown = observed.getBoundingClientRect().height > 0
      if (shown === this.visible) return
      this.visible = shown
      if (shown) this.catchUp()
    }

    const observer = new ResizeObserver(() => {
      const terminalInstance = this.terminal
      if (!terminalInstance) return
      syncVisibility(element)
      syncTerminalSize(terminalInstance, element, this.lastSize, this.hasCreated, (cols, rows) => {
        void this.command({
          type: "terminal.resize",
          terminalId,
          cols,
          rows,
        }).catch(() => {})
      })
    })

    observer.observe(element)

    return () => {
      observer.disconnect()
      resizeDisposable.dispose()
      this.replayState = serializeAddon.serialize()
      this.terminal = null
      if (live.owner !== this) return
      // Park, do not dispose. Input from a parked terminal has nowhere to go.
      live.sendInput = () => {}
      live.mounted = false
      live.owner = null
      live.lastUsedAt = Date.now()
      getParkingLot().appendChild(live.host)
    }
  }

  // React: useEffect(…, [focusRequestVersion])
  private runFocusEffect(focusRequestVersion: number) {
    if (focusRequestVersion === 0) return

    const terminal = this.terminal
    if (!terminal) return

    requestAnimationFrame(() => {
      terminal.focus()
    })
  }

  // React: useEffect(…, [clearVersion, socket, terminalId])
  private runClearEffect(clearVersion: number) {
    if (clearVersion === 0) return

    const terminal = this.terminal
    if (!terminal) return

    this.hasCreated = false
    this.createAttempt += 1
    this.lastAppliedSnapshotKey = null
    this.replayState = null
    this.setMetadata(() => null)
    this.setError(null)
    terminal.reset()
    refreshTerminal(terminal)
    void this.command({
      type: "terminal.close",
      terminalId: this.terminalId,
    }).catch((commandError) => {
      this.setError(errorText(commandError))
    })
  }

  // React: useEffect(…, [connectionStatus, initialCommand, onInitialCommandSent, projectId, scrollback, socket, terminalId])
  private runSessionEffect(inputs: PaneInputs): () => void {
    let stop: (() => void) | null = null
    const cancelWait = withSocket((socket) => {
      stop = this.startSession(socket, inputs)
    })
    return () => {
      cancelWait()
      stop?.()
    }
  }

  private startSession(socket: KannaSocket, inputs: PaneInputs): () => void {
    const { connectionStatus, initialCommand, projectId, scrollback } = inputs
    const terminalId = this.terminalId

    const applySnapshot = (snapshot: TerminalSnapshot) => {
      const terminal = this.terminal
      if (!terminal) return false
      const nextMetadata = {
        cwd: snapshot.cwd,
        shell: snapshot.shell,
        status: snapshot.status,
        exitCode: snapshot.exitCode,
      } satisfies Metadata
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
      if (this.lastAppliedSnapshotKey === snapshotKey) {
        this.setMetadata((current) => sameTerminalMetadata(current, nextMetadata) ? current : nextMetadata)
        this.replayState = snapshot.serializedState || null
        return false
      }
      this.lastAppliedSnapshotKey = snapshotKey
      this.setMetadata((current) => sameTerminalMetadata(current, nextMetadata) ? current : nextMetadata)
      this.replayState = snapshot.serializedState || null
      terminal.options.scrollback = snapshot.scrollback
      // `write` is queued and asynchronous; `reset()` is not. A reset issued
      // here ran before writes already in the queue (a catch-up tail, live
      // output, the parked buffer) were parsed, so the fresh state landed on
      // top of them and the screen showed everything twice. RIS (`ESC c`) is
      // the same full reset, but the parser applies it in order with the
      // bytes around it, which is the only ordering that holds.
      terminal.write(`\x1bc${snapshot.serializedState ?? ""}`, () => refreshTerminal(terminal))
      this.writtenVersion = snapshot.outputVersion ?? null
      return true
    }

    // Runs on every hidden-to-shown transition, not only when output was
    // seen while hidden: a pane that was parked has no record of what it
    // missed. A tail of nothing costs one small round trip.
    this.catchUp = () => {
      const terminal = this.terminal
      if (!terminal || this.catchUpQueue) return
      // Output that lands while the request is out is held, then whatever the
      // tail already covers is dropped, so nothing is written twice.
      this.catchUpQueue = []
      void socket.command<TerminalTailResult | null>({
        type: "terminal.tail",
        terminalId,
        sinceVersion: this.writtenVersion,
      }).then((result) => {
        if (this.terminal !== terminal) return
        if (result?.tail) {
          // A snapshot pushed while this request was out already painted
          // past the tail's end; writing it again would show that span twice.
          const written = this.writtenVersion
          if (written != null && result.tail.version <= written) return
          if (result.tail.data) terminal.write(result.tail.data)
          this.writtenVersion = result.tail.version
        } else if (result?.snapshot) {
          this.lastAppliedSnapshotKey = null
          applySnapshot(result.snapshot)
        }
      }).catch(() => {
        // The next show, or the next snapshot, tries again.
      }).finally(() => {
        const queued = this.catchUpQueue ?? []
        this.catchUpQueue = null
        if (this.terminal !== terminal) return
        for (const event of queued) {
          const written = this.writtenVersion
          if (event.version != null && written != null && event.version <= written) continue
          terminal.write(event.data)
          if (event.version != null) this.writtenVersion = event.version
        }
        refreshTerminal(terminal)
        this.scheduleResizeSync()
      })
    }

    const ensureSession = () => {
      const terminal = this.terminal
      const element = this.container
      if (!terminal || !element) return
      const size = getMeasuredTerminalSize(terminal, element) ?? getTerminalSize(terminal)
      terminal.resize(size.cols, size.rows)
      this.lastSize.current = size
      void socket.command({
        type: "terminal.create",
        projectId,
        terminalId,
        cols: size.cols,
        rows: size.rows,
        scrollback,
      }).then((snapshot) => {
        this.hasCreated = true
        this.setError(null)
        if (snapshot) {
          applySnapshot(snapshot as TerminalSnapshot)
        }
        if (initialCommand && this.sentInitialCommand !== initialCommand) {
          this.sentInitialCommand = initialCommand
          this.sendInput(`${initialCommand}\r`)
          if (!this.disposed) this.events.initialCommandSent()
        }
        this.scheduleResizeSync()
      }).catch((commandError) => {
        this.setError(errorText(commandError))
      })
    }

    const scheduleSessionCreate = () => {
      const attempt = ++this.createAttempt
      const run = () => {
        if (this.createAttempt !== attempt) return
        const terminal = this.terminal
        const element = this.container
        if (!terminal || !element) return

        syncTerminalSize(terminal, element, this.lastSize, false, () => {})
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

    const unsubscribe = socket.subscribeTerminal(terminalId, {
      onSnapshot: (snapshot) => {
        if (!snapshot) {
          this.hasCreated = false
          this.lastAppliedSnapshotKey = null
          if (connectionStatus === "connected") {
            scheduleSessionCreate()
          }
          return
        }
        this.hasCreated = true
        this.setError(null)
        if (applySnapshot(snapshot)) {
          this.scheduleResizeSync()
        }
      },
      onEvent: (event) => {
        const terminal = this.terminal
        if (!terminal) return
        if (event.type === "terminal.output") {
          // A hidden pane does not parse. xterm would lay out and render
          // every byte for pixels nobody can see; the server keeps the
          // buffer, and the pane asks for the gap when it is shown again.
          if (!this.visible) return
          if (this.catchUpQueue) {
            this.catchUpQueue.push({ data: event.data, version: event.version })
            return
          }
          terminal.write(event.data)
          if (event.version != null) this.writtenVersion = event.version
          return
        }
        if (event.type === "terminal.exit") {
          this.setMetadata((current) => ({
            cwd: current?.cwd ?? "",
            shell: current?.shell ?? "",
            status: "exited",
            exitCode: event.exitCode,
          }))
        }
      },
    })
    return () => {
      this.catchUp = () => {}
      unsubscribe()
    }
  }
}
