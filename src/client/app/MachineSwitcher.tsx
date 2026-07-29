import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ArrowUpRight, Check, ChevronDown, Cloud, ExternalLink, LaptopMinimal, RefreshCw } from "lucide-react"
import { renderSVG } from "uqr"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog"
import { CopyButton } from "../components/ui/copy-button"
import { InputPopover, PopoverMenuItem } from "../components/chat-ui/ChatPreferenceControls"
import { findCurrentMachine, useConnectionStore } from "../stores/connectionStore"
import {
  displayClaimUrl,
  fetchPairSession,
  startPairSession,
  type PairSessionState,
} from "../lib/pairSession"
import { cn } from "../lib/utils"

const MANAGE_MACHINES_URL = "https://kanna.sh/machines"

/** While the setup dialog is open, mirror the machine's own poll cadence. */
const PAIR_POLL_MS = 2_000

/** Shared trigger padding: borderless, but keeps the same net inset as before. */
const TRIGGER_CLASS = "w-full justify-between py-1.5 rounded-md hover:bg-transparent"

const SIDEBAR_BUTTON_CLASS = cn(
  "flex items-center gap-1.5 px-[10px] text-sm text-muted-foreground [&>svg]:shrink-0 [&>span]:whitespace-nowrap",
  TRIGGER_CLASS
)

/** Wrapper for the sidebar footer: sits just above the Settings button. */
function MachineSection({ children }: { children: ReactNode }) {
  return <div className="pl-2.5 pr-[7px] py-1 border-t ">{children}</div>
}

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${online ? "bg-emerald-500" : "bg-slate-400 dark:bg-slate-600"}`}
      aria-hidden
    />
  )
}

/**
 * QR for the claim URL. Always rendered light-on-white regardless of theme —
 * phone cameras want the contrast, and an inverted code doesn't scan on some
 * scanners.
 */
function ClaimQr({ url }: { url: string }) {
  const svg = useMemo(() => renderSVG(url, { ecc: "M", border: 2, pixelSize: 8 }), [url])
  return (
    <div
      className="mx-auto w-[172px] rounded-lg bg-white p-2 [&>svg]:h-full [&>svg]:w-full"
      // uqr returns a self-contained <svg> string built from the URL above.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

/** The old two-step flow, kept for runs that can't pair in place. */
function ManualPairInstructions() {
  return (
    <ol className="list-decimal space-y-2 pl-5 text-sm">
      <li>
        Sign in at{" "}
        <a href={MANAGE_MACHINES_URL} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
          kanna.sh/machines
        </a>{" "}
        and add a machine.
      </li>
      <li>
        Run{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">bunx kanna pair &lt;code&gt;</code>{" "}
        in a terminal on this machine.
      </li>
    </ol>
  )
}

function PairedSuccess({ appOrigin }: { appOrigin: string }) {
  const host = displayClaimUrl(appOrigin)
  return (
    <div className="space-y-4 py-2 text-center">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15">
        <Check className="h-5 w-5 text-emerald-500" />
      </div>
      <p className="text-sm text-muted-foreground">
        This machine is live at <span className="font-medium text-foreground">{host}</span> — it stays
        reachable while kanna is running.
      </p>
      <a
        href={appOrigin}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Open {host}
        <ArrowUpRight className="h-4 w-4" />
      </a>
    </div>
  )
}

/**
 * One-click cloud setup: the machine mints a claim URL, we show it as a link
 * and a QR, and the machine itself polls until someone finishes on kanna.sh.
 * Closing this dialog doesn't cancel anything.
 */
function PairDialog({
  open,
  onOpenChange,
  session,
  onRetry,
  starting,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  session: PairSessionState
  onRetry: () => void
  starting: boolean
}) {
  const claimUrl = session.claimUrl ?? ""

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Use this machine from anywhere</DialogTitle>
          <DialogDescription>
            Get a personal URL that works from any browser, 100% free.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {session.status === "paired" && session.appOrigin ? (
            <PairedSuccess appOrigin={session.appOrigin} />
          ) : session.status === "unsupported" ? (
            <ManualPairInstructions />
          ) : session.status === "waiting" && claimUrl ? (
            <div className="space-y-4">
              <ClaimQr url={claimUrl} />

              <div className="flex items-center gap-2 overflow-hidden rounded-lg border bg-muted/40 px-3 py-2">
                <a
                  href={claimUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate font-mono text-xs hover:underline"
                >
                  {displayClaimUrl(claimUrl)}
                </a>
                <CopyButton text={claimUrl} title="Copy link" />
              </div>

              <a
                href={claimUrl}
                target="_blank"
                rel="noreferrer"
                className="flex h-9 items-center justify-center gap-1.5 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Open link & sign in
                <ArrowUpRight className="h-4 w-4" />
              </a>

              <p className="text-center text-xs text-muted-foreground">
                Or scan the code to do the whole thing on your phone. Sign in, pick a name — this
                machine comes online on its own.
              </p>
            </div>
          ) : session.status === "expired" || session.status === "error" ? (
            <div className="space-y-3 py-2 text-center">
              <p className="text-sm text-muted-foreground">
                {session.status === "expired"
                  ? "That link expired."
                  : `Couldn't reach kanna.sh${session.error ? ` (${session.error})` : ""}.`}
              </p>
              <button
                type="button"
                onClick={onRetry}
                disabled={starting}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
              >
                <RefreshCw className="h-4 w-4" />
                Get a new link
              </button>
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">Getting your link…</p>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Sidebar machine switcher. Cloud mode lists the account's machines and
 * navigates between their subdomains (mode comes from connectionStore's
 * /__cloud/machines feature detection); local mode offers one-click pairing,
 * or a shortcut to the hosted URL once this machine has one.
 */
