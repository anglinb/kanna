import { Schema } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { cn } from "../../client/lib/utils"
import type { Child } from "../ui/attributes"
import { domStream } from "../ui/overlay/stream"
import { mountInputs, watchMountInputs } from "./mountInputs"
import type { Layout, Orientation, RegisteredGroup } from "./resizable/components/group/types"
import { sortByElementOffset } from "./resizable/components/group/sortByElementOffset"
import type { GroupResizeBehavior, RegisteredPanel } from "./resizable/components/panel/types"
import type { RegisteredSeparator } from "./resizable/components/separator/types"
import { mountGroup } from "./resizable/global/mountGroup"
import { getMountedGroupState, getRegisteredGroup, subscribeToMountedGroup } from "./resizable/global/mutable-state/groups"
import { getInteractionState, subscribeToInteractionState } from "./resizable/global/mutable-state/interactions"
import type { InteractionState } from "./resizable/global/mutable-state/types"
import { calculateSeparatorAriaValues } from "./resizable/global/utils/calculateSeparatorAriaValues"
import { getImperativeGroupMethods } from "./resizable/global/utils/getImperativeGroupMethods"
import { layoutNumbersEqual } from "./resizable/global/utils/layoutNumbersEqual"
import { layoutsEqual } from "./resizable/global/utils/layoutsEqual"

/**
 * react-resizable-panels 4.12.2 (`Group`, `Panel`, `Separator`) and the
 * shadcn wrappers in src/client/components/ui/resizable.tsx, for Foldkit.
 *
 * The library's framework-free core (hit regions, dragging, keyboard
 * resizing, double-click reset, constraints, the page-wide resize cursor) is
 * vendored unchanged under ./resizable (MIT, see ./resizable/LICENSE); only
 * its React components are replaced:
 *
 *  - The view renders the same DOM: `data-group` / `data-panel` /
 *    `role="separator"` elements with the library's inline styles.
 *  - One Mount on the group element registers its panels and separators
 *    with the core, as the components' layout effects did, and writes what
 *    React re-rendered from the core's state: each panel's flex-grow, each
 *    separator's aria values and `data-separator` state.
 *  - What React passed as props (sizes, constraints, `disabled`) reaches the
 *    Mount through `mountInputs`, so changing one re-registers the group
 *    without remounting its children, as in React.
 *
 * `onLayoutChanged` arrives as a `ChangedGroupLayout` Message, lifted into
 * the caller's universe by `toMessage`.
 *
 *   resizablePanelGroup({
 *     id: "terminals", orientation: "horizontal", className: "h-full min-h-0",
 *     toMessage: (message) => GotResizableMessage({ message }),
 *     items: [
 *       resizablePanel({ id: "a", defaultSize: "50%", minSize: "300px", content: [...] }),
 *       resizableHandle({ id: "a-handle", orientation: "horizontal", withHandle: true }),
 *       resizablePanel({ id: "b", defaultSize: "50%", content: [...] }),
 *     ],
 *   }, h)
 */

export const Message = defineMessageUnion({
  /** The library's `onLayoutChanged`: on mount, and when a resize settles. */
  ChangedGroupLayout: {
    groupId: Schema.String,
    layout: Schema.Record(Schema.String, Schema.Number),
    isUserInteraction: Schema.Boolean,
  },
})
export type Message = typeof Message.Type

export type { Layout, Orientation }

type Size = number | string

export interface PanelItem {
  kind: "panel"
  id: string
  defaultSize?: Size
  minSize?: Size
  maxSize?: Size
  collapsedSize?: Size
  collapsible?: boolean
  disabled?: boolean
  groupResizeBehavior?: GroupResizeBehavior
  /** On the panel's inner element, as `<Panel className>`. */
  className?: string
  /** On the panel's inner element, as `<Panel style>` (kebab-case keys). */
  style?: Record<string, string>
  content: ReadonlyArray<Child>
}

export interface SeparatorItem {
  kind: "separator"
  id: string
  disabled?: boolean
  disableDoubleClick?: boolean
  className?: string
  style?: Record<string, string>
  content: ReadonlyArray<Child>
}

export type GroupItem = PanelItem | SeparatorItem

export interface GroupOptions<ParentMessage> {
  /** Unique among the groups on the page: the core finds groups by id. */
  id: string
  orientation?: Orientation
  className?: string
  style?: Record<string, string>
  disabled?: boolean
  disableCursor?: boolean
  defaultLayout?: Layout
  /** The element's key, as React's `key` on the group: a new key is a new group. */
  key?: string
  items: ReadonlyArray<GroupItem>
  toMessage: (message: Message) => ParentMessage
}

