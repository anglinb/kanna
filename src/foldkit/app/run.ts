import { Runtime } from "foldkit"
import { Model, init, update, view } from "./main"

// Kept apart from main.ts so tests can import the program without booting it.
export function runKanna(container: HTMLElement) {
  Runtime.run(Runtime.makeApplication({ Model, init, update, view, container }))
}