export function MachineSwitcher() {
  const mode = useConnectionStore((state) => state.mode)
  const machines = useConnectionStore((state) => state.machines)
  const load = useConnectionStore((state) => state.load)
  const [pairDialogOpen, setPairDialogOpen] = useState(false)
  const [session, setSession] = useState<PairSessionState>({ status: "idle" })
  const [starting, setStarting] = useState(false)
  const startedRef = useRef(false)

  useEffect(() => {
    if (mode === "unknown") {
      void load()
    }
  }, [mode, load])

  // On a local origin, ask the machine whether it already has a hosted URL —
  // if so the sidebar links to it instead of offering setup again.
  useEffect(() => {
    if (mode !== "local") return
    void fetchPairSession().then(setSession)
  }, [mode])

  const begin = useCallback(async () => {
    setStarting(true)
    setSession(await startPairSession())
    setStarting(false)
  }, [])

  // Mint a claim URL the first time the dialog opens; the server reuses a
  // live session, so reopening never burns a code.
  useEffect(() => {
    if (!pairDialogOpen || startedRef.current) return
    if (session.status === "paired" || session.status === "unsupported") return
    startedRef.current = true
    void begin()
  }, [pairDialogOpen, session.status, begin])

  // Keep polling while a claim is outstanding even with the dialog closed —
  // the user may be finishing on their phone.
  useEffect(() => {
    if (session.status !== "waiting") return
    const interval = window.setInterval(() => {
      void fetchPairSession().then(setSession)
    }, PAIR_POLL_MS)
    return () => window.clearInterval(interval)
  }, [session.status])

  if (mode === "unknown") {
    return null
  }

  if (mode === "local") {
    const pairedOrigin = session.status === "paired" ? session.appOrigin : null
    return (
      <MachineSection>
        {pairedOrigin ? (
          <a href={pairedOrigin} target="_blank" rel="noreferrer" className={SIDEBAR_BUTTON_CLASS}>
            <span className="flex min-w-0 items-center gap-2">
              <Cloud className="ml-[1px] size-4 shrink-0" />
              <span className="truncate text-xs font-medium">{displayClaimUrl(pairedOrigin)}</span>
            </span>
            <ExternalLink className="size-3.5 shrink-0 opacity-60" />
          </a>
        ) : (
          <button type="button" onClick={() => setPairDialogOpen(true)} className={SIDEBAR_BUTTON_CLASS}>
            <span className="flex min-w-0 items-center gap-2">
              <Cloud className="ml-[1px] size-4 shrink-0" />
              <span className="truncate text-xs font-medium">Setup Kanna Cloud</span>
            </span>
            <ExternalLink className="size-3.5 shrink-0 opacity-60" />
          </button>
        )}
        <PairDialog
          open={pairDialogOpen}
          onOpenChange={setPairDialogOpen}
          session={session}
          onRetry={() => void begin()}
          starting={starting}
        />
      </MachineSection>
    )
  }

  const currentMachine = findCurrentMachine(machines)

  return (
    <MachineSection>
      <InputPopover
        triggerClassName={cn(TRIGGER_CLASS, "px-[11px]")}
        trigger={
          <>
            <span className="flex min-w-0 items-center gap-2">
              <LaptopMinimal className="size-4 shrink-0" />
              <span className="truncate text-xs font-medium">
                {currentMachine?.name ?? window.location.hostname}
              </span>
            </span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" />
          </>
        }
      >
        {(close) => (
          <>
            {machines.map((machine) => {
              const isCurrent = machine.subdomain === currentMachine?.subdomain
              return (
                <PopoverMenuItem
                  key={machine.subdomain}
                  onClick={() => {
                    close()
                    if (!isCurrent) {
                      window.location.href = machine.appOrigin
                    }
                  }}
                  selected={isCurrent}
                  icon={<OnlineDot online={machine.online} />}
                  label={machine.name}
                  description={`${machine.subdomain}.kanna.sh${machine.online ? "" : " · offline"}`}
                />
              )
            })}
            <PopoverMenuItem
              onClick={() => {
                close()
                window.open(MANAGE_MACHINES_URL, "_blank", "noopener")
              }}
              selected={false}
              icon={<ExternalLink className="h-4 w-4" />}
              label="Manage machines"
              description="Add or remove machines on kanna.sh"
            />
          </>
        )}
      </InputPopover>
    </MachineSection>
  )
}
