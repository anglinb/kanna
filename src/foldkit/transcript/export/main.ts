// The standalone export viewer's entry (built by vite.export-viewer.config.ts
// into dist/export-viewer, and copied beside each export's transcript.json).
import "@fontsource-variable/bricolage-grotesque"
import "../../../index.css"
import { runExportViewer } from "./app"

const container = document.getElementById("root")

if (!container) {
  throw new Error("Missing #root")
}

runExportViewer(container)
