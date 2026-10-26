import type { ClientEnvelope, ServerEnvelope } from "../shared/protocol"
import type { AppThemePreference, ChatAttachment } from "../shared/types"
import { DEMO_UNAVAILABLE_MESSAGE, DemoBackend, type DemoClock } from "./backend"

/**
 * Puts the browser in a state where the real Kanna client runs with no
 * server. Imported for its side effects before anything from the client, so
 * every module sees the fakes from its very first line: zustand's `persist`
 * reads storage while its module evaluates, and the socket reads
 * `WebSocket` when it connects.
 */

// Enough delay that the client sees a round trip, not a synchronous reply,
// so ordering matches the real socket (ack before the snapshot it causes).
const LATENCY_MS = 8

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, String(value))
  }
}

// Every visit starts from the same demo. Real storage would carry one visit's
// sidebar layout and drafts into the next, and would mix the app's keys into
// kanna.sh's own storage.
function installMemoryStorage() {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      Object.defineProperty(window, name, { value: new MemoryStorage(), configurable: true })
    } catch {
      // The real storage stays; the demo still works, it just remembers.
    }
  }
  try {
    // The transcript cache skips itself when IndexedDB is missing.
    Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true })
  } catch {
    // Same as above.
  }
}

export function readThemeParam(): AppThemePreference {
  const theme = new URLSearchParams(window.location.search).get("theme")
  return theme === "light" || theme === "system" ? theme : "dark"
}

let backend: DemoBackend | null = null
let openSocket: DemoWebSocket | null = null

/**
 * Hooks for the parity harness (src/parity), which runs the React and the
 * Foldkit client on this same fake backend. `clock` drives the scripted
 * turns, so a test can hold them still; `onClientEnvelope` and
 * `onServerEnvelope` see every frame. Must be called before the first socket
 * opens. The demo itself never calls it.
 */
export interface DemoEnvironmentOptions {
  clock?: DemoClock
  onClientEnvelope?: (envelope: ClientEnvelope) => void
  onServerEnvelope?: (envelope: ServerEnvelope) => void
}

let environmentOptions: DemoEnvironmentOptions = {}

export function configureDemoEnvironment(options: DemoEnvironmentOptions) {
  if (backend) throw new Error("configureDemoEnvironment must run before the first socket opens")
  environmentOptions = options
}

function getBackend() {
  if (!backend) {
    backend = new DemoBackend((envelope: ServerEnvelope) => {
      const socket = openSocket
      if (!socket) return
      const data = JSON.stringify(envelope)
      window.setTimeout(() => {
        environmentOptions.onServerEnvelope?.(envelope)
        socket.deliver(data)
      }, LATENCY_MS)
    }, environmentOptions.clock, { theme: readThemeParam() })
    backend.start()
  }
  return backend
}

class DemoWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  readyState: number = DemoWebSocket.CONNECTING
  readonly url: string
  readonly protocol = ""
  readonly extensions = ""
  binaryType: BinaryType = "blob"
  bufferedAmount = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    window.setTimeout(() => {
      if (this.readyState !== DemoWebSocket.CONNECTING) return
      this.readyState = DemoWebSocket.OPEN
      openSocket = this
      getBackend()
      this.fire(new Event("open"))
    }, LATENCY_MS)
  }

  send(data: string) {
    if (this.readyState !== DemoWebSocket.OPEN) return
    const envelope = JSON.parse(data) as ClientEnvelope
    environmentOptions.onClientEnvelope?.(envelope)
    window.setTimeout(() => getBackend().receive(envelope), LATENCY_MS)
  }

  close() {
    if (this.readyState === DemoWebSocket.CLOSED) return
    this.readyState = DemoWebSocket.CLOSED
    if (openSocket === this) openSocket = null
    // The next socket resubscribes under the same ids, so the backend keeps
    // its subscriptions; pushes meanwhile go nowhere, as they would on a
    // real dropped connection.
    this.fire(new CloseEvent("close", { code: 1000, wasClean: true }))
  }

  deliver(data: string) {
    if (this.readyState !== DemoWebSocket.OPEN) return
    this.fire(new MessageEvent("message", { data }))
  }

  private fire(event: Event) {
    this.dispatchEvent(event)
    const handler = event.type === "open" ? this.onopen
      : event.type === "message" ? this.onmessage
        : event.type === "close" ? this.onclose
          : this.onerror
    ;(handler as ((event: Event) => void) | null)?.(event)
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

// Files attached in the composer, kept for the visit: the server's
// /api/projects/:id/uploads, in memory. Keyed by "<projectId>/<storedName>".
const uploads = new Map<string, Blob>()
let uploadCount = 0

async function receiveUpload(projectId: string, body: BodyInit | null | undefined) {
  const localPath = getBackend().projectLocalPath(projectId)
  if (!localPath) return jsonResponse({ error: "Project not found" }, 404)
  const files = body instanceof FormData ? body.getAll("files").filter((value): value is File => value instanceof File) : []
  if (files.length === 0) return jsonResponse({ error: "No files uploaded", stage: "read-files" }, 400)
  const attachments: ChatAttachment[] = files.map((file) => {
    uploadCount += 1
    // As the server names a second upload of the same file: name-1.ext.
    const dot = file.name.lastIndexOf(".")
    const base = dot > 0 ? file.name.slice(0, dot) : file.name
    const extension = dot > 0 ? file.name.slice(dot) : ""
    let storedName = file.name
    for (let counter = 1; uploads.has(`${projectId}/${storedName}`); counter++) storedName = `${base}-${counter}${extension}`
    uploads.set(`${projectId}/${storedName}`, file)
    const mimeType = file.type || "application/octet-stream"
    return {
      id: `demo-upload-${uploadCount}`,
      kind: mimeType.startsWith("image/") ? "image" : "file",
      displayName: file.name,
      absolutePath: `${localPath}/.kanna/uploads/${storedName}`,
      relativePath: `./.kanna/uploads/${storedName}`,
      contentUrl: `/api/projects/${projectId}/uploads/${encodeURIComponent(storedName)}/content`,
      mimeType,
      size: file.size,
    }
  })
  return jsonResponse({ attachments })
}

function answerUploads(url: URL, method: string, body: BodyInit | null | undefined) {
  const upload = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads$/)
  if (upload && method === "POST") return receiveUpload(decodeURIComponent(upload[1]!), body)
  const stored = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads\/([^/]+?)(\/content)?$/)
  if (!stored) return null
  const key = `${decodeURIComponent(stored[1]!)}/${decodeURIComponent(stored[2]!)}`
  if (stored[3] && method === "GET") {
    const file = uploads.get(key)
    return file
      ? new Response(file, { headers: { "Content-Type": file.type || "application/octet-stream" } })
      : jsonResponse({ error: "Attachment not found" }, 404)
  }
  if (!stored[3] && method === "DELETE") {
    uploads.delete(key)
    return new Response(null, { status: 204 })
  }
  return null
}

// The demo is served from kanna.sh, so its same-origin /api and /auth calls
// would otherwise reach the site's own worker. Answer them here instead, and
// skip GitHub lookups for the made-up repos.
function installFetchShim() {
  const realFetch = window.fetch.bind(window)
  const demoFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const url = new URL(href, window.location.href)
    if (url.origin === window.location.origin) {
      if (url.pathname === "/auth/status") return jsonResponse({ enabled: false, authenticated: true })
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
      const upload = answerUploads(url, method, init?.body)
      if (upload) return upload
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname === "/health") {
        return jsonResponse({ error: DEMO_UNAVAILABLE_MESSAGE }, 404)
      }
    }
    if (url.hostname === "api.github.com") return jsonResponse({ message: "Not Found" }, 404)
    return realFetch(input, init)
  }
  window.fetch = demoFetch as typeof window.fetch
}

// Inside an iframe, focus() and scrollIntoView() scroll the parent page to
// the frame, and a focused composer would take the space bar from a visitor
// who is only scrolling the homepage. The app focuses the composer on load,
// so both wait for the visitor to touch the demo first.
function installEmbedGuards() {
  if (window.top === window) return
  let interacted = false
  const markInteracted = () => {
    interacted = true
  }
  for (const type of ["pointerdown", "keydown", "touchstart"]) {
    window.addEventListener(type, markInteracted, { capture: true, once: true })
  }
  const focus = HTMLElement.prototype.focus
  HTMLElement.prototype.focus = function guardedFocus(this: HTMLElement, options?: FocusOptions) {
    if (!interacted) return
    focus.call(this, options)
  }
  const scrollIntoView = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function guardedScrollIntoView(this: Element, arg?: boolean | ScrollIntoViewOptions) {
    if (!interacted) return
    scrollIntoView.call(this, arg)
  }
}

installMemoryStorage()
installFetchShim()
installEmbedGuards()
Object.defineProperty(window, "WebSocket", { value: DemoWebSocket, configurable: true, writable: true })
