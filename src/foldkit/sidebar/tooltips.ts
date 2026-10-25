import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import type { Child } from "../ui/attributes"
import type { Side } from "../ui/overlay/popper"
import * as Tooltip from "../ui/tooltip"
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

/**
 * A tooltip on a sidebar trigger. One Tooltip Model per trigger, as one
 * <Tooltip> per trigger in React, made the first time it is pointed at
 * (`GotTooltipMessage` folds into `init` for an unknown key). The whole
 * sidebar is in `<StillTooltips>`: no entrance or exit motion.
 */
export function tooltip(
  key: string,
  options: { side?: Side; sideOffset?: number; content: ReadonlyArray<Child> },
  model: Model,
  h: H,
  render: (trigger: ReadonlyArray<ChildAttribute>, portal: Html) => Html,
): Html {
  return h.submodel({
    slotId: `tooltip-${key}`,
    model: model.tooltips[key] ?? Tooltip.init({ id: key }),
    view: Tooltip.view,
    viewInputs: {
      side: options.side,
      sideOffset: options.sideOffset,
      still: true,
      content: () => options.content,
      toView: ({ trigger, portal }) => render(trigger, portal),
    },
    toParentMessage: (message) => Message.GotTooltipMessage({ key, message }),
  })
}
