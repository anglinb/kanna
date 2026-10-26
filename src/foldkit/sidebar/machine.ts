import type { Html, HtmlBuilder } from "foldkit/html"
import { displayClaimUrl, type PairSessionState } from "../../client/lib/pairSession"
import { cn } from "../../client/lib/utils"
import type { CloudMachineSummary } from "../../shared/cloud-api"
import type { AppModel } from "../app/slice"
import { findCurrentMachine } from "../core/stores/connection"
import { animatedShinyText } from "../ui/animated-shiny-text"
import * as Dialog from "../ui/dialog"
import { ArrowUpRight, Check, ChevronsUpDown, Cloud, Copy, ExternalLink, LaptopMinimal, Loader2, RefreshCw, Settings2 } from "../ui/icons"
import * as Popover from "../ui/popover"
import { Message } from "./message"
import type { Model } from "./model"
import { inputPopoverTriggerClass, popoverMenuItem } from "./view-parts"

type H = HtmlBuilder<Message>

// The machine switcher above Settings (app/MachineSwitcher.tsx), and the
// Kanna Cloud pairing dialog it opens (components/cloud/CloudPairPanel.tsx).

export const FLEET_URL = "https://kanna.sh/fleet"
const THIS_MAC_NAME = "This Mac"

const TRIGGER_CLASS = "w-full justify-between py-1.5 rounded-md transition-colors duration-150 hover:bg-transparent hover:text-foreground data-[state=open]:text-foreground"

const SIDEBAR_BUTTON_CLASS = cn(
  "flex items-center gap-1.5 px-[10px] text-sm text-muted-foreground [&>svg]:shrink-0 [&>span]:whitespace-nowrap",
  TRIGGER_CLASS,
)

/** Whether MachineSwitcher's effect would ask the connection store to load now. */
export function connectionLoadNeeded(app: AppModel): boolean {
  const capabilities = app.stores.serverCapabilities.value
  const mode = app.stores.connection.mode
  return Boolean(capabilities && (mode === "unknown" || (!capabilities.cloud && mode !== "local")))
}

/** useCloudPairSession's `enabled`: a cloud-capable machine not on Kanna Cloud yet. */
export function pairSessionEnabled(app: AppModel): boolean {
  return app.stores.serverCapabilities.value?.cloud === true && app.stores.connection.mode === "local"
}

function machineSection(children: ReadonlyArray<Html>, h: H): Html {
  return h.div([h.Class("pl-2.5 pr-[7px] py-1 border-t ")], children)
}

function onlineDot(online: boolean, h: H): Html {
  return h.span([h.Class("flex size-4 shrink-0 items-center justify-center"), h.AriaHidden(true)], [
    h.span([h.Class(`size-2 rounded-full ${online ? "bg-emerald-500" : "bg-slate-400 dark:bg-slate-600"}`)]),
  ])
}

// CLOUD PAIR PANEL

const PRIMARY_ACTION_CLASS =
  "inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition-[scale,background-color,opacity] duration-150 ease-snappy hover:bg-primary/90 active:scale-[0.97]"
const OUTBOUND_ARROW_CLASS =
  "h-4 w-4 transition-transform duration-150 ease-snappy motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5"

type PairView = "link" | "paired" | "retry" | "manual"

function viewFor(session: PairSessionState): PairView {
  if (session.status === "paired" && session.appOrigin) return "paired"
  if (session.status === "unsupported") return "manual"
  if (session.status === "expired" || session.status === "error") return "retry"
  return "link"
}

