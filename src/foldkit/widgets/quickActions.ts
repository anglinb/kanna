import { Option } from "effect"
import type { Html } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import type { ProjectQuickAction } from "../../shared/protocol"
import { buttonClass } from "../ui/button"
import { Check, CornerDownLeft, Play, Plus, Zap } from "../ui/icons"
import { rowMenu, toParts, type ColumnContext, type H } from "./context"
import { Message } from "./message"
import { QuickActionRow } from "./mounts"
import { Mount } from "foldkit"
import { FocusOnMount, swapIn, WIDGET_STRIP_INPUT_CLASS, widgetCard, widgetError, widgetList, widgetPresence, widgetRow, widgetStrip } from "./parts"

// QuickActionsWidget (widgets/QuickActionsWidget.tsx): the project's saved
// commands, each run in a new terminal (by the page). The one widget that
// shows even when empty: it is how Quick Actions are added.

/** The list the column shows: what it last wrote for this project, else the page's read. */
export function quickActionsList(context: ColumnContext): ReadonlyArray<ProjectQuickAction> {
  const written = context.model.quickActions.written
  if (written && written.projectId === context.projectId) return written.actions
  return context.page.widgetsData.quickActions ?? []
}

export function quickActionsError(context: ColumnContext): string | null {
  return context.model.quickActions.error ?? context.page.widgetsData.quickActionsError
}

/** Open: stored or by default, or held open by the add form or an error. */
export function quickActionsOpen(context: ColumnContext) {
  const state = context.model.quickActions
  return context.expanded("quickActions", quickActionsList(context).length) || state.isAdding || quickActionsError(context) !== null
}

export function quickActionsWidget(context: ColumnContext, h: H): Html {
  const { model } = context
  const state = model.quickActions
  const actions = quickActionsList(context)
  const error = quickActionsError(context)
  const isOpen = quickActionsOpen(context)
  return widgetPresence({ toParts, key: "quick-actions", show: true }, [
    // A press inside the widget leaves the form's fate to the click it becomes.
    h.div([h.OnPointerDown(() => Option.some(Message.PressedInQuickActions()))], [
      widgetCard({
        icon: Zap({}, h),
        title: ["Quick Actions"],
        count: actions.length > 0 ? actions.length : null,
        // Always a disclosure. With nothing saved, opening it goes straight to the add form.
        expanded: isOpen,
        onToggle: Message.ToggledQuickActions(),
        actions: [
          h.button([
            h.Class(buttonClass({ variant: "ghost", size: "none", class: "size-6 border-border/0 text-muted-foreground hover:!border-border/0 hover:!bg-transparent hover:text-foreground" })),
            h.Type("button"),
            h.AriaLabel("Add quick action"),
            h.Title("Add quick action"),
            h.OnClick(Message.ClickedAddQuickAction()),
          ], [Plus({ class: "size-4" }, h)]),
        ],
        body: [
          // The add form is a Strip over the saved actions, not a row among them.
          state.isAdding
            ? widgetStrip({
              leading: Zap({}, h),
              form: [
                h.OnSubmit(Message.SubmittedQuickAction()),
                h.OnFocusLeave(Message.LeftQuickActionForm()),
              ],
              trailing: [
                h.button([
                  h.Class(buttonClass({ variant: "ghost", size: "none", class: "h-6 rounded-md px-2 text-muted-foreground hover:!bg-transparent hover:text-foreground" })),
                  h.Type("submit"),
                  h.AriaLabel("Save quick action"),
                  ...(!state.newCommand.trim() ? [h.Disabled(true)] : []),
                ], [CornerDownLeft({ class: "size-3.5" }, h)]),
              ],
            }, [
              h.input([
                h.Value(state.newCommand),
                h.OnInput((value) => Message.ChangedNewCommand({ value })),
                h.Placeholder("bun run dev"),
                h.AriaLabel("Command"),
                h.Autocomplete("off"),
                h.Spellcheck(false),
                h.Class(cn(WIDGET_STRIP_INPUT_CLASS, "font-mono text-[13px]")),
                h.OnMount(Mount.mapMessage(FocusOnMount(), (message) => Message.GotPartsMessage({ message }))),
              ]),
            ], h)
            : null,
          actions.length > 0 || error
            ? widgetList({}, [
              error ? widgetError(error, h) : null,
              ...actions.map((action) => {
                const ran = state.ranActionId === action.id
                return widgetRow({
                  key: action.id,
                  icon: swapIn({ swapKey: ran ? "ran" : "idle", toParts }, [
                    ran
                      ? Check({ class: "text-success", attributes: [h.AriaLabel("Started")] }, h)
                      : Play({ class: "group-hover/row:text-foreground" }, h),
                  ], h),
                  title: [h.span([h.Class("font-mono text-[13px]")], [action.label])],
                  tooltip: action.command,
                  // The page runs it (its own click); the row hears the same click.
                  activation: [
                    ...(context.requests.runQuickAction[action.id] ?? []),
                    h.OnMount(QuickActionRow({ id: action.id })),
                  ],
                  menu: rowMenu(model, { _tag: "QuickAction", id: action.id }, "Quick action options", h),
                }, h)
              }),
            ], h)
            : null,
        ],
      }, h),
    ]),
  ], h)
}
