import { Schema } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { saveFile } from "../../../client/lib/visualization-image"
import {
  fetchVisualizationHeights,
  pickVisualizationHeight,
  recordVisualizationHeight,
  rememberedVisualizationHeights,
  rememberVisualizationHeights,
} from "../../../client/lib/visualization-heights"
import {
  VISUALIZATION_EXPAND_BUTTON,
  visualizationDownload,
  visualizationHeight,
  visualizationLink,
  visualizationWidthBucket,
  type VisualizationArtifact,
  type VisualizationHeights,
} from "../../../shared/visualization"
import { prepareVisualizationDocument, type VisualizationTheme } from "../../../shared/visualization-host"
import { Maximize2 } from "../../ui/icons"
import { domStream } from "../../ui/overlay/stream"
import * as Tooltip from "../../ui/tooltip"
import type { RowContext } from "./context"
import { frameOf, Message, tooltipOf } from "./model"

/**
 * Visualization.tsx, inline: the saved document in its sandboxed frame, as
 * tall as its content, with Expand over its top-right corner once it has
 * loaded. The frame's state (document, width, heights, loaded) is the
 * Model's (`frames[key]`); everything that talks to the frame (the fetch,
 * the width, the page's messages, the theme) is the `VisualizationFrame`
 * Mount on its box. Expand opens it in the viewer, expanded.
 *
 * The frame starts at the height the page last measured at this width, in
 * this browser or another (`lib/visualization-heights`), and holds that box
 * while the document loads, so nothing under it moves when the page comes
 * in. With none measured it starts at the height the agent declared.
 */

/** Read actual host tokens, rather than deriving dark mode from the OS. Copied from Visualization.tsx. */
export function visualizationTheme(): VisualizationTheme {
  const root = document.documentElement
  const styles = getComputedStyle(root)
  const variables: Record<string, string> = {}
  variables["--font-sans"] = getComputedStyle(document.body).fontFamily
  for (const name of ["background", "foreground", "muted", "muted-foreground", "border"]) {
    const value = styles.getPropertyValue(`--${name}`).trim()
    if (value) variables[`--${name}`] = `hsl(${value})`
  }
  const surface = styles.getPropertyValue("--popover").trim()
  if (surface) variables["--surface"] = `hsl(${surface})`
  for (const name of ["red", "green", "blue", "yellow", "orange", "purple", "pink", "teal"]) {
    const value = styles.getPropertyValue(`--viz-${name}`).trim()
    if (value) variables[`--viz-${name}`] = value
  }
  return { appearance: root.classList.contains("dark") ? "dark" : "light", variables }
}

/** A page is still for this long before its height is taken as the one it settled at. */
const SETTLE_MS = 400
/** After this long loaded, a change of height is the reader's doing (a row opened, a toggle), not the page's. */
const SETTLED_FOR_GOOD_MS = 5000

/**
 * On the frame's box: everything React's VisualizationFrame did in effects.
 * It keeps its own copy of what the handlers read (width, measured, known),
 * as React's `live` ref did; it is the only writer of `known` besides the
 * Model's start, so the two agree.
 */
