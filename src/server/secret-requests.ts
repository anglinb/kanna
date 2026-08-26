/**
 * The in-flight half of ask-for-secret: an agent's `kanna ask-secret` call
 * parks here until someone answers it in the UI.
 *
 * The CLI polls by id rather than holding an open request, so a user who
 * wanders off for ten minutes costs nothing and no socket times out. Resolved
 * entries linger briefly so a poll that arrives just after the answer still
 * sees it, then are swept.
 *
 * The secret value itself only ever exists here in the argument to `submit()`
 * on its way to disk — it is never stored on the request, never snapshotted,
 * and never returned to the CLI.
 */

import { randomUUID } from "node:crypto"
import type {
  PendingSecretRequest,
  SecretRequestResolution,
  SecretScope,
} from "../shared/secrets"
import { SECRET_REASON_MAX_LENGTH } from "../shared/secrets"
import { writeSecret as writeSecretToDisk } from "./secrets"

/** How long a prompt waits for the user before it gives up. */
export const SECRET_REQUEST_TTL_MS = 15 * 60 * 1000
/** How long a settled result stays readable by the polling CLI. */
export const SECRET_RESOLUTION_RETENTION_MS = 5 * 60 * 1000

interface TrackedRequest {
  request: PendingSecretRequest
  resolution: SecretRequestResolution
  /** When a settled request becomes eligible for sweeping. */
  settledAt: number | null
}

export interface CreateSecretRequestArgs {
  name: string
  reason: string
  cwd: string
  projectPath: string | null
  projectTitle: string | null
  suggestedScope: SecretScope | null
}

export interface SecretRequestStoreOptions {
  writeSecret?: typeof writeSecretToDisk
  now?: () => number
}

export class SecretRequestStore {
  private readonly requests = new Map<string, TrackedRequest>()
  private readonly listeners = new Set<() => void>()
  private readonly writeSecret: typeof writeSecretToDisk
  private readonly now: () => number

  constructor(options: SecretRequestStoreOptions = {}) {
    this.writeSecret = options.writeSecret ?? writeSecretToDisk
    this.now = options.now ?? (() => Date.now())
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }

  create(args: CreateSecretRequestArgs): PendingSecretRequest {
    this.sweep()

    // Re-running `ask-secret` is expected: the CLI gives up waiting long
    // before a distracted user answers, and an agent's natural response is to
    // run it again. Reuse the open prompt instead of stacking duplicates.
    const open = [...this.requests.values()].find((tracked) => (
      tracked.resolution.status === "pending"
      && tracked.request.name === args.name
      && tracked.request.cwd === args.cwd
    ))
    if (open) return open.request

    const request: PendingSecretRequest = {
      id: randomUUID(),
      name: args.name,
      reason: args.reason.slice(0, SECRET_REASON_MAX_LENGTH),
      cwd: args.cwd,
      projectPath: args.projectPath,
      projectTitle: args.projectTitle,
      suggestedScope: args.suggestedScope,
      createdAt: this.now(),
    }

    this.requests.set(request.id, {
      request,
      resolution: { status: "pending" },
      settledAt: null,
    })
    this.emit()
    return request
  }

  /** Pending requests only — this is what the UI renders. */
  list(): PendingSecretRequest[] {
    this.sweep()
    return [...this.requests.values()]
      .filter((tracked) => tracked.resolution.status === "pending")
      .map((tracked) => tracked.request)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): PendingSecretRequest | null {
    return this.requests.get(id)?.request ?? null
  }

  /** What the polling CLI reads. Unknown ids read as expired, not pending. */
  resolutionFor(id: string): SecretRequestResolution {
    this.sweep()
    return this.requests.get(id)?.resolution ?? { status: "expired" }
  }

  /**
   * Write the user's answer to disk and settle the request. The value is
   * consumed here and deliberately not retained.
   */
  async submit(
    id: string,
    input: { scope: SecretScope; value: string },
  ): Promise<SecretRequestResolution> {
    const tracked = this.requests.get(id)
    if (!tracked) {
      throw new Error("That secret request is no longer open")
    }
    if (tracked.resolution.status !== "pending") {
      throw new Error("That secret request has already been answered")
    }
    if (input.scope === "project" && !tracked.request.projectPath) {
      throw new Error("This request did not come from a project, so it can only be saved globally")
    }

    const written = await this.writeSecret({
      scope: input.scope,
      name: tracked.request.name,
      value: input.value,
      projectPath: tracked.request.projectPath,
    })

    tracked.resolution = {
      status: "saved",
      path: written.path,
      scope: written.scope,
      loadCommand: written.loadCommand,
      gitignoreUpdated: written.gitignoreUpdated,
    }
    tracked.settledAt = this.now()
    this.emit()
    return tracked.resolution
  }

  cancel(id: string): boolean {
    const tracked = this.requests.get(id)
    if (!tracked || tracked.resolution.status !== "pending") return false

    tracked.resolution = { status: "cancelled" }
    tracked.settledAt = this.now()
    this.emit()
    return true
  }

  /** Expire stale prompts and drop settled ones the CLI has had time to read. */
  sweep(): void {
    const now = this.now()
    let changed = false

    for (const [id, tracked] of this.requests) {
      if (tracked.resolution.status === "pending") {
        if (now - tracked.request.createdAt >= SECRET_REQUEST_TTL_MS) {
          tracked.resolution = { status: "expired" }
          tracked.settledAt = now
          changed = true
        }
        continue
      }
      if (tracked.settledAt !== null && now - tracked.settledAt >= SECRET_RESOLUTION_RETENTION_MS) {
        this.requests.delete(id)
      }
    }

    if (changed) this.emit()
  }

  dispose(): void {
    this.requests.clear()
    this.listeners.clear()
  }
}
