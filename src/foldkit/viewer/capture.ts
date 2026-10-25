import { cssColorAlpha, isPngSignature } from "../../shared/visualization-capture"

// The frame's page, drawn as a PNG (`shared/visualization-capture`):
// Visualization.tsx's capture, which VisualizationFullView started on the
// Download image / Mark up click, so the file is ready by the time its name
// is confirmed. The frame lives in the transcript rows' Mount; this asks it
// through the window, as React's did, and keeps each capture under an id for
// the dialog that waits on it.

const CAPTURE_TIMEOUT_MS = 30_000
/** A PNG of a page is a few MB; past this the frame is answering with something else. */
const CAPTURE_MAX_BYTES = 128 * 1024 * 1024

const captures = new Map<string, Promise<Blob>>()
let lastCapture = 0

/** The first opaque background behind the frame, which the capture is drawn over. */
function backdropColor(element: Element | null): string | undefined {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor
    if (cssColorAlpha(color) >= 1) return color
  }
  return undefined
}

/** Starts a capture of the visualization in the open card; its id names it for `captureOf`. */
export function startCapture(): string {
  const id = `viewer-capture-${++lastCapture}`
  const frame = document.querySelector<HTMLIFrameElement>("[data-viewer-surface] iframe")
  const promise = new Promise<Blob>((resolve, reject) => {
    const target = frame?.contentWindow
    if (!frame || !target) return reject(new Error("The visualization has not loaded yet."))
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage)
      reject(new Error("The visualization did not finish drawing."))
    }, CAPTURE_TIMEOUT_MS)
    function onMessage(event: MessageEvent) {
      if (event.source !== target || event.data?.type !== "kanna:captured" || event.data.id !== id) return
      window.removeEventListener("message", onMessage)
      window.clearTimeout(timer)
      const png: unknown = event.data.png
      if (!(png instanceof Blob) || png.size > CAPTURE_MAX_BYTES) {
        reject(new Error(typeof event.data.error === "string" ? event.data.error.slice(0, 200) : "The visualization could not be drawn."))
        return
      }
      void png.slice(0, 8).arrayBuffer().then((head) => {
        if (isPngSignature(new Uint8Array(head))) resolve(new Blob([png], { type: "image/png" }))
        else reject(new Error("The visualization did not draw a PNG."))
      }, () => reject(new Error("The visualization could not be drawn.")))
    }
    window.addEventListener("message", onMessage)
    target.postMessage({ type: "kanna:capture", id, background: backdropColor(frame) }, "*")
  })
  promise.catch(() => {})
  captures.set(id, promise)
  return id
}

export function captureOf(id: string): Promise<Blob> {
  return captures.get(id) ?? Promise.reject(new Error("The visualization could not be drawn."))
}

export function dropCapture(id: string) {
  captures.delete(id)
}