function pairedSuccess(appOrigin: string, h: H): Html {
  const host = displayClaimUrl(appOrigin)
  return h.div([h.Class("cloud-pair-rows flex flex-col items-center gap-4 py-2 text-center")], [
    h.div([h.Class("cloud-pair-badge relative flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15")], [
      h.span([h.AriaHidden(true), h.Class("cloud-pair-ring absolute inset-0 rounded-full border border-emerald-500/60")]),
      h.svg([
        h.Attribute("aria-hidden", "true"),
        h.Attribute("viewBox", "0 0 24 24"),
        h.Attribute("fill", "none"),
        h.Attribute("stroke", "currentColor"),
        h.Attribute("stroke-width", "2"),
        h.Attribute("stroke-linecap", "round"),
        h.Attribute("stroke-linejoin", "round"),
        h.Class("cloud-pair-check h-5 w-5 text-emerald-500"),
      ], [h.path([h.Attribute("d", "M4 12l5 5L20 6"), h.Attribute("pathLength", "1")])]),
    ]),
    h.p([h.Class("text-sm text-muted-foreground")], [
      "This machine is live at ",
      h.span([h.Class("font-medium text-foreground")], [host]),
      " — it stays reachable while kanna is running.",
    ]),
    h.a([h.Href(appOrigin), h.Target("_blank"), h.Rel("noreferrer"), h.Class(cn(PRIMARY_ACTION_CLASS, "group"))], [
      `Open ${host}`,
      ArrowUpRight({ class: OUTBOUND_ARROW_CLASS }, h),
    ]),
  ])
}

function manualInstructions(h: H): Html {
  return h.ol([h.Class("cloud-pair-rows list-decimal space-y-2 pl-5 text-sm")], [
    h.li([], [
      "Sign in at ",
      h.a([h.Href(FLEET_URL), h.Target("_blank"), h.Rel("noreferrer"), h.Class("font-medium underline underline-offset-2")], ["kanna.sh/fleet"]),
      " and add a machine to your Fleet.",
    ]),
    h.li([], [
      "Run ",
      h.code([h.Class("rounded bg-muted px-1.5 py-0.5 text-xs")], ["bunx kanna pair <code>"]),
      " in a terminal on this machine.",
    ]),
  ])
}

function retryLink(session: PairSessionState, starting: boolean, h: H): Html {
  return h.div([h.Class("cloud-pair-rows flex flex-col items-center gap-3 py-2 text-center")], [
    h.p([h.Class("text-sm text-muted-foreground")], [
      session.status === "expired" ? "That link expired." : `Couldn't reach kanna.sh${session.error ? ` (${session.error})` : ""}.`,
    ]),
    h.button([
      h.Type("button"),
      h.OnClick(Message.ClickedRetryPair()),
      ...(starting ? [h.Disabled(true)] : []),
      h.Class(cn(PRIMARY_ACTION_CLASS, "disabled:opacity-60 disabled:active:scale-100")),
    ], [RefreshCw({ class: cn("h-4 w-4", starting && "animate-spin") }, h), "Get a new link"]),
  ])
}

function claimLink(claimUrl: string | undefined, copied: boolean, h: H): Html {
  const ready = Boolean(claimUrl)
  const swapClass = "col-start-1 row-start-1 min-w-0 justify-self-start transition-[opacity,filter] duration-200 ease-snappy"
  const hiddenClass = "pointer-events-none opacity-0 blur-[2px]"
  const iconClass = "absolute inset-0 m-auto size-3.5 transition-[opacity,scale,filter] duration-150 ease-snappy"
  return h.div([h.Class("cloud-pair-rows flex flex-col items-center gap-4")], [
    h.div([h.Class("flex h-9 w-full items-center gap-1 rounded-full border border-border bg-muted/40 pl-3.5 pr-1")], [
      h.div([h.Class("grid min-w-0 flex-1 items-center")], [
        animatedShinyText({
          animate: !ready,
          class: cn(swapClass, "mx-0 max-w-full text-xs", ready && hiddenClass),
          attributes: [h.AriaHidden(ready)],
        }, ["Getting your link…"], h),
        h.a([
          ...(claimUrl ? [h.Href(claimUrl)] : []),
          h.Target("_blank"),
          h.Rel("noreferrer"),
          h.AriaHidden(!ready),
          h.Class(cn(swapClass, "max-w-full truncate font-mono text-xs text-muted-foreground hover:text-foreground", !ready && hiddenClass)),
        ], [claimUrl ? displayClaimUrl(claimUrl) : ""]),
      ]),
      h.button([
        h.Type("button"),
        ...(!ready ? [h.Disabled(true)] : []),
        h.Title(copied ? "Copied" : "Copy link"),
        h.AriaLabel(copied ? "Copied" : "Copy link"),
        h.OnClick(Message.ClickedCopyPairLink({ text: claimUrl ?? "" })),
        h.Class("relative size-7 shrink-0 rounded-full text-muted-foreground transition-[scale,background-color,color,opacity] duration-150 ease-snappy hover:bg-foreground/5 hover:text-foreground active:scale-[0.95] disabled:pointer-events-none disabled:opacity-0"),
      ], [
        Copy({ class: cn(iconClass, copied ? "scale-50 opacity-0 blur-[2px]" : "scale-100 opacity-100") }, h),
        Check({ class: cn(iconClass, "text-emerald-500", copied ? "scale-100 opacity-100" : "scale-50 opacity-0 blur-[2px]") }, h),
      ]),
    ]),
    h.a([
      ...(claimUrl ? [h.Href(claimUrl)] : []),
      h.Target("_blank"),
      h.Rel("noreferrer"),
      h.AriaDisabled(!ready),
      h.Class(cn(PRIMARY_ACTION_CLASS, "group mt-1 w-full", !ready && "pointer-events-none opacity-50")),
    ], ["Open link & sign in", ArrowUpRight({ class: OUTBOUND_ARROW_CLASS }, h)]),
  ])
}

