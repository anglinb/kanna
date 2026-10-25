import { describe, test } from "bun:test"
import { Schema } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { Scene } from "foldkit/test"
import { segmentedControl } from "./segmented-control"
import { switchControl } from "./switch"

// A tiny program around the two stateless controls: the value lives in the
// caller's Model, a click reports the new one.
const Model = Schema.Struct({ format: Schema.String, sounds: Schema.Boolean })
type Model = typeof Model.Type
const Message = defineMessageUnion({ ChoseFormat: { format: Schema.String }, ToggledSounds: { checked: Schema.Boolean } })
type Message = typeof Message.Type

const update = (model: Model, message: Message) =>
  Message.match(message, {
    ChoseFormat: ({ format }) => ({ model: { ...model, format } }),
    ToggledSounds: ({ checked }) => ({ model: { ...model, sounds: checked } }),
  })

const view = (model: Model, h: HtmlBuilder<Message>) =>
  h.main([], [
    segmentedControl({
      value: model.format,
      onValueChange: (format) => Message.ChoseFormat({ format }),
      options: [
        { value: "png", label: ["PNG"] },
        { value: "svg", label: ["SVG"] },
        { value: "html", label: ["HTML"], disabled: true },
      ],
    }, h),
    switchControl({ checked: model.sounds, onCheckedChange: (checked) => Message.ToggledSounds({ checked }), ariaLabel: "Sounds" }, h),
  ])

describe("segmentedControl and switchControl", () => {
  test("Scene: a segment click reports its value; the pressed state follows the Model", () => {
    Scene.scene(
      { update, view },
      Scene.given({ format: "png", sounds: false }),
      Scene.expect(Scene.role("button", { name: "PNG" })).toHaveAttr("aria-pressed", "true"),
      Scene.expect(Scene.role("button", { name: "HTML" })).toBeDisabled(),
      Scene.click(Scene.role("button", { name: "SVG" })),
      Scene.expect(Scene.role("button", { name: "SVG" })).toHaveAttr("aria-pressed", "true"),
      Scene.expect(Scene.role("button", { name: "PNG" })).toHaveAttr("aria-pressed", "false"),
    )
  })

  test("Scene: the switch is a role=switch that reports the state it moves to", () => {
    Scene.scene(
      { update, view },
      Scene.given({ format: "png", sounds: false }),
      Scene.expect(Scene.role("switch", { name: "Sounds" })).toHaveAttr("aria-checked", "false"),
      Scene.click(Scene.role("switch", { name: "Sounds" })),
      Scene.expect(Scene.role("switch", { name: "Sounds" })).toHaveAttr("aria-checked", "true"),
    )
  })
})
