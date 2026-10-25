import { describe, expect, test } from "bun:test"
import type { HtmlBuilder } from "foldkit/html"
import { Scene } from "foldkit/test"
import { Message as TranscriptMessage } from "../message"
import { MeasureMinimap } from "../minimap"
import { ControlViewport } from "../viewport"
import { init, initLoaded, Message, update, view, type Model } from "./app"
import { exportFixtureBundle } from "./fixture"

// The standalone export viewer: loading, a failed fetch, and the loaded
// transcript under its header and over the Try It banner.

describe("export viewer", () => {
  test("it starts loading, takes the export's title once loaded, and says why when the fetch fails", () => {
    const [loading, commands] = init()
    expect(loading.state._tag).toBe("Loading")
    expect(loading.title).toBe("Kanna Transcript")
    expect(commands.map((command) => command.name)).toEqual(["LoadExportedTranscript"])

    const bundle = exportFixtureBundle()
    const [ready, applied] = update(loading, Message.SucceededLoad({ bundle }))
    expect(ready.state._tag).toBe("Ready")
    expect(ready.title).toBe("Add a feet/meters toggle | Kanna")
    expect(applied.map((command) => command.name)).toEqual(["ApplyExportedTranscriptTheme"])

    const [failed] = update(loading, Message.FailedLoad({ message: "Transcript request failed with status 404" }))
    expect(failed.state).toEqual({ _tag: "Failed", message: "Transcript request failed with status 404" })
  })

  test("Scene: the loaded export, read-only, with its header and the Try It banner", () => {
    Scene.scene(
      {
        update: (model: Model, message: Message) => {
          const [next, commands] = update(model, message)
          return { model: next, commands }
        },
        view: (model: Model, h: HtmlBuilder<Message>) => view(model, h).body,
      },
      Scene.given(initLoaded(exportFixtureBundle(), "Kanna")),
      Scene.Mount.resolve(ControlViewport, TranscriptMessage.MountedViewport({ chatId: "chat-export-units" })),
      Scene.Mount.resolve(MeasureMinimap, TranscriptMessage.MeasuredMinimap({ height: 600 })),
      ...["x-p1", "x-p2"].map((id) => Scene.Mount.resolve({ name: "ClampMeasure" } as never, { _tag: "MeasuredClamp", key: `clamp:${id}:0`, overflows: false } as never)),
      Scene.expect(Scene.text("Add a feet/meters toggle")).toExist(),
      Scene.expect(Scene.role("region", { name: "Messages" })).toExist(),
      Scene.expect(Scene.text("Kanna is a delightful open-source harness UI")).toExist(),
      Scene.expect(Scene.role("link", { name: "Try It" })).toHaveAttr("href", "https://kanna.sh"),
      // Links in an export are text: nothing to open from a file on disk.
      Scene.expect(Scene.role("link", { name: "src/lib/units.ts" })).toBeAbsent(),
    )
  })
})