export const VisualizationFrame = Mount.defineStream("VisualizationFrame", {
  args: { key: Schema.String, url: Schema.String, declared: Schema.Number, reportsEscape: Schema.Boolean },
  messages: [Message.MeasuredFrameWidth, Message.KnewFrameHeights, Message.GotFrameDocument, Message.FailedFrameDocument, Message.ResizedFrame, Message.LoadedFrame, Message.PressedEscapeInFrame],
  execute: ({ element, key, url, declared, reportsEscape }) =>
    domStream<
      | typeof Message.PressedEscapeInFrame.Type
      | typeof Message.MeasuredFrameWidth.Type
      | typeof Message.KnewFrameHeights.Type
      | typeof Message.GotFrameDocument.Type
      | typeof Message.FailedFrameDocument.Type
      | typeof Message.ResizedFrame.Type
      | typeof Message.LoadedFrame.Type
    >((emit) => {
      const box = element as HTMLElement
      const controller = new AbortController()
      const live = {
        width: undefined as number | undefined,
        measured: undefined as number | undefined,
        known: rememberedVisualizationHeights(url) as VisualizationHeights,
        loadedAt: 0,
        recordedBucket: 0,
        askedServer: false,
      }
      let settleTimer: number | undefined
      if (live.known.length > 0) emit(Message.KnewFrameHeights({ key, heights: [...live.known] }))

      const frame = () => box.querySelector("iframe")
      const syncTheme = () => {
        const iframe = frame()
        if (!iframe) return
        const theme = visualizationTheme()
        iframe.style.colorScheme = theme.appearance
        iframe.contentWindow?.postMessage({ type: "kanna:theme", theme }, "*")
      }

      // Another browser may have measured this width. Asked once, and only when this one has not.
      const askServer = () => {
        const width = live.width
        if (live.askedServer || width === undefined) return
        live.askedServer = true
        if (live.known.some(([measuredWidth]) => measuredWidth === visualizationWidthBucket(width))) return
        void fetchVisualizationHeights(url, controller.signal).then((fromServer) => {
          if (controller.signal.aborted || fromServer.length === 0) return
          // What this browser measured itself stands; the server fills in the other widths.
          const own = new Set(live.known.map(([measuredWidth]) => measuredWidth))
          const merged = [...live.known, ...fromServer.filter(([measuredWidth]) => !own.has(measuredWidth))].sort((left, right) => left[0] - right[0])
          rememberVisualizationHeights(url, merged)
          live.known = merged
          emit(Message.KnewFrameHeights({ key, heights: merged }))
        })
      }

      const measure = (width: number) => {
        if (live.width === width) return
        live.width = width
        emit(Message.MeasuredFrameWidth({ key, width }))
        askServer()
      }
      measure(box.clientWidth)
      const resize = typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(([entry]) => { if (entry) measure(entry.contentRect.width) })
      resize?.observe(box)

      fetch(url, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error("Visualization unavailable")
        const [html, { visualizationFontCss }] = await Promise.all([response.text(), import("../../../client/components/messages/visualization-fonts")])
        if (!controller.signal.aborted) emit(Message.GotFrameDocument({ key, document: prepareVisualizationDocument(html, visualizationTheme(), visualizationFontCss) }))
      }).catch(() => { if (!controller.signal.aborted) emit(Message.FailedFrameDocument({ key })) })

      // The frame arrives with the document; it takes the page's scheme before it paints.
      const children = new MutationObserver(() => {
        const iframe = frame()
        if (iframe && !iframe.style.colorScheme) iframe.style.colorScheme = visualizationTheme().appearance
      })
      children.observe(box, { childList: true })

      // Load doesn't bubble; a capturing listener on the box still hears it.
      const onLoad = (event: Event) => {
        const iframe = frame()
        if (!iframe || event.target !== iframe) return
        live.loadedAt = performance.now()
        iframe.contentWindow?.postMessage({ type: "kanna:theme", theme: visualizationTheme() }, "*")
        emit(Message.LoadedFrame({ key }))
      }
      box.addEventListener("load", onLoad, true)

      const onMessage = (event: MessageEvent) => {
        const iframe = frame()
        if (!iframe?.contentWindow || event.source !== iframe.contentWindow) return
        if (event.data?.type === "kanna:ready") syncTheme()
        // A key pressed in the frame is the frame's; it hands Escape back when it has no use for it.
        if (event.data?.type === "kanna:escape" && reportsEscape) emit(Message.PressedEscapeInFrame({ key, repeat: event.data.repeat === true }))
        if (event.data?.type === "kanna:resize") {
          const next = visualizationHeight(event.data.height)
          // The shell opens by reporting the declared height, before the page
          // has measured anything. Taken as a measurement, it would move a
          // frame that started at its real height away from it and back.
          const opening = next === declared && live.measured === undefined
            && live.width !== undefined && pickVisualizationHeight(live.known, live.width) !== null
          if (next === null || opening) return
          live.measured = next
          emit(Message.ResizedFrame({ key, height: next }))
          window.clearTimeout(settleTimer)
          settleTimer = window.setTimeout(() => {
            const { width, loadedAt, recordedBucket, known } = live
            if (width === undefined || loadedAt === 0) return
            const bucket = visualizationWidthBucket(width)
            if (recordedBucket === bucket && performance.now() - loadedAt > SETTLED_FOR_GOOD_MS) return
            live.recordedBucket = bucket
            const recorded = recordVisualizationHeight(url, known, width, next)
            if (recorded !== known) {
              live.known = recorded
              emit(Message.KnewFrameHeights({ key, heights: [...recorded] }))
            }
          }, SETTLE_MS)
        }
        if (event.data?.type === "kanna:download") {
          const download = visualizationDownload(event.data.download)
          if (download) saveFile(new Blob([download.content], { type: download.mimeType }), download.filename)
        }
        if (event.data?.type === "kanna:link") {
          const link = visualizationLink(event.data.url)
          if (link) window.open(link, "_blank", "noopener,noreferrer")
        }
      }
      window.addEventListener("message", onMessage)
      const themeObserver = new MutationObserver(syncTheme)
      themeObserver.observe(window.document.documentElement, { attributes: true, attributeFilter: ["class", "style"] })

      return () => {
        controller.abort()
        window.clearTimeout(settleTimer)
        resize?.disconnect()
        children.disconnect()
        themeObserver.disconnect()
        box.removeEventListener("load", onLoad, true)
        window.removeEventListener("message", onMessage)
      }
    }),
})

