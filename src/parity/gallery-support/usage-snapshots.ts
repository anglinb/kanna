import type { ProviderUsageSnapshot } from "../../shared/types"

// Shared by the React and Foldkit usage card galleries, against the parity
// clock (2026-06-01T12:00Z): resets and "Updated" stamps read relative to it.

export const USAGE_SNAPSHOTS: ProviderUsageSnapshot[] = [
  {
    provider: "claude",
    status: "ok",
    plan: "max",
    windows: [
      { id: "five-hour", label: "5-hour", usedPercent: 42, resetsAt: "2026-06-01T14:30:00.000Z" },
      { id: "weekly", label: "Weekly", usedPercent: 81, resetsAt: "2026-06-04T09:00:00.000Z" },
    ],
    credits: null,
    detail: null,
    updatedAt: "2026-06-01T11:55:00.000Z",
  },
  {
    provider: "codex",
    status: "ok",
    plan: "business",
    windows: [
      { id: "primary", label: "Primary", usedPercent: 0.4, resetsAt: "2026-06-01T12:20:00.000Z" },
    ],
    credits: { label: "Credits", usedAmount: 130.42, limitAmount: 2000, usedPercent: null, currency: "USD", detail: null },
    detail: "Resets weekly on Thursday",
    updatedAt: "2026-06-01T11:00:00.000Z",
  },
] as ProviderUsageSnapshot[]
