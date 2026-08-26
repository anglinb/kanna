import { useCallback, useEffect, useState } from "react"
import type { PendingSecretRequest, SecretRequestsSnapshot, SecretScope } from "../../shared/secrets"
import type { KannaSocket } from "./socket"

export interface SecretRequestsState {
  activeRequest: PendingSecretRequest | null
  requests: PendingSecretRequest[]
  submit: (args: { requestId: string; scope: SecretScope; value: string }) => Promise<unknown>
  cancel: (requestId: string) => void
}

/**
 * Pending ask-for-secret prompts, newest last. App-level rather than
 * chat-level: the CLI that raises one is spawned by a harness process and has
 * no chat id to attach to, so there is no transcript position to anchor it to.
 * It surfaces inline above the composer instead.
 */
export function useSecretRequests(socket: KannaSocket): SecretRequestsState {
  const [requests, setRequests] = useState<PendingSecretRequest[]>([])

  useEffect(() => {
    return socket.subscribe<SecretRequestsSnapshot>({ type: "secret-requests" }, (snapshot) => {
      setRequests(snapshot?.requests ?? [])
    })
  }, [socket])

  const submit = useCallback(
    (args: { requestId: string; scope: SecretScope; value: string }) =>
      socket.command({
        type: "secret.submit",
        requestId: args.requestId,
        scope: args.scope,
        value: args.value,
      }),
    [socket],
  )

  const cancel = useCallback(
    (requestId: string) => {
      void socket.command({ type: "secret.cancel", requestId })
    },
    [socket],
  )

  return {
    // One at a time: two stacked prompts would be unreadable, and the next
    // request surfaces as soon as this one settles.
    activeRequest: requests[0] ?? null,
    requests,
    submit,
    cancel,
  }
}
