import { Effect, Queue, Stream } from "effect"
import { ManagedResource } from "foldkit"
import { KannaSocket, type SocketStatus, type WsUrlSource } from "../../client/app/socket"
import { getServerCapabilities } from "../../client/stores/serverCapabilitiesStore"
import { CLOUD_WS_ENDPOINT_PATH, type CloudWsEndpointResponse } from "../../shared/cloud-api"
import type { ClientCommand, SubscriptionTopic, TerminalEvent, TerminalSnapshot } from "../../shared/protocol"

// The app's one WebSocket. `KannaSocket` (React-free, unchanged) does the
// reconnects, heartbeat, outbound queue and resubscribes; this file makes it
// a ManagedResource and gives Commands and Subscriptions an Effect view of it:
//
//   sendCommand<R>(command)      Effect<R, Error, KannaSocketService>
//   topicStream<T>(topic, opts)  Stream<T, never, KannaSocketService>
//   statusStream                 Stream<SocketStatus, never, KannaSocketService>
//
// Managed, not app-lifetime: the React client opened it only once the auth
// check passed (KannaLayout mounted), and a locked server must not see a
// socket knocking before the password. The root acquires it when auth is
// ready (`socketEntry`) and Subscriptions wait for `onAcquired`.

export type { SocketStatus }

export const KannaSocketResource = ManagedResource.tag<KannaSocket>()("KannaSocket")
export type KannaSocketService = ManagedResource.ServiceOf<typeof KannaSocketResource>

function sameOriginWsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}/ws`
}

/**
 * Resolved before every (re)connect. The machine always serves
 * /api/cloud/ws-endpoint: through the kanna.sh proxy it returns the direct
 * tunnel URL plus a fresh short-lived connect token (so the WebSocket
 * bypasses the proxy); locally it returns wsUrl null and we connect
 * same-origin. Any failure falls back to same-origin, keeping local behavior
 * unchanged. (Same as useKannaState's.)
 */
export async function wsUrlProvider(): Promise<string> {
  if (!(await getServerCapabilities()).cloud) return sameOriginWsUrl()
  try {
    const response = await fetch(CLOUD_WS_ENDPOINT_PATH, {
      headers: { Accept: "application/json" },
    })
    if (response.ok) {
      const payload = await response.json() as CloudWsEndpointResponse
      if (payload.wsUrl) {
        const url = new URL(payload.wsUrl)
        if (payload.connectToken) {
          url.searchParams.set("token", payload.connectToken)
        }
        return url.toString()
      }
    }
  } catch {
    // Endpoint unreachable — connect same-origin.
  }
  return sameOriginWsUrl()
}

/** For the root's ManagedResource entry: start on acquire, dispose on release. */
export function acquireSocket(url: WsUrlSource = wsUrlProvider) {
  return Effect.sync(() => {
    const socket = new KannaSocket(url)
    socket.start()
    return socket
  })
}

export function releaseSocket(socket: KannaSocket) {
  return Effect.sync(() => socket.dispose())
}

const notAvailable = () => new Error("Not connected")

/** One ClientCommand; succeeds with the ack's result, fails with the server's error. */
export function sendCommand<Result = unknown>(command: ClientCommand): Effect.Effect<Result, Error, KannaSocketService> {
  return Effect.gen(function* () {
    const socket = yield* KannaSocketResource.get.pipe(Effect.mapError(notAvailable))
    return yield* Effect.tryPromise({
      try: () => socket.command<Result>(command),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
  })
}

/** The message a failed command shows, as `setCommandError` stored it. */
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A subscription topic as a Stream of its snapshots: subscribes when the
 * Stream starts, unsubscribes when its scope closes (a Subscription entry's
 * dependencies changing, or the app stopping). `topicOnReconnect` is
 * KannaSocket's: the topic resent after a reconnect, e.g. a chat naming the
 * span it holds by then.
 */
export function topicStream<Snapshot>(
  topic: SubscriptionTopic,
  options?: { topicOnReconnect?: () => SubscriptionTopic },
): Stream.Stream<Snapshot, never, KannaSocketService> {
  return Stream.callback<Snapshot, never, KannaSocketService>((queue) =>
    Effect.gen(function* () {
      const socket = yield* KannaSocketResource.get.pipe(Effect.orDie)
      yield* Effect.acquireRelease(
        Effect.sync(() => socket.subscribe<Snapshot>(topic, (snapshot) => {
          Queue.offerUnsafe(queue, snapshot)
        }, undefined, options)),
        (unsubscribe) => Effect.sync(unsubscribe),
      )
    }),
  )
}

export type TerminalStreamItem =
  | { kind: "snapshot"; snapshot: TerminalSnapshot | null }
  | { kind: "event"; event: TerminalEvent }

/** A terminal's snapshots and events, in arrival order. */
export function terminalStream(terminalId: string): Stream.Stream<TerminalStreamItem, never, KannaSocketService> {
  return Stream.callback<TerminalStreamItem, never, KannaSocketService>((queue) =>
    Effect.gen(function* () {
      const socket = yield* KannaSocketResource.get.pipe(Effect.orDie)
      yield* Effect.acquireRelease(
        Effect.sync(() => socket.subscribeTerminal(terminalId, {
          onSnapshot: (snapshot) => {
            Queue.offerUnsafe(queue, { kind: "snapshot", snapshot })
          },
          onEvent: (event) => {
            Queue.offerUnsafe(queue, { kind: "event", event })
          },
        })),
        (unsubscribe) => Effect.sync(unsubscribe),
      )
    }),
  )
}

/** Connection status, starting with the current one (KannaSocket.onStatus calls back at once). */
export const statusStream: Stream.Stream<SocketStatus, never, KannaSocketService> =
  Stream.callback<SocketStatus, never, KannaSocketService>((queue) =>
    Effect.gen(function* () {
      const socket = yield* KannaSocketResource.get.pipe(Effect.orDie)
      yield* Effect.acquireRelease(
        Effect.sync(() => socket.onStatus((status) => {
          Queue.offerUnsafe(queue, status)
        })),
        (unsubscribe) => Effect.sync(unsubscribe),
      )
    }),
  )
