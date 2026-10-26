import type { ContextWindowSnapshot } from "../../client/lib/contextWindow"

// Shared by the React and Foldkit context meter galleries.
const updatedAt = "2026-06-01T11:59:00.000Z"

export const CONTEXT_METER_USAGES: ContextWindowSnapshot[] = [
  { usedTokens: 84_000, maxTokens: 200_000, remainingTokens: 116_000, usedPercentage: 42, remainingPercentage: 58, compactsAutomatically: true, updatedAt },
  { usedTokens: 9_400, maxTokens: 200_000, remainingTokens: 190_600, usedPercentage: 4.7, remainingPercentage: 95.3, compactsAutomatically: true, updatedAt },
  { usedTokens: 1_250_000, remainingTokens: null, usedPercentage: null, remainingPercentage: null, compactsAutomatically: false, updatedAt },
  { usedTokens: 212_000, maxTokens: 200_000, remainingTokens: 0, usedPercentage: 106, remainingPercentage: 0, compactsAutomatically: true, updatedAt },
] as ContextWindowSnapshot[]