/**
 * The frame, bare, with its loading line until the document is in. `key`
 * names its state in the Model. With `reportsEscape` (the viewer's full
 * size), Escape pressed in the frame and unused by it comes back as the
 * `EscapedVisualization` OutMessage, for the viewer to close on.
 */
export function visualizationFrame(key: string, artifact: VisualizationArtifact, options: { reportsEscape?: boolean }, context: RowContext, h: HtmlBuilder<Message>): Html {
  const frame = frameOf(context.model, key)
  if (frame.failed) return h.p([h.Role("alert"), h.Class("text-sm text-muted-foreground")], ["This visualization could not be loaded."])
  const height = frame.measured ?? (frame.width === null ? null : pickVisualizationHeight(frame.known, frame.width)) ?? artifact.height
  return h.div([
    h.Class("min-w-0"),
    h.Style({ height: `${height}px` }),
    h.OnMount(VisualizationFrame({ key, url: artifact.url, declared: artifact.height, reportsEscape: options.reportsEscape ?? false })),
  ], [
    frame.document !== null
      ? h.iframe([
        h.Title(artifact.title),
        h.Attribute("srcdoc", frame.document),
        h.Attribute("sandbox", "allow-scripts"),
        h.Attribute("referrerpolicy", "no-referrer"),
        h.Class("block size-full min-w-0 border-0 bg-transparent"),
      ])
      : h.p([h.Class("text-sm text-muted-foreground")], ["Loading visualization..."]),
  ])
}

/**
 * A visualization in the transcript: the frame, bare, as part of the reply,
 * with the way to full size over its top-right corner. The tool description
 * tells whoever writes one to keep that corner clear.
 */
export function visualization(key: string, artifact: VisualizationArtifact, context: RowContext, h: HtmlBuilder<Message>): Html {
  const loaded = frameOf(context.model, key).loaded
  return h.div([h.Class("visualization relative min-w-0")], [
    visualizationFrame(key, artifact, {}, context, h),
    loaded ? visualizationExpandButton(key, Message.ClickedExpandVisualization({ artifact }), context, h) : null,
  ])
}

/**
 * Opaque, so it reads over whatever the chart has drawn under it, in either
 * theme. The glyph is 14px, not the 16px of the viewer's square buttons: its
 * arrows point at the corners, which a circle does not have.
 */
export function visualizationExpandButton(key: string, onClick: Message, context: RowContext, h: HtmlBuilder<Message>): Html {
  const { size, inset } = VISUALIZATION_EXPAND_BUTTON
  return h.submodel({
    slotId: `visualization-expand-${key}`,
    model: tooltipOf(context.model, key),
    view: Tooltip.view,
    viewInputs: {
      content: () => ["Expand"],
      toView: ({ trigger, portal }) => h.button([
        ...trigger,
        h.Type("button"),
        h.AriaLabel("Expand"),
        h.OnClick(onClick),
        h.Style({ top: `${inset}px`, right: `${inset}px`, width: `${size}px`, height: `${size}px` }),
        h.Class("visualization-expand absolute flex items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-xs hover:bg-muted hover:text-foreground [&_svg]:size-3.5"),
      ], [Maximize2({}, h), portal]),
    },
    toParentMessage: (message: Tooltip.Message) => Message.GotTooltipMessage({ key, message }),
  })
}
