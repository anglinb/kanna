import { useEffect } from "react"
import { create } from "zustand"
import type { ServerCapabilities } from "../../shared/server-capabilities"
import { fetchServerCapabilities } from "../lib/server-capabilities"

export const useServerCapabilitiesStore = create<{ value: ServerCapabilities | null }>()(() => ({ value: null }))
let pending: Promise<ServerCapabilities> | null = null

/** One neutral bootstrap request precedes cloud discovery, pairing, and WS URL resolution. */
export function getServerCapabilities(fetchImpl?: typeof fetch): Promise<ServerCapabilities> {
  // Injected transports are independent (tests and embedders); don't share their answers.
  if (fetchImpl && fetchImpl !== globalThis.fetch) return fetchServerCapabilities(fetchImpl)
  pending ??= fetchServerCapabilities().then((value) => {
    useServerCapabilitiesStore.setState({ value })
    return value
  })
  return pending
}

export function useServerCapabilities() {
  const value = useServerCapabilitiesStore((state) => state.value)
  useEffect(() => { void getServerCapabilities() }, [])
  return value
}