// What the Mount reads off the element (see mountInputs).
interface PanelSpec {
  id: string
  defaultSize?: Size
  minSize?: Size
  maxSize?: Size
  collapsedSize?: Size
  collapsible?: boolean
  disabled?: boolean
  groupResizeBehavior?: GroupResizeBehavior
}

interface SeparatorSpec {
  id: string
  disabled?: boolean
  disableDoubleClick?: boolean
}

interface GroupSpec {
  orientation: Orientation
  disabled: boolean
  disableCursor: boolean
  defaultLayout: Layout | null
  panels: PanelSpec[]
  separators: SeparatorSpec[]
}

// React's style values: a number is pixels, a string is as given.
function cssSize(value: Size) {
  return typeof value === "number" ? `${value}px` : value
}

// The Panel's PROHIBITED_CSS_PROPERTIES and fixed flex settings. flex-grow,
// flex-shrink, flex-basis and pointer-events come from the core's layout and
// are written by the Mount (see applyPanelStyle).
const PANEL_STYLE: Record<string, string> = {
  "min-height": "0",
  "max-height": "100%",
  height: "auto",
  "min-width": "0",
  "max-width": "100%",
  width: "auto",
  border: "none",
  "border-width": "0",
  padding: "0",
  margin: "0",
  display: "flex",
  overflow: "visible",
}

// MOUNT

const noopResize = () => {}

function setStyle(element: HTMLElement, name: string, value: string | undefined) {
  if (value === undefined) element.style.removeProperty(name)
  else element.style.setProperty(name, value)
}

function setAttribute(element: Element, name: string, value: string | undefined) {
  if (value === undefined) element.removeAttribute(name)
  else if (element.getAttribute(name) !== value) element.setAttribute(name, value)
}

function childById(group: HTMLElement, id: string): HTMLDivElement | null {
  for (const child of group.children) {
    if (child.id === id) return child as HTMLDivElement
  }
  return null
}

