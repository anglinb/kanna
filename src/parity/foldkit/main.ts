// The candidate app for parity runs: the Foldkit client on the fixture
// backend. Must stay the first import.
import "../fixture"
import "@fontsource-variable/bricolage-grotesque"
import "@xterm/xterm/css/xterm.css"
import "../../index.css"
import { runKanna } from "../../foldkit/app/run"

const container = document.getElementById("root")

if (!container) {
  throw new Error("Missing #root")
}

runKanna(container)
