// The reference app for parity runs: the React client, unchanged, on the
// fixture backend. Must stay the first import.
import "../fixture"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import "@fontsource-variable/bricolage-grotesque"
import { App } from "../../client/app/App"
import { ThemeProvider } from "../../client/hooks/useTheme"
import { useAppSettingsStore } from "../../client/stores/appSettingsStore"
import { createDemoAppSettings } from "../../demo/backend"
import { readThemeParam } from "../../demo/environment"
import "@xterm/xterm/css/xterm.css"
import "../../index.css"

const container = document.getElementById("root")

if (!container) {
  throw new Error("Missing #root")
}

// As in src/demo/main.tsx: start on the fixture's theme, not "system".
useAppSettingsStore.getState().setFromServer(createDemoAppSettings(readThemeParam()))

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>
)
