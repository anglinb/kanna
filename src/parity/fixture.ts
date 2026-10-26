// Must stay the first import of each parity app (react/, foldkit/): it
// installs the demo's fake socket and storage, then holds the backend's
// clock still and records every frame for the runner (scripts/parity).
import { configureDemoEnvironment } from "../demo/environment"
import { DEMO_UNAVAILABLE_MESSAGE, type DemoClock } from "../demo/backend"
import type { ClientCommand, ClientEnvelope, ServerEnvelope } from "../shared/protocol"
import type { ParityProbe } from "./probe"

// Date.now() is frozen by the runner (page.clock.setFixedTime), so seeded
// "3m ago" labels match across apps. Scripted turns run on this queue instead
// of real timers, and only move when a scenario calls advance().
class ManualClock implements DemoClock {
  private current: number
  private nextHandle = 1
  private readonly timers = new Map<number, { at: number; callback: () => void }>()

  constructor(start: number) {
    this.current = start
  }

  now() {
    return this.current
  }

  setTimeout(callback: () => void, ms: number) {
    const handle = this.nextHandle++
    this.timers.set(handle, { at: this.current + Math.max(0, ms), callback })
    return handle
  }

  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number)
  }

  advance(ms: number) {
    const target = this.current + ms
    for (;;) {
      let next: [number, { at: number; callback: () => void }] | undefined
      for (const entry of this.timers) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry
      }
      if (!next) break
      this.timers.delete(next[0])
      this.current = next[1].at
      next[1].callback()
    }
    this.current = target
  }

  pending() {
    return this.timers.size
  }
}

const clock = new ManualClock(Date.now())
const commands: ClientCommand[] = []
const subscriptions: unknown[] = []
const unhandled: ClientCommand[] = []
const commandsById = new Map<string, ClientCommand>()
let lastActivity = performance.now()

configureDemoEnvironment({
  clock,
  onClientEnvelope(envelope: ClientEnvelope) {
    lastActivity = performance.now()
    if (envelope.type === "command") {
      commands.push(envelope.command)
      commandsById.set(envelope.id, envelope.command)
    } else if (envelope.type === "subscribe") {
      subscriptions.push(envelope.topic)
    }
  },
  onServerEnvelope(envelope: ServerEnvelope) {
    lastActivity = performance.now()
    if (envelope.type === "error" && envelope.message === DEMO_UNAVAILABLE_MESSAGE) {
      const command = envelope.id === undefined ? undefined : commandsById.get(envelope.id)
      if (command) unhandled.push(command)
    }
  },
})

const probe: ParityProbe = {
  commands: () => commands,
  subscriptions: () => subscriptions,
  unhandled: () => unhandled,
  quietFor: () => performance.now() - lastActivity,
  advance: (ms) => clock.advance(ms),
  pendingTimers: () => clock.pending(),
}

;(window as unknown as { __parity: ParityProbe }).__parity = probe
