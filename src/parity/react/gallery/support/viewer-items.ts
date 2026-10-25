// What the viewer gallery opens (`?item=`), shared by the React page
// (gallery/viewer.tsx) and the Foldkit one (foldkit/gallery/viewer.ts):
// attachments of each kind, a chart and a visualization at full size. Text
// is served from data: URLs, so both apps read the same bytes from any port.
import type { ChartToolPayload } from "../../../../shared/display-tools"
import type { VisualizationArtifact } from "../../../../shared/visualization"
import { CHARTS } from "../../../../foldkit/transcript/messages/fixture"

export const VIEWER_GALLERY_CHAT_ID = "demo-chat-units"

function dataUrl(mimeType: string, text: string) {
  return `data:${mimeType};base64,${btoa(unescape(encodeURIComponent(text)))}`
}

const NOTES = [
  "# Release notes",
  "",
  "The tide chart now reads **feet or meters**, and the choice is kept.",
  "",
  "## What changed",
  "",
  "- `formatHeight` replaces `formatFeet` and takes the unit.",
  "- A toggle beside the height switches it.",
  "- Tests cover both units.",
  "",
  "```ts",
  "export function formatHeight(meters: number, unit: HeightUnit) {",
  "  return unit === \"m\" ? `${meters.toFixed(1)} m` : `${(meters * 3.28084).toFixed(1)} ft`",
  "}",
  "```",
  "",
  "| Unit | Example |",
  "| --- | --- |",
  "| ft | 4.3 ft |",
  "| m | 1.3 m |",
  "",
  "See [the chart](https://example.com/tides) for more.",
].join("\n")

const READINGS = [
  "station,date,height_m,period_s,direction,source",
  "Ocean Beach,2026-05-01,1.3,12,WNW,https://example.com/ob",
  "Ocean Beach,2026-05-02,1.8,14,W,https://example.com/ob",
  "Pacifica,2026-05-01,0.9,9,NW,",
  "Pacifica,2026-05-02,1.1,11,NW,https://example.com/pacifica",
  "Half Moon Bay,2026-05-01,2.4,16,W,",
  "Half Moon Bay,2026-05-02,2.1,15,WSW,https://example.com/hmb",
  "Santa Cruz,2026-05-01,1.6,13,SW,",
  "Santa Cruz,2026-05-02,,13,SW,",
  "Bolinas,2026-05-01,0.7,8,S,",
  "Bolinas,2026-05-02,0.8,8,SSW,",
].join("\n")

const CONFIG = JSON.stringify({ station: "Ocean Beach", units: "ft", alerts: { swell: 2.5, wind: 20 }, sources: ["noaa", "cdip"] })

const LOG = [
  "12:00:01 fetch forecast ok (182 ms)",
  "12:00:02 parse 48 points",
  "12:00:02 render chart",
  "12:00:05 refresh skipped: unchanged",
].join("\n")

const VISUALIZATION_HTML = [
  "<!doctype html><html><head><style>",
  "body{margin:0;font-family:var(--font-sans,sans-serif);color:var(--foreground,#111);background:transparent}",
  ".bar{height:18px;margin:6px 0;background:var(--viz-blue,#3b82f6);border-radius:4px}",
  "</style></head><body>",
  "<h3 style=\"margin:0 0 8px\">Swell by station</h3>",
  "<div class=\"bar\" style=\"width:60%\"></div><div class=\"bar\" style=\"width:35%\"></div><div class=\"bar\" style=\"width:80%\"></div>",
  "</body></html>",
].join("")

export type ViewerGalleryItem =
  | { kind: "attachment"; attachment: { url: string; name: string; mimeType: string; size: number | null } }
  | { kind: "chart"; payload: ChartToolPayload }
  | { kind: "visualization"; artifact: VisualizationArtifact }

export const VIEWER_GALLERY_ITEMS: Record<string, ViewerGalleryItem> = {
  image: { kind: "attachment", attachment: { url: "/screenshot-light.png", name: "screenshot-light.png", mimeType: "image/png", size: 245_760 } },
  markdown: { kind: "attachment", attachment: { url: dataUrl("text/markdown", NOTES), name: "RELEASE.md", mimeType: "text/markdown", size: NOTES.length } },
  csv: { kind: "attachment", attachment: { url: dataUrl("text/csv", READINGS), name: "readings.csv", mimeType: "text/csv", size: READINGS.length } },
  json: { kind: "attachment", attachment: { url: dataUrl("application/json", CONFIG), name: "config.json", mimeType: "application/json", size: CONFIG.length } },
  text: { kind: "attachment", attachment: { url: dataUrl("text/plain", LOG), name: "fetch.log", mimeType: "text/plain", size: LOG.length } },
  external: { kind: "attachment", attachment: { url: "/archive.zip", name: "archive.zip", mimeType: "application/zip", size: 1_048_576 } },
  chart: { kind: "chart", payload: CHARTS[0]! },
  pie: { kind: "chart", payload: CHARTS[4]! },
  visualization: {
    kind: "visualization",
    artifact: { type: "visualization", version: 1, title: "Swell by station", url: dataUrl("text/html", VISUALIZATION_HTML), height: 120 } as VisualizationArtifact,
  },
}

export function viewerGalleryItem(search: string): ViewerGalleryItem {
  const name = new URLSearchParams(search).get("item") ?? "image"
  return VIEWER_GALLERY_ITEMS[name] ?? VIEWER_GALLERY_ITEMS.image!
}
