// The Foldkit export viewer (src/foldkit/transcript/export/app.ts) with its
// transcript loaded, against the React export viewer's ready state
// (gallery/transcript-export-viewer.tsx), on the same fixture.
import * as ExportViewer from "../../../foldkit/transcript/export/app"
import { exportFixtureBundle } from "../../../foldkit/transcript/export/fixture"
import { galleryPage } from "../gallery-page"

export default galleryPage<ExportViewer.Model, ExportViewer.Message>({
  ...ExportViewer.program,
  init: () => ({ model: ExportViewer.initLoaded(exportFixtureBundle(), "Kanna") }),
})