function setupGroup(element: HTMLElement, groupId: string, emit: (message: Message) => void): () => void {
  // What Group kept in refs across re-registrations.
  const memory = {
    lastExpandedPanelSizes: {} as Record<string, number>,
    layouts: {} as Record<string, Layout>,
    reportedLayout: {} as Layout,
  }
  let registered: { group: RegisteredGroup; unmount: () => void; stopListening: () => void } | null = null
  const focusedSeparators = new Set<string>()
  // Panels already given a style: React kept a panel's last style while its
  // group re-registered, and styled a new one when it rendered.
  const styledPanels = new Set<string>()
  const separatorDragStates = new Map<string, InteractionState["state"]>()

  const inputs = watchMountInputs<GroupSpec>(element, (next, previous) => {
    const onlyMutable = next.orientation === previous.orientation
      && next.disabled === previous.disabled
      && JSON.stringify(next.panels) === JSON.stringify(previous.panels)
      && JSON.stringify(next.separators) === JSON.stringify(previous.separators)
    if (onlyMutable && registered) {
      // Group's plain effect: these don't re-register the group.
      registered.group.mutableState.defaultLayout = next.defaultLayout ?? undefined
      registered.group.mutableState.disableCursor = next.disableCursor
      return
    }
    styleNewPanels()
    unregister()
    register()
  })

  function styleNewPanels() {
    for (const panel of inputs.current().panels) {
      if (!styledPanels.has(panel.id)) applyPanelStyle(panel)
    }
  }

  function reportLayoutChanged(layout: Layout, isUserInteraction: boolean) {
    if (layoutsEqual(memory.reportedLayout, layout)) return
    memory.reportedLayout = layout
    emit(Message.ChangedGroupLayout({ groupId, layout: { ...layout }, isUserInteraction }))
  }

  // Panel's style: from the core's layout once the group is mounted, else
  // its default size.
  function applyPanelStyle(panel: PanelSpec) {
    const panelElement = childById(element, panel.id)
    if (!panelElement) return
    styledPanels.add(panel.id)
    const state = getMountedGroupState(groupId)
    const defaultLayout = inputs.current().defaultLayout
    let grow: string | undefined
    let shrink: string | undefined = "1"
    let basis: string | undefined = "0"
    let pointerEvents: string | undefined
    if (state) {
      const interaction = getInteractionState()
      const group = getRegisteredGroup(groupId)
      const dragActive = interaction.state === "active" && interaction.hitRegions.some((region) => region.group === group)
      grow = String(state.layout[panel.id] ?? 1)
      pointerEvents = dragActive ? "none" : undefined
    } else if (defaultLayout?.[panel.id]) {
      grow = String(defaultLayout[panel.id])
    } else if (panel.defaultSize !== undefined) {
      grow = undefined
      shrink = undefined
      basis = cssSize(panel.defaultSize)
    } else {
      grow = "1"
    }
    setStyle(panelElement, "flex-basis", basis)
    setStyle(panelElement, "flex-shrink", shrink)
    setStyle(panelElement, "flex-grow", grow)
    setStyle(panelElement, "pointer-events", pointerEvents)
  }

  function separatorStateAttribute(separator: SeparatorSpec) {
    if (separator.disabled) return "disabled"
    const dragState = separatorDragStates.get(separator.id) ?? "inactive"
    if (dragState === "active") return "active"
    return focusedSeparators.has(separator.id) ? "focus" : dragState
  }

  function applySeparatorState(separator: SeparatorSpec) {
    const separatorElement = childById(element, separator.id)
    if (separatorElement) setAttribute(separatorElement, "data-separator", separatorStateAttribute(separator))
  }

  function register() {
    const spec = inputs.current()
    styleNewPanels()
    const panels = sortByElementOffset<RegisteredPanel, RegisteredPanel[]>(spec.orientation, spec.panels.flatMap((panel) => {
      const panelElement = childById(element, panel.id)
      if (!panelElement) return []
      return [{
        element: panelElement,
        id: panel.id,
        idIsStable: true,
        mutableValues: { expandToSize: undefined, prevSize: undefined },
        // Panel passed its (absent) onResize through whenever the prop wasn't
        // null, so the core observes every panel.
        onResize: noopResize,
        panelConstraints: {
          groupResizeBehavior: panel.groupResizeBehavior ?? "preserve-relative-size",
          collapsedSize: panel.collapsedSize ?? "0%",
          collapsible: panel.collapsible ?? false,
          defaultSize: panel.defaultSize,
          disabled: panel.disabled,
          maxSize: panel.maxSize ?? "100%",
          minSize: panel.minSize ?? "0%",
        },
      }]
    }))
    const separators = sortByElementOffset<RegisteredSeparator, RegisteredSeparator[]>(spec.orientation, spec.separators.flatMap((separator) => {
      const separatorElement = childById(element, separator.id)
      if (!separatorElement) return []
      return [{ disabled: separator.disabled, disableDoubleClick: separator.disableDoubleClick, element: separatorElement, id: separator.id }]
    }))

    let defaultLayout: Layout | undefined
    if (spec.defaultLayout && Object.keys(spec.defaultLayout).length === panels.length) {
      defaultLayout = {}
      for (const panel of panels) {
        const size = spec.defaultLayout[panel.id]
        if (size !== undefined) defaultLayout[panel.id] = size
      }
    }

    const group: RegisteredGroup = {
      disabled: spec.disabled,
      element,
      id: groupId,
      mutableState: {
        defaultLayout,
        disableCursor: spec.disableCursor,
        expandedPanelSizes: memory.lastExpandedPanelSizes,
        layouts: memory.layouts,
      },
      orientation: spec.orientation,
      panels,
      resizeTargetMinimumSize: { coarse: 20, fine: 10 },
      separators,
    }

    // Separator's own listeners, registered before the group mounts as its
    // layout effect ran before Group's.
    const removeInteractionListener = subscribeToInteractionState((event) => {
      for (const separator of separators) {
        const next = event.next.state !== "inactive" && event.next.hitRegions.some((region) => region.separator === separator)
          ? event.next.state
          : "inactive"
        separatorDragStates.set(separator.id, next)
      }
      for (const separator of inputs.current().separators) applySeparatorState(separator)
    })
    const removeAriaListener = subscribeToMountedGroup(groupId, (event) => {
      const { derivedPanelConstraints, layout, separatorToPanels } = event.next
      for (const separator of separators) {
        const pair = separatorToPanels.get(separator)
        if (!pair) continue
        const primaryPanel = pair[0]
        const panelIndex = pair.indexOf(primaryPanel)
        const aria = calculateSeparatorAriaValues({ layout, panelConstraints: derivedPanelConstraints, panelId: primaryPanel.id, panelIndex })
        setAttribute(separator.element, "aria-controls", aria.valueControls)
        setAttribute(separator.element, "aria-valuemax", aria.valueMax === undefined ? undefined : String(aria.valueMax))
        setAttribute(separator.element, "aria-valuemin", aria.valueMin === undefined ? undefined : String(aria.valueMin))
        setAttribute(separator.element, "aria-valuenow", aria.valueNow === undefined ? undefined : String(aria.valueNow))
      }
    })
    // Panel's useSyncExternalStore: restyle on every change to the group.
    const removeStyleListener = subscribeToMountedGroup(groupId, () => {
      for (const panel of inputs.current().panels) applyPanelStyle(panel)
    })

    const unmountGroup = mountGroup(group)

    const mounted = getMountedGroupState(groupId, true)
    if (!mounted.defaultLayoutDeferred && mounted.derivedPanelConstraints.length > 0) {
      reportLayoutChanged(mounted.layout, false)
    }

    const removeChangeListener = subscribeToMountedGroup(groupId, (event) => {
      const { defaultLayoutDeferred, derivedPanelConstraints, layout } = event.next
      if (defaultLayoutDeferred || derivedPanelConstraints.length === 0) return

      const panelIdsKey = group.panels.map(({ id }) => id).join(",")
      group.mutableState.layouts[panelIdsKey] = layout

      derivedPanelConstraints.forEach((constraints) => {
        if (constraints.collapsible) {
          const prevLayout = event.prev?.layout
          if (prevLayout) {
            const isCollapsed = layoutNumbersEqual(constraints.collapsedSize, layout[constraints.panelId])
            const wasCollapsed = layoutNumbersEqual(constraints.collapsedSize, prevLayout[constraints.panelId])
            if (isCollapsed && !wasCollapsed) {
              group.mutableState.expandedPanelSizes[constraints.panelId] = prevLayout[constraints.panelId]!
            }
          }
        }
      })

      if (getInteractionState().state !== "active") reportLayoutChanged(layout, event.isUserInteraction)
    })

    registered = {
      group,
      unmount: unmountGroup,
      stopListening: () => {
        removeChangeListener()
        removeStyleListener()
        removeAriaListener()
        removeInteractionListener()
      },
    }
  }

  function unregister() {
    if (!registered) return
    registered.unmount()
    registered.stopListening()
    registered = null
  }

  // Separator's onFocus / onBlur.
  const handleFocusIn = (event: FocusEvent) => {
    const target = event.target as Element | null
    if (target?.parentElement !== element || target.getAttribute("role") !== "separator") return
    focusedSeparators.add(target.id)
    const separator = inputs.current().separators.find((current) => current.id === target.id)
    if (separator) applySeparatorState(separator)
  }
  const handleFocusOut = (event: FocusEvent) => {
    const target = event.target as Element | null
    if (target?.parentElement !== element || target.getAttribute("role") !== "separator") return
    focusedSeparators.delete(target.id)
    const separator = inputs.current().separators.find((current) => current.id === target.id)
    if (separator) applySeparatorState(separator)
  }
  element.addEventListener("focusin", handleFocusIn)
  element.addEventListener("focusout", handleFocusOut)

  register()

  return () => {
    element.removeEventListener("focusin", handleFocusIn)
    element.removeEventListener("focusout", handleFocusOut)
    unregister()
    inputs.stop()
  }
}

