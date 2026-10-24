/// <reference types="vite/client" />
// The reference app for parity runs: the React client, unchanged, on the
// fixture backend. Must stay the first import.
import "../fixture"
import { StrictMode, type ComponentType } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import "@fontsource-variable/bricolage-grotesque"
import { App } from "../../client/app/App"
import { ThemeProvider } from "../../client/hooks/useTheme"
import { useAppSettingsStore } from "../../client/stores/appSettingsStore"
import { createDemoAppSettings } from "../../demo/backend"
import { readThemeParam } from "../../demo/environment"
import { galleryName } from "../gallery"
import "@xterm/xterm/css/xterm.css"
import "../../index.css"

// Gallery pages: one component in isolation per file, at /__gallery/<file>,
// matched by a file of the same name in ../foldkit/gallery.
const galleries = import.meta.glob<{ default: ComponentType }>("./gallery/*.tsx", { eager: true })

const container = document.getElementById("root")

if (!container) {
  throw new Error("Missing #root")
}

// As in src/demo/main.tsx: start on the fixture's theme, not "system".
useAppSettingsStore.getState().setFromServer(createDemoAppSettings(readThemeParam()))

const gallery = galleryName(window.location.pathname)
const Gallery = gallery ? galleries[`./gallery/${gallery}.tsx`]?.default : undefined

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        {gallery ? (Gallery ? <Gallery /> : <p>No gallery named {gallery}</p>) : <App />}
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>
)
