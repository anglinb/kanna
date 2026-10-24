import { Effect } from "effect"

// Browser storage in the formats the React client wrote, so a browser keeps
// its drafts, layouts and preferences across the switch. Reads happen once,
// in the app's Flags (before init); writes are Commands.

/** zustand's persist envelope: `{ state, version }` as JSON. */
interface PersistedEnvelope {
  state: unknown
  version?: number
}

/**
 * Reads a zustand-persisted store the way `persist` hydrates it: the stored
 * state when its version matches, `migrate(state, version)` when it doesn't,
 * null when there is nothing (or nothing readable). The caller shallow-merges
 * the result over its defaults, as zustand's default `merge` does.
 */
export function readPersistedStore<T>(
  name: string,
  version: number,
  migrate?: (state: unknown, fromVersion: number) => unknown,
  storage: Storage | undefined = globalThis.localStorage,
): Partial<T> | null {
  try {
    const raw = storage?.getItem(name)
    if (!raw) return null
    const envelope = JSON.parse(raw) as PersistedEnvelope
    if (typeof envelope.version === "number" && envelope.version !== version) {
      if (!migrate) return null
      return migrate(envelope.state, envelope.version) as Partial<T>
    }
    return envelope.state as Partial<T>
  } catch {
    return null
  }
}

/** Writes a store as zustand's persist does after every `set`. */
export function writePersistedStore(name: string, version: number, state: unknown, storage: Storage | undefined = globalThis.localStorage) {
  return Effect.sync(() => {
    try {
      storage?.setItem(name, JSON.stringify({ state, version }))
    } catch {
      // Quota or private mode: the React client lost the write the same way.
    }
  })
}

/** A raw `kanna:` key (src/client/lib/storageKeys.ts). */
export function readStorageItem(key: string, storage: Storage | undefined = globalThis.localStorage): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function writeStorageItem(key: string, value: string | null, storage: Storage | undefined = globalThis.localStorage) {
  return Effect.sync(() => {
    try {
      if (value === null) storage?.removeItem(key)
      else storage?.setItem(key, value)
    } catch {
      // As above.
    }
  })
}