/**
 * The claim URL to open or copy, and every state the session can be in.
 * The views swap inside the panel's stage (motion in index.css, under
 * "Kanna Cloud pairing"); the leaving view's fade is not reproduced.
 */
function cloudPairPanel(session: PairSessionState, starting: boolean, copied: boolean, h: H): Html {
  const view = viewFor(session)
  return h.div([h.Class("cloud-pair-stage -m-1 overflow-clip")], [
    h.div([h.Class("relative p-1")], [
      h.keyed("div")(view, [], [
        view === "paired" && session.appOrigin
          ? pairedSuccess(session.appOrigin, h)
          : view === "manual"
            ? manualInstructions(h)
            : view === "retry"
              ? retryLink(session, starting, h)
              : claimLink(session.status === "waiting" ? session.claimUrl : undefined, copied, h),
      ]),
    ]),
  ])
}

// THE SWITCHER

export function machineSwitcher(app: AppModel, model: Model, h: H): Html {
  const capabilities = app.stores.serverCapabilities.value
  const connection = app.stores.connection
  if (!capabilities?.cloud || connection.mode === "unknown") return null

  if (connection.mode === "local") {
    const session = model.pairSession
    const pairedOrigin = session.status === "paired" ? session.appOrigin ?? null : null
    const label = (text: string) => h.span([h.Class("flex min-w-0 items-center gap-2")], [
      Cloud({ class: "ml-[1px] size-4 shrink-0" }, h),
      h.span([h.Class("truncate text-xs font-medium")], [text]),
    ])
    return machineSection([
      pairedOrigin
        ? h.a([h.Href(pairedOrigin), h.Target("_blank"), h.Rel("noreferrer"), h.Class(SIDEBAR_BUTTON_CLASS)], [
          label(displayClaimUrl(pairedOrigin)),
          ExternalLink({ class: "size-3.5 shrink-0 opacity-60" }, h),
        ])
        : h.button([h.Type("button"), h.OnClick(Message.ClickedSetupCloud()), h.Class(SIDEBAR_BUTTON_CLASS)], [
          label("Setup Kanna Cloud"),
          ExternalLink({ class: "size-3.5 shrink-0 opacity-60" }, h),
        ]),
      h.submodel({
        slotId: "sidebar-cloud-pair",
        model: model.pairDialog,
        view: Dialog.view,
        viewInputs: {
          content: ({ titleId, descriptionId }) => [
            Dialog.dialogHeader({}, [
              Dialog.dialogTitle({ id: titleId }, ["Use this machine from anywhere"], h),
              Dialog.dialogDescription({ id: descriptionId }, ["Get a personal URL that works from any browser, 100% free."], h),
            ], h),
            Dialog.dialogBody({}, [cloudPairPanel(session, model.pairStarting, model.pairCopied, h)], h),
          ],
        },
        toParentMessage: (message) => Message.GotPairDialogMessage({ message }),
      }),
    ], h)
  }

  // On localhost and in Kanna for Mac the page knows which machine it's on,
  // and lists it first as This machine.
  const knowsSelf = connection.fromMacApp || connection.thisMachine !== null
  const thisMachineLabel = connection.fromMacApp ? THIS_MAC_NAME : "This machine"
  const machines = connection.machines
  const thisMachine = knowsSelf ? machines.find((machine) => machine.subdomain === connection.thisMachine) : undefined
  const currentMachine = knowsSelf
    ? machines.find((machine) => machine.subdomain === (connection.showingMachine ?? connection.thisMachine)) ?? null
    : findCurrentMachine(machines)
  const showingThisMac = knowsSelf && (connection.showingMachine === null || connection.showingMachine === connection.thisMachine)
  const otherMachines = knowsSelf ? machines.filter((machine) => machine.subdomain !== connection.thisMachine) : machines
  const choose = (machine: CloudMachineSummary | null) => Message.ChoseMachine({
    subdomain: machine?.subdomain ?? null,
    name: machine?.name ?? thisMachine?.name ?? THIS_MAC_NAME,
    appOrigin: machine?.appOrigin ?? null,
  })

  return machineSection([
    h.submodel({
      slotId: "sidebar-machine-switcher",
      model: model.machineSwitcher,
      view: Popover.view,
      viewInputs: {
        className: "w-64 overflow-hidden p-0",
        content: () => [
          h.div([h.Class("max-h-80 overflow-y-auto divide-y divide-border/60")], [
            knowsSelf
              ? popoverMenuItem({
                onClick: showingThisMac ? Message.ClosedMachineSwitcher() : choose(null),
                selected: showingThisMac,
                icon: onlineDot(true, h),
                label: [h.span([h.Class("[overflow-wrap:anywhere]")], [thisMachine?.name ?? thisMachineLabel])],
                trailing: thisMachine ? h.span([h.Class("shrink-0 whitespace-nowrap text-xs text-muted-foreground")], [thisMachineLabel]) : null,
              }, h)
              : null,
            ...otherMachines.map((machine) => {
              const isCurrent = machine.subdomain === currentMachine?.subdomain
              return popoverMenuItem({
                onClick: isCurrent ? Message.ClosedMachineSwitcher() : choose(machine),
                selected: isCurrent,
                icon: onlineDot(machine.online, h),
                label: [machine.name],
              }, h)
            }),
            popoverMenuItem({
              onClick: Message.ClickedManageFleet(),
              selected: false,
              icon: Settings2({ class: "size-4 shrink-0 text-muted-foreground" }, h),
              label: ["Manage Fleet"],
              trailing: ExternalLink({ class: "size-3.5 shrink-0 text-muted-foreground" }, h),
            }, h),
          ].filter((child): child is Html => child !== null)),
        ],
        toView: ({ trigger, portal }) => h.button([
          ...trigger,
          h.Class(inputPopoverTriggerClass(cn(TRIGGER_CLASS, "px-[11px]"))),
        ], [
          h.span([h.Class("flex min-w-0 items-center gap-2")], [
            LaptopMinimal({ class: "size-4 shrink-0" }, h),
            h.span([h.Class("truncate text-xs font-medium")], [
              model.switchingTo ?? currentMachine?.name ?? (showingThisMac ? THIS_MAC_NAME : window.location.hostname),
            ]),
          ]),
          model.switchingTo !== null
            ? Loader2({ class: "size-3.5 shrink-0 animate-spin", attributes: [h.AriaLabel(`Switching to ${model.switchingTo}`)] }, h)
            : ChevronsUpDown({ class: "size-3.5 shrink-0 opacity-60" }, h),
          portal,
        ]),
      },
      toParentMessage: (message) => Message.GotMachineSwitcherMessage({ message }),
    }),
  ], h)
}
