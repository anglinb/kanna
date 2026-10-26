/// <reference types="vite/client" />
// The candidate app for parity runs: the Foldkit client on the fixture
// backend. Must stay the first import.
import "../fixture"
import "@fontsource-variable/bricolage-grotesque"
import "@xterm/xterm/css/xterm.css"
import "../../index.css"
import { createDemoAppSettings } from "../../demo/backend"
import { readThemeParam } from "../../demo/environment"
import { runKanna } from "../../foldkit/app/run"
import { galleryName } from "../gallery"
import type { GalleryPage } from "./gallery-page"

// Gallery pages: one component in isolation per file, at /__gallery/<file>,
// matched by a file of the same name in ../react/gallery.
const galleries = import.meta.glob<{ default: GalleryPage }>("./gallery/*.ts", { eager: true })

const container = document.getElementById("root")

if (!container) {
  throw new Error("Missing #root")
}

const gallery = galleryName(window.location.pathname)

if (gallery) {
  const page = galleries[`./gallery/${gallery}.ts`]?.default
  if (page) page.run(container)
  else container.textContent = `No gallery named ${gallery}`
} else {
  // As the React entry seeds its store: start on the fixture's theme.
  runKanna(container, { initialAppSettings: createDemoAppSettings(readThemeParam()) })
}
