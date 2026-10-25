import { Option } from "effect"
import { Submodel } from "foldkit"
import { childAttributes, type Html } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import * as ContextMenu from "../ui/context-menu"
import { POPPER_WRAPPER_INITIAL_STYLE } from "../ui/overlay/popper"

// ui/context-menu's view with one more thing Radix's <ContextMenuContent>
// can hold: plain markup before the items. A skill card's menu opens with a
// heading ("Added via npx skills") that is a div, not an item: no role, not
// focusable, no hover. The primitive's entries are items and separators
// only, so this is its view (keep the two in step) plus `header`. The Model,
// update and the content's Mount are the primitive's.
//
// Integrator follow-up: a label entry in ui/context-menu would replace this.

export interface ViewInputs extends ContextMenu.ViewInputs {
  /** A div first inside the menu: `<div className={headerClassName}>{header}</div>`. */
  header?: string
  headerClassName?: string
}

export const view = Submodel.defineView<ContextMenu.Model, ContextMenu.Message, ViewInputs>((model, inputs, h) => {
  const Message = ContextMenu.Message
  const open = model.phase === "Open"
  const state = open ? "open" : "closed"
  const disabled = inputs.disabled ?? false
  const enabledCount = inputs.items.filter((entry) => entry._tag === "Item" && !entry.disabled).length

  const trigger = childAttributes([
    h.DataAttribute("state", state),
    ...(disabled ? [h.DataAttribute("disabled", "")] : []),
    ...(disabled
      ? []
      : [
        h.OnContextMenu(Message.RequestedContextMenu()),
        h.OnPointerDown((pointerType, button, _screenX, _screenY, _timeStamp, clientX, clientY) =>
          Option.some(Message.PressedTrigger({ pointerType, button, x: Math.trunc(clientX), y: Math.trunc(clientY) }))),
        h.OnPointerMove((_x, _y, pointerType) =>
          pointerType !== "mouse" && Option.isSome(model.longPressVersion) ? Option.some(Message.CancelledLongPress()) : Option.none()),
        h.OnPointerUp((_x, _y, pointerType) =>
          pointerType !== "mouse" && Option.isSome(model.longPressVersion) ? Option.some(Message.CancelledLongPress()) : Option.none()),
      ]),
  ])

  const entry = (config: ContextMenu.MenuEntry, index: number) => {
    if (config._tag === "Separator") {
      return h.keyed("div")(`separator-${index}`, [
        h.Role("separator"),
        h.AriaOrientation("horizontal"),
        h.Class(cn("-mx-1 my-1 h-px bg-border", config.className)),
      ])
    }
    const isFocused = Option.contains(model.highlighted, config.value)
    const itemDisabled = config.disabled ?? false
    return h.keyed("div")(config.value, [
      h.Role("menuitem"),
      ...(isFocused ? [h.DataAttribute("highlighted", "")] : []),
      ...(itemDisabled ? [h.AriaDisabled(true), h.DataAttribute("disabled", "")] : []),
      ...(config.title !== undefined ? [h.Title(config.title)] : []),
      h.Tabindex(-1),
      h.DataAttribute("orientation", "vertical"),
      h.Class(cn(
        "relative flex cursor-default select-none items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium text-foreground outline-hidden transition-colors hover:bg-muted focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        config.className,
      )),
      h.OnFocus(Message.FocusedItem({ value: config.value })),
      h.OnBlur(Message.BlurredItem({ value: config.value })),
      ...(itemDisabled
        ? []
        : [
          h.OnClick(Message.ChoseItem({ value: config.value })),
          h.OnKeyDownPreventDefault((key) => (key === "Enter" || key === " " ? Option.some(Message.ChoseItem({ value: config.value })) : Option.none())),
        ]),
    ], inputs.renderItem(config.value))
  }

  const header = inputs.header
    ? h.keyed("div")("header", [...(inputs.headerClassName ? [h.Class(inputs.headerClassName)] : [])], [inputs.header])
    : null

  const portal: Html = model.phase !== "Closed"
    ? h.keyed("div")(`${model.id}-context-menu-${model.point.x}-${model.point.y}`, [
      h.DataAttribute("radix-popper-content-wrapper", ""),
      h.Style(POPPER_WRAPPER_INITIAL_STYLE),
      h.OnMount(ContextMenu.ContextMenuContent({ id: model.id, x: model.point.x, y: model.point.y })),
    ], [
      h.div([
        h.DataAttribute("side", "right"),
        h.DataAttribute("align", "start"),
        h.Role("menu"),
        h.Id(ContextMenu.contentId(model.id)),
        h.AriaOrientation("vertical"),
        h.DataAttribute("state", state),
        h.DataAttribute("radix-menu-content", ""),
        h.Dir("ltr"),
        h.Tabindex(enabledCount > 0 ? 0 : -1),
        h.DataAttribute("orientation", "vertical"),
        h.Class(cn(
          "z-50 min-w-[170px] overflow-hidden rounded-xl border border-border bg-background p-1 shadow-lg outline-hidden floating-surface",
          inputs.className,
        )),
        h.Style({
          outline: "none",
          "--radix-context-menu-content-transform-origin": "var(--radix-popper-transform-origin)",
          "--radix-context-menu-content-available-width": "var(--radix-popper-available-width)",
          "--radix-context-menu-content-available-height": "var(--radix-popper-available-height)",
          "--radix-context-menu-trigger-width": "var(--radix-popper-anchor-width)",
          "--radix-context-menu-trigger-height": "var(--radix-popper-anchor-height)",
        }),
      ], [header, ...inputs.items.map(entry)]),
    ])
    : null

  return inputs.toView({ trigger, portal, isOpen: open })
})
