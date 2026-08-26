import { Eye, EyeOff, FolderLock, Globe, KeyRound, LoaderCircle, ShieldCheck } from "lucide-react"
import { useEffect, useState } from "react"
import type { PendingSecretRequest, SecretScope } from "../../../shared/secrets"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { ChoiceCard, ChoiceRow } from "../ui/choice"

/**
 * The user-facing half of ask-for-secret, rendered inline above the composer
 * rather than as a modal — same shape as the AskUserQuestion prompt, because
 * it is the same kind of interruption: the agent is blocked waiting on you.
 *
 * The value typed here goes over the socket once, straight to a 0600 file on
 * disk. It is never echoed back in a snapshot, never written to the
 * transcript, and never shown to the agent.
 */
export function SecretRequestCard({
  request,
  onSubmit,
  onCancel,
}: {
  request: PendingSecretRequest | null
  onSubmit: (args: { requestId: string; scope: SecretScope; value: string }) => Promise<unknown>
  onCancel: (requestId: string) => void
}) {
  const [value, setValue] = useState("")
  const [scope, setScope] = useState<SecretScope>("project")
  const [isSaving, setIsSaving] = useState(false)
  const [isRevealed, setIsRevealed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canUseProjectScope = Boolean(request?.projectPath)

  // Reset per request so a second prompt never inherits the first one's typing.
  useEffect(() => {
    if (!request) return
    setValue("")
    setError(null)
    setIsSaving(false)
    // Back to masked for each new prompt — revealing is a per-value choice.
    setIsRevealed(false)
    setScope(!canUseProjectScope ? "global" : request.suggestedScope ?? "project")
  }, [request?.id, canUseProjectScope])

  if (!request) return null

  const submit = async () => {
    if (!value || isSaving) return
    setIsSaving(true)
    setError(null)
    try {
      await onSubmit({ requestId: request.id, scope, value })
      setValue("")
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError))
      setIsSaving(false)
    }
  }

  const projectLabel = request.projectTitle ?? request.projectPath ?? "this project"

  return (
    <div className="mx-auto w-full max-w-[840px] space-y-3 px-1 pb-3">
      <ChoiceCard>
        <div className="flex items-center gap-2 border-b border-border bg-card p-3 px-4 text-sm font-medium text-foreground">
          <KeyRound className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{request.name}</span>
        </div>

        {request.reason ? (
          <p className="border-b border-border bg-background px-4 pb-2.5 pt-2.5 text-sm text-muted-foreground">
            {request.reason}
          </p>
        ) : null}

        {/* pl-4/pr-5 matches ChoiceRow so the reveal toggle lines up with the
            scope check indicators directly below it. */}
        <div className="flex items-center gap-3 border-b border-border bg-background py-2.5 pl-4 pr-5">
          <input
            autoFocus
            type={isRevealed ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            placeholder={`Value for ${request.name}`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && value) {
                event.preventDefault()
                void submit()
              }
              if (event.key === "Escape") {
                event.preventDefault()
                onCancel(request.id)
              }
            }}
            className="min-h-[34px] min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={() => setIsRevealed((previous) => !previous)}
            aria-label={isRevealed ? "Hide value" : "Reveal value"}
            title={isRevealed ? "Hide value" : "Reveal value"}
            className={cn(
              "flex h-5 w-5 flex-shrink-0 items-center justify-center rounded transition-opacity",
              "text-muted-foreground hover:text-foreground",
            )}
          >
            {isRevealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>

        <ChoiceRow
          icon={<FolderLock className="size-4" />}
          label="This project only"
          description={
            canUseProjectScope
              ? `${projectLabel} · .kanna/secrets/ (git-ignored)`
              : "Unavailable — the agent did not run inside a known project"
          }
          selected={scope === "project"}
          disabled={!canUseProjectScope}
          onClick={canUseProjectScope ? () => setScope("project") : undefined}
        />
        <ChoiceRow
          icon={<Globe className="size-4" />}
          label="All projects on this machine"
          description="~/.kanna/secrets/"
          selected={scope === "global"}
          onClick={() => setScope("global")}
          isLast
        />
      </ChoiceCard>

      <div className="flex items-center justify-between gap-3 px-2">
        <p className="flex min-w-0 items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">
            Saved to a file the agent loads into a shell — the value never enters its context or
            this transcript.
          </span>
        </p>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full"
            onClick={() => onCancel(request.id)}
            disabled={isSaving}
          >
            Decline
          </Button>
          <Button
            size="sm"
            className={cn("rounded-full", (!value || isSaving) && "cursor-not-allowed opacity-50")}
            onClick={() => void submit()}
            disabled={!value || isSaving}
          >
            {isSaving ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Save secret
          </Button>
        </div>
      </div>

      {error ? <p className="px-2 text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
