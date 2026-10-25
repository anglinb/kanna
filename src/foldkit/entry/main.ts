// The web client's entry: the Foldkit app on the real server.
import "@fontsource-variable/bricolage-grotesque"
import "@xterm/xterm/css/xterm.css"
import "../../index.css"
import { runKanna } from "../app/run"

const container = document.getElementById("root")

if (!container) {
  throw new Error("Missing #root")
}

runKanna(container)
