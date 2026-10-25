// Must stay the first import: it swaps in the fake WebSocket and storage
// before any client module evaluates.
import { readThemeParam } from "./environment"
import "@fontsource-variable/bricolage-grotesque"
import "@xterm/xterm/css/xterm.css"
import "../index.css"
import { runKanna } from "../foldkit/app/run"
import { createDemoAppSettings } from "./backend"
import { DEMO_FEATURED_CHAT_ID } from "./scenario"

const container = document.getElementById("root")

if (!container) {
  throw new Error("Missing #root")
}

// Seeded before the first render so the app starts on the demo's theme
// instead of "system" and flipping once the settings snapshot arrives.
// Routed in memory: the demo lives at kanna.sh/demo/, inside an iframe, and
// must not push its /chat/... routes into the frame's address.
runKanna(container, {
  initialAppSettings: createDemoAppSettings(readThemeParam()),
  memoryRoute: `/chat/${DEMO_FEATURED_CHAT_ID}`,
})