/** The group's Mount: registers its panels and separators with the core. */
export const PanelGroup = Mount.defineStream("ResizablePanelGroup", {
  args: { id: Schema.String },
  messages: [Message.ChangedGroupLayout],
  execute: ({ element, id }) => domStream<Message>((emit) => setupGroup(element as HTMLElement, id, emit)),
})

/** The group's imperative handle (`groupRef`): read or set its layout. For Commands and Mounts. */
export function groupHandle(groupId: string) {
  return getImperativeGroupMethods({ groupId })
}

// VIEW

function panelView<ParentMessage>(item: PanelItem, orientation: Orientation, h: HtmlBuilder<ParentMessage>): Html {
  return h.keyed("div")(item.id, [
    h.Id(item.id),
    h.DataAttribute("panel", "true"),
    h.DataAttribute("testid", item.id),
    ...(item.disabled ? [h.DataAttribute("disabled", "true")] : []),
    h.Style(PANEL_STYLE),
  ], [
    h.div([
      ...(item.className ? [h.Class(item.className)] : []),
      h.Style({
        "max-height": "100%",
        "max-width": "100%",
        "flex-grow": "1",
        overflow: "auto",
        ...item.style,
        "touch-action": orientation === "horizontal" ? "pan-y" : "pan-x",
      }),
    ], item.content),
  ])
}

