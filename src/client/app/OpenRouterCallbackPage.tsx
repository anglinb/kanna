import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Check, Loader2 } from "lucide-react"
import { OpenRouterIcon } from "../components/provider-icons"
import { Button } from "../components/ui/button"
import { createStandaloneKannaSocket } from "./useKannaState"

export const OPENROUTER_AUTH_CHANNEL = "kanna-openrouter-auth"

type CallbackState =
  | { status: "exchanging" }
  | { status: "done" }
  | { status: "error"; message: string }

/**
 * OAuth PKCE callback target (usually opened as a popup). Exchanges the
 * one-time code through the server (which holds the verifier), then notifies
 * the opener via BroadcastChannel and closes itself.
 */
export function OpenRouterCallbackPage() {
  const [state, setState] = useState<CallbackState>({ status: "exchanging" })
  const navigate = useNavigate()
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const code = new URLSearchParams(window.location.search).get("code")
    if (!code) {
      setState({ status: "error", message: "Missing authorization code in the callback URL." })
      return
    }

    const socket = createStandaloneKannaSocket()
    socket.start()
    void socket
      .command({ type: "auth.openrouter.exchange", code })
      .then(() => {
        setState({ status: "done" })
        try {
          new BroadcastChannel(OPENROUTER_AUTH_CHANNEL).postMessage("done")
        } catch {
          // BroadcastChannel unavailable — the auth snapshot push covers it.
        }
        if (window.opener) {
          window.setTimeout(() => window.close(), 800)
        }
      })
      .catch((error) => {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "The key exchange failed.",
        })
      })
      .finally(() => {
        window.setTimeout(() => socket.dispose(), 1_000)
      })
  }, [])

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-border bg-card/40 px-6 py-8 text-center">
        <OpenRouterIcon className="h-8 w-8 text-foreground" />
        {state.status === "exchanging" ? (
          <>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Connecting OpenRouter…
            </div>
          </>
        ) : state.status === "done" ? (
          <>
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Check className="h-4 w-4 text-emerald-500" />
              OpenRouter connected
            </div>
            <p className="text-sm text-muted-foreground">
              {window.opener ? "You can close this window." : "Your API key was saved."}
            </p>
            {!window.opener ? (
              <Button variant="outline" size="sm" onClick={() => navigate("/settings/providers")}>
                Back to Settings
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <div className="text-sm font-medium text-destructive">OpenRouter sign-in failed</div>
            <p className="text-sm text-muted-foreground">{state.message}</p>
            <Button variant="outline" size="sm" onClick={() => navigate("/settings/providers")}>
              Back to Settings
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
