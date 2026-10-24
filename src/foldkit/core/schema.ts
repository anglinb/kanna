import { Schema } from "effect"

/**
 * A Schema for data whose shape is already a TypeScript type elsewhere:
 * server snapshots (src/shared/types.ts, src/shared/protocol.ts) and the
 * React-free helpers' results. The Model must be a Schema, but rewriting
 * every snapshot interface as one would fork the wire contract. This checks
 * nothing at runtime; the server is the source of the data, and the type
 * comes from the interface.
 *
 *   chatSnapshot: Schema.NullOr(opaque<ChatSnapshot>("ChatSnapshot"))
 */
export function opaque<T>(identifier: string) {
  return Schema.declare((_u: unknown): _u is T => true, { identifier })
}