function separatorView<ParentMessage>(item: SeparatorItem, orientation: Orientation, disableCursor: boolean, h: HtmlBuilder<ParentMessage>): Html {
  return h.keyed("div")(item.id, [
    ...(item.disabled ? [h.AriaDisabled(true)] : []),
    h.AriaOrientation(orientation === "horizontal" ? "vertical" : "horizontal"),
    ...(item.className ? [h.Class(item.className)] : []),
    h.DataAttribute("separator", item.disabled ? "disabled" : "inactive"),
    h.DataAttribute("testid", item.id),
    h.Id(item.id),
    h.Role("separator"),
    h.Style({
      "flex-basis": "auto",
      ...(item.disabled && !disableCursor ? { cursor: "not-allowed" } : {}),
      ...item.style,
      "flex-grow": "0",
      "flex-shrink": "0",
      "touch-action": "none",
    }),
    ...(item.disabled ? [] : [h.Tabindex(0)]),
  ], item.content)
}

/** `<Group>`: the library's group element, its panels and separators. */
export function panelGroup<ParentMessage>(options: GroupOptions<ParentMessage>, h: HtmlBuilder<ParentMessage>): Html {
  const orientation = options.orientation ?? "horizontal"
  const disableCursor = options.disableCursor ?? false
  const spec: GroupSpec = {
    orientation,
    disabled: options.disabled ?? false,
    disableCursor,
    defaultLayout: options.defaultLayout ?? null,
    panels: options.items.flatMap((item) => item.kind === "panel"
      ? [{
        id: item.id,
        defaultSize: item.defaultSize,
        minSize: item.minSize,
        maxSize: item.maxSize,
        collapsedSize: item.collapsedSize,
        collapsible: item.collapsible,
        disabled: item.disabled,
        groupResizeBehavior: item.groupResizeBehavior,
      }]
      : []),
    separators: options.items.flatMap((item) => item.kind === "separator"
      ? [{ id: item.id, disabled: item.disabled, disableDoubleClick: item.disableDoubleClick }]
      : []),
  }
  const attributes = [
    ...(options.className ? [h.Class(options.className)] : []),
    h.DataAttribute("group", "true"),
    h.DataAttribute("testid", options.id),
    h.Id(options.id),
    h.Style({
      height: "100%",
      width: "100%",
      overflow: "hidden",
      ...options.style,
      display: "flex",
      "flex-direction": orientation === "horizontal" ? "row" : "column",
      "flex-wrap": "nowrap",
      "touch-action": orientation === "horizontal" ? "pan-y" : "pan-x",
    }),
    mountInputs(spec, h),
    h.OnMount(Mount.mapMessage(PanelGroup({ id: options.id }), options.toMessage)),
  ]
  const children = options.items.map((item) => item.kind === "panel"
    ? panelView(item, orientation, h)
    : separatorView(item, orientation, disableCursor, h))
  return options.key === undefined
    ? h.div(attributes, children)
    : h.keyed("div")(options.key, attributes, children)
}

// The shadcn wrappers (src/client/components/ui/resizable.tsx).

/** `<ResizablePanelGroup>`: the group with `flex h-full w-full` in front of its classes. */
export function resizablePanelGroup<ParentMessage>(options: GroupOptions<ParentMessage>, h: HtmlBuilder<ParentMessage>): Html {
  return panelGroup({ ...options, className: cn("flex h-full w-full", options.className) }, h)
}

/** `<ResizablePanel>`. */
export function resizablePanel(item: Omit<PanelItem, "kind">): PanelItem {
  return { kind: "panel", ...item }
}

/**
 * `<ResizableHandle>`: a separator with its hit area classes, the 1px line
 * `withHandle` draws, and the screen reader's "Resize rows/columns".
 */
export function resizableHandle<ParentMessage>(options: {
  id: string
  orientation: Orientation
  withHandle?: boolean
  disabled?: boolean
  className?: string
}, h: HtmlBuilder<ParentMessage>): SeparatorItem {
  return {
    kind: "separator",
    id: options.id,
    disabled: options.disabled,
    className: cn(
      "relative flex items-center justify-center bg-transparent focus-visible:outline-none",
      options.orientation === "vertical"
        ? "h-2 w-full -my-1 cursor-row-resize"
        : "h-full w-2 -mx-1 cursor-col-resize",
      options.withHandle && (
        // One pixel, just below the seam rather than astride it: what's
        // above (the composer, drawn over the transcript's foot) covered
        // the upper half of a centred 2px line and nothing covered it beside
        // that, so the line doubled in thickness under the widget column.
        options.orientation === "vertical"
          ? "before:absolute before:inset-x-0 before:top-1/2 before:h-px before:bg-border"
          : "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border"
      ),
      options.className,
    ),
    content: [
      h.span([h.Class("sr-only")], [options.orientation === "vertical" ? "Resize rows" : "Resize columns"]),
    ],
  }
}
